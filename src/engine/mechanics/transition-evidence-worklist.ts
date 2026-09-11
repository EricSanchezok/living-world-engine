import { z } from "zod";
import { transitionProposalSchema } from "../contracts/llm-schemas";
import { compactTransitionAssertionSchema } from "./transition-schema-references";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest, type StructuredModelProvider } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { PHYSICAL_BATCH_REPAIR_NOTICE } from "../prompts/repair-layout";
import { SourceIndexedTransitionCodec } from "./source-indexed-transition";
import { expandSharedBatchContexts, type SharedBatchContext } from "./shared-batch-context";
import { compactSharedCatalogRecords, expandSharedCatalogRecords } from "./shared-catalog-records";
import { compactSharedCatalogPrefix, expandSharedCatalogPrefix } from "./shared-catalog-prefix";
import { decodeTransitionIntervalAssessments, transitionIntervalWireSchema, transitionSourceTextSegments } from "./transition-interval-assessment";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason: string): never => { throw new ModelConfigurationError(`transition worklist: ${reason}`); };
export const TRANSITION_EVIDENCE_WORKLIST = "transition-evidence-worklist-v8";
const instruction = loadPromptAsset("shared/transition-evidence-worklist.md");
// Authored demonstrations and their research provenance are specified in docs/specs/0058-transition-interval-demonstrations.md.
const intervalInstruction = loadPromptAsset("shared/transition-current-interval.md");

export const CANONICAL_TRANSITION_EVIDENCE = "canonical-transition-evidence-v1";
const canonicalInstruction = loadPromptAsset("shared/canonical-transition-evidence.md");

function transitionEvidenceRows(rows: Array<{ slot: number; action: ObjectValue; actionIndex?: number }>, contexts: readonly ObjectValue[]) {
  return rows.map(row => {
    const state = contexts[row.slot]!.state as ObjectValue;
    if (!Array.isArray(state.committedResolutionPlans) || !Array.isArray(state.resolutionReceipts) || !object(state.temporalExecution) ||
      !object(state.temporalExecution.activities) || !object(state.canonicalTruth) || !object(state.canonicalTruth.facts) ||
      !object(state.canonicalTruth.entities) || !object(state.canonicalTruth.placements)) return fail("complete transition evidence is missing");
    const committedPlans = state.committedResolutionPlans.filter(plan => object(plan) && plan.actionRef === row.action.actionRef);
    const receipts = state.resolutionReceipts.filter(receipt => object(receipt) && object(receipt.plan) && receipt.plan.actionRef === row.action.actionRef);
    const activities = Object.fromEntries(Object.entries(state.temporalExecution.activities).filter(([, activity]) => object(activity) && activity.sourceActionRef === row.action.actionRef));
    if (!committedPlans.length || !receipts.length) return fail("assigned action has no committed adjudication evidence");
    const refs = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (object(value)) {
        if (value.kind === "fact" && typeof value.ref === "string") refs.add(value.ref);
        if (typeof value.factRef === "string") refs.add(value.factRef);
        Object.values(value).forEach(visit);
      }
    };
    visit({ committedPlans, receipts, activities });
    const facts = state.canonicalTruth.facts;
    const participantRefs = new Set<string>();
    for (const plan of committedPlans) {
      if (!object(plan) || typeof plan.actorRef !== "string" || !Array.isArray(plan.targetRefs) || plan.targetRefs.some(ref => typeof ref !== "string")) return fail("canonical participant binding missing");
      participantRefs.add(plan.actorRef);
      for (const ref of plan.targetRefs as string[]) participantRefs.add(ref);
    }
    const entities = state.canonicalTruth.entities, placements = state.canonicalTruth.placements;
    const participantEntities: ObjectValue = {}, placementAncestors: ObjectValue = {};
    for (const ref of participantRefs) {
      const entity = entities[ref];
      if (!object(entity) || !(entity.placementRef === null || typeof entity.placementRef === "string")) return fail("participant entity missing from source");
      participantEntities[ref] = entity;
      let placement = entity.placementRef;
      const visited = new Set<string>();
      while (typeof placement === "string" && Object.hasOwn(placements, placement)) {
        if (visited.has(placement)) return fail("cyclic participant placement");
        visited.add(placement);
        const parent = placements[placement];
        if (!(parent === null || typeof parent === "string")) return fail("invalid participant placement edge");
        placementAncestors[placement] = parent;
        placement = parent;
      }
    }
    for (const [ref, fact] of Object.entries(facts)) {
      if (object(fact) && typeof fact.subjectRef === "string" && participantRefs.has(fact.subjectRef)) refs.add(ref);
    }
    const inputFacts = Object.fromEntries([...refs].map(ref => {
      if (!Object.hasOwn(facts, ref)) return fail("cited fact missing from the original visible state");
      return [ref, facts[ref]];
    }));
    if (typeof row.action.rawText !== "string") return fail("original action text missing");
    return structuredClone({ ...row, sourceTextSegments: transitionSourceTextSegments(row.action.rawText), committedPlans, receipts, activities, temporalBoundary: state.temporalExecution.boundary,
      participantEntities, placementAncestors, inputFacts });
  });
}

export function canonicalTransitionEvidenceRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-transition" || request.schemaName !== "truth_transition") return request;
  const source = request.context;
  if (request.wireJsonSchema || !object(source) || !object(source.task) || Object.hasOwn(source.task, "transitionWorklist") ||
    !object(source.state) || !object(source.state.actionSet) || !Array.isArray(source.state.actionSet.assigned) ||
    contentHash(z.toJSONSchema(request.schema, { target: "draft-07" })) !== contentHash(z.toJSONSchema(transitionProposalSchema, { target: "draft-07" }))) return fail("canonical source or output contract drift");
  const actions = source.state.actionSet.assigned;
  if (actions.some(action => !object(action) || typeof action.actionRef !== "string") || new Set(actions.map(action => action.actionRef)).size !== actions.length) return fail("canonical action ownership is invalid");
  const rows = transitionEvidenceRows(actions.map(action => ({ slot: 0, action })), [source]).map(row => {
    const copy: ObjectValue = { ...row }; delete copy.slot; return copy;
  });
  const context = structuredClone(source), task = context.task as ObjectValue;
  task.transitionWorklist = { contract: CANONICAL_TRANSITION_EVIDENCE, sourceContextHash: contentHash(source), actionCount: actions.length, actions: rows };
  const schema = compactTransitionAssertionSchema(z.toJSONSchema(request.schema, { target: "draft-07" }));
  const outcomes = (schema.properties as ObjectValue).outcomes as ObjectValue;
  outcomes.minItems = actions.length; outcomes.maxItems = actions.length;
  if (actions.length) {
    const properties = (outcomes.items as ObjectValue).properties as ObjectValue;
    properties.actionRef = { ...properties.actionRef as ObjectValue, enum: actions.map(action => action.actionRef) };
  }
  const userPrompt = `${request.userPrompt}\n\n${canonicalInstruction}`;
  return { ...request, context, wireJsonSchema: schema, jsonExamplePolicy: "omit", userPrompt,
    promptVersion: `${request.promptVersion}/${CANONICAL_TRANSITION_EVIDENCE}@${contentHash({ canonicalInstruction, schema }).slice(0, 16)}` };
}

export function transitionWorklistContext(indexed: unknown): ObjectValue {
  if (!object(indexed) || !object(indexed.task) || !object(indexed.task.transitionWorklist) || Object.hasOwn(indexed, "physicalEnvelopeAudit")) return fail("missing or repeated indexed source");
  const original = structuredClone(indexed); delete (original.task as ObjectValue).transitionWorklist;
  const codec = new SourceIndexedTransitionCodec(original);
  if (contentHash(codec.context(original)) !== contentHash(indexed)) return fail("indexed source or binding changed");
  const contexts = expandSharedBatchContexts(original.state as SharedBatchContext);
  const rows = transitionEvidenceRows(codec.actions, contexts);
  const context = structuredClone(indexed), task = context.task as ObjectValue, assignment = task.assignment, catalog = context.referenceCatalog;
  if (!object(assignment) || Object.keys(assignment).sort().join(",") !== "allowedProposalKinds,availableHandles,targetHandles" ||
    Object.values(assignment).some(value => !Array.isArray(value) || value.length) ||
    !object(catalog) || !Array.isArray(catalog.candidates) || catalog.candidates.length ||
    Object.keys(catalog).sort().join(",") !== "candidates,hash,version") return fail("physical placeholders are not the expected empty metadata");
  context.physicalEnvelopeAudit = { contract: TRANSITION_EVIDENCE_WORKLIST, assignment, referenceCatalog: catalog };
  delete task.assignment; delete context.referenceCatalog;
  task.transitionWorklist = { ...(task.transitionWorklist as ObjectValue), evidenceContract: TRANSITION_EVIDENCE_WORKLIST, actions: rows };
  context.state = compactSharedCatalogRecords(compactSharedCatalogPrefix(context.state));
  return context;
}

export function restoreTransitionWorklistContext(value: unknown): ObjectValue {
  if (!object(value) || !object(value.task) || !object(value.task.transitionWorklist) || !object(value.physicalEnvelopeAudit) ||
    value.physicalEnvelopeAudit.contract !== TRANSITION_EVIDENCE_WORKLIST || Object.hasOwn(value, "referenceCatalog") || Object.hasOwn(value.task, "assignment")) return fail("invalid worklist envelope");
  const restored = structuredClone(value), task = restored.task as ObjectValue, audit = restored.physicalEnvelopeAudit as ObjectValue;
  task.assignment = audit.assignment; restored.referenceCatalog = audit.referenceCatalog;
  delete task.transitionWorklist; delete restored.physicalEnvelopeAudit;
  restored.state = expandSharedCatalogPrefix(expandSharedCatalogRecords(restored.state));
  const codec = new SourceIndexedTransitionCodec(restored), indexed = codec.context(restored);
  if (contentHash(transitionWorklistContext(indexed)) !== contentHash(value)) return fail("source evidence or layout changed");
  return indexed;
}

export function transitionEvidenceWorklistRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role === "truth-transition" && request.schemaName === "truth_transition") return canonicalTransitionEvidenceRequest(request);
  if (request.role !== "truth-transition" || request.schemaName !== "truth_transition_batch") return request;
  const context = transitionWorklistContext(request.context);
  const replacements = [
    ["`state.actionSet.assigned`", "`task.transitionWorklist.actions`"],
    ["`state.committedResolutionPlans` and `state.resolutionReceipts`", "each indexed action's `committedPlans` and `receipts`"],
  ];
  let userPrompt = request.userPrompt;
  for (const [source, target] of replacements) {
    if (userPrompt.split(source!).length !== 2) return fail("physical task path drift");
    userPrompt = userPrompt.replace(source!, target!);
  }
  const repairSuffix = "\n\n" + PHYSICAL_BATCH_REPAIR_NOTICE;
  const withEvidence = userPrompt.endsWith(repairSuffix)
    ? userPrompt.slice(0, -repairSuffix.length) + "\n\n" + instruction + repairSuffix
    : userPrompt + "\n\n" + instruction;
  return { ...request, context, userPrompt: withEvidence,
    promptVersion: `${request.promptVersion}/${TRANSITION_EVIDENCE_WORKLIST}@${contentHash({ context, instruction, userPrompt }).slice(0, 16)}` };
}

/** The research-only assessment interface is never selected by the gameplay provider. */
export function transitionIntervalWorklistRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-transition" || request.schemaName !== "truth_transition_batch") return request;
  const adapted = transitionEvidenceWorklistRequest(request);
  const originalSummary = "Keep proposalKey, status, summary and causes explicit.";
  if (adapted.userPrompt.split(originalSummary).length !== 2) return fail("indexed summary instruction drift");
  const userPrompt = adapted.userPrompt.replace(originalSummary, "Keep proposalKey, status and causes explicit. The following interval contract replaces the wire summary.");
  const slotContexts = expandSharedBatchContexts((request.context as { state: SharedBatchContext }).state);
  const sources = (((adapted.context as ObjectValue).task as ObjectValue).transitionWorklist as { actions: ObjectValue[] }).actions
    .map(row => ({ ...row, slotContext: slotContexts[row.slot as number] }));
  if (!request.preprocessOutput) return fail("indexed decoder missing");
  const repairSuffix = "\n\n" + PHYSICAL_BATCH_REPAIR_NOTICE;
  const userWithInterval = userPrompt.endsWith(repairSuffix)
    ? userPrompt.slice(0, -repairSuffix.length) + "\n\n" + intervalInstruction + repairSuffix
    : userPrompt + "\n\n" + intervalInstruction;
  return { ...adapted, userPrompt: userWithInterval, wireJsonSchema: transitionIntervalWireSchema(request.wireJsonSchema),
    preprocessOutput: raw => request.preprocessOutput!(decodeTransitionIntervalAssessments(raw, sources)),
    promptVersion: `${adapted.promptVersion}/research-interval@${contentHash({ intervalInstruction, userPrompt }).slice(0, 16)}` };
}

export function transitionIntervalWorklistProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { ...transitionEvidenceWorklistProvider(inner),
    generateStructured: request => inner.generateStructured(transitionIntervalWorklistRequest(request)),
  };
}

export function transitionEvidenceWorklistProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(transitionEvidenceWorklistRequest(request)),
  };
}
