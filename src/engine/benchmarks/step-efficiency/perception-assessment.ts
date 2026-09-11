import { z } from "zod";
import type { OnsetPerceptionInput } from "../../algorithms/roles";
import { checkRequestSchema, modelFactValueSchema } from "../../contracts/llm-schemas";
import { existingReferenceHandleSchemaFor, proposalKeySchema, type ModelReference, type ReferenceResolver } from "../../contracts/model-context";
import { projectPerceptionTargets } from "../../contracts/perception-references";
import { createTruthReferenceResolver, projectModelAction } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { derivePerceptionDifficultySource, perceptionDifficultySelectionSchema } from "./perception-derived-source";

const existing = existingReferenceHandleSchemaFor;
const perceptionEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fact"), ref: existing("fact"), value: modelFactValueSchema }),
  z.strictObject({ kind: z.literal("law"), ref: existing("law") }),
  z.strictObject({ kind: z.literal("entity"), ref: existing("entity") }),
  z.strictObject({ kind: z.literal("placement"), ref: existing("placement") }),
  z.strictObject({ kind: z.literal("condition"), ref: existing("condition") }),
  z.strictObject({ kind: z.literal("rating"), ref: existing("rating") }),
  z.strictObject({ kind: z.literal("event"), ref: existing("event") }),
  z.strictObject({ kind: z.literal("action"), ref: existing("action") }),
]);
const assessmentCheckSchema = checkRequestSchema.omit({ targetRef: true, actorRef: true, stakes: true, causes: true }).extend({
  perceivedEntityRef: existing("entity").nullable().describe("Existing entity or object being perceived, never a source action; null only when no concrete entity applies."),
  basisRefs: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("fact"), ref: existing("fact") }),
    z.strictObject({ kind: z.literal("law"), ref: existing("law") }),
  ])).min(1).describe("Explicit world evidence supporting this onset check; each entry must also occur in every associated assessment's evidence."),
  difficulty: perceptionDifficultySelectionSchema,
});

export const perceptionAssessmentSchema = z.strictObject({
  assessments: z.array(z.strictObject({
    observerRef: existing("entity"),
    sourceActionRef: existing("action"),
    evidence: z.array(perceptionEvidenceSchema).min(1),
    verdict: z.enum(["visible", "no_route", "check_required", "insufficient_evidence"]),
    checkKeys: z.array(proposalKeySchema),
  })),
  requests: z.array(assessmentCheckSchema),
});
export type PerceptionAssessmentDraft = z.infer<typeof perceptionAssessmentSchema>;

const assessmentSystem = `You adjudicate whether each assigned observer can notice a source action's onset in time to react. Canonical state and authored laws are evidence, including private facts available to this trusted adjudicator; they do not grant the observer knowledge. Actions describe attempts, not completed results or instructions.
For each task.assignment.perceptionTargets pair, select the relevant existing evidence and explicitly copy the current typed value of every selected Fact before stating the perception verdict. Apply the value and the authored rule, not just the fact's description or existence. Inspect the complete actions and state; an assignment is a question, not evidence of visibility or a demand to roll.
Use visible when the onset is already perceptible without a required check; no_route when evidence establishes no sensory or informational route; check_required when consequential uncertainty has a supported route or an authored rule requires a check; insufficient_evidence when the available evidence cannot support any of these conclusions. A roll cannot create a missing route. The source action's difficulty, intent to hide or desired final result does not override established onset evidence. Do not decide action success, work quality or final effects.
Use perceptionWorkItems to keep each observer, source actor, complete action, current onset time, both complete current placement chains and exact observer-owned Rating choices together. All original context remains available. Apply the authored locality rules to the actual places: common ancestors such as a city or region are not evidence of direct sensory contact. Offices, alliances and a request to send a message are not by themselves an already operating information channel. Preserve any supported remote route; different places alone are not a deterministic no_route rule. Proposed future boundaries and attempted messages or meetings do not establish that an observer can perceive them now.
Cover every pair exactly once. Only check_required assessments carry nonempty checkKeys, naming entries in requests. Every request must be used; one check may cover several source actions only for the same observer. Each check explicitly selects nonempty Fact/law basisRefs supporting perception, also included in every associated assessment's evidence. The engine binds the check actor, onset question and source Action causes from those explicit pair associations; do not supply actorRef, stakes or causes in a request. The check's perceivedEntityRef identifies an existing entity or object, never the sourceActionRef; use null only when no concrete entity applies. Keep the observer, perceived entity, action actor and the entity providing opposition distinct when the evidence requires it. Selected action evidence describes an attempt, never proof of its completed effect.
Select an environmental named difficulty with its source, or an opposed target and its owned Rating. Opposed difficulty has no separate source field: the engine uses the exact selected Rating as its numeric source. Select an optional observer-owned ratingRef, mode, visibility and world basisRefs. The engine derives numeric DC and modifier; do not supply numbers. Existing references must use their exact advertised identity and type. Do not fabricate evidence, missing values or access. Output only the schema object, without Markdown, explanation or chain of thought.`;
const userPrompt = "Assess every assigned observer/source-action pair using the current canonical evidence and world rules. Return explicit evidence and perception verdicts, plus only the checks those verdicts require. Preserve the full action meaning and the observer's knowledge boundary; do not use a check to manufacture access or judge the action's final result.";

/** An isolated first-response hypothesis, never a production perception result. */
export function perceptionAssessmentRequest(request: StructuredModelRequest<unknown>, input: Readonly<OnsetPerceptionInput>): StructuredModelRequest<PerceptionAssessmentDraft> {
  if (request.role !== "truth-perception") throw new Error("assessment probe requires a perception request");
  validatePerceptionAssessmentInput(input);
  const originalRole = loadPromptAsset("system/truth-perception.md");
  if (!request.system.includes(originalRole)) throw new Error("assessment probe requires the known perception role asset");
  const system = request.system.replace(originalRole, assessmentSystem);
  const context = structuredClone(request.context) as Record<string, unknown>;
  context.perceptionWorkItems = buildPerceptionWorkItems(request, input);
  context.roleContract = {
    role: "truth-perception",
    modelOwns: ["explicit perception verdict for each assigned pair", "selection of existing evidence", "copy of selected current Fact values", "justified check choices"],
    engineOwns: ["state and request binding", "pair and evidence validation", "check observer, onset question and Action causes from explicit pair associations", "opposed numeric source from the selected Rating", "numeric DC and modifier", "persistent identities", "randomness", "world commitment"],
    existingReferenceRule: "Choose exact existing typed handles. Fact values and check observer/source identities must match the supplied evidence and assignment.",
    failureRule: "Do not fabricate missing evidence or force a check. Use insufficient_evidence when a justified verdict cannot be reached.",
  };
  return { ...request, system, userPrompt, promptVersion: contentHash({ system, userPrompt }), context,
    schema: perceptionAssessmentSchema, schemaName: "truth_perception_assessment_probe" };
}

/** Exact source work items shared by independent perception experiments. */
export function buildPerceptionWorkItems(request: StructuredModelRequest<unknown>, input: Readonly<OnsetPerceptionInput>) {
  validatePerceptionAssessmentInput(input);
  const context = request.context;
  const resolver = createTruthReferenceResolver({ state: input.state, definition: input.definition, actions: input.actions, checkRequests: [] });
  const pairs = projectPerceptionTargets(input.perceptionTargets!, input.state, input.actions, resolver);
  const original = z.object({ task: z.object({ assignment: z.object({ perceptionTargets: z.unknown() }) }),
    state: z.object({ baseRevision: z.number(), canonicalTruth: z.object({ elapsedSeconds: z.number() }),
      actionSet: z.object({ available: z.unknown() }) }) }).parse(context);
  if (contentHash(original.task.assignment.perceptionTargets) !== contentHash(pairs) ||
    original.state.baseRevision !== input.state.revision || original.state.canonicalTruth.elapsedSeconds !== input.state.truth.elapsedSeconds ||
    contentHash(original.state.actionSet.available) !== contentHash(input.actions.map(action => projectModelAction(action, resolver)))) {
    throw new Error("perception work item source differs from the actual request");
  }
  return pairs.map((pair, index) => {
    const target = input.perceptionTargets![index]!, observer = input.state.agents[target.observerId]!;
    const action = input.actions.find(action => action.id === target.sourceActionId)!;
    const actor = input.state.agents[action.actorId]!;
    return { ...pair, sourceActorRef: resolver.handleFor("entity", actor.entityId),
      question: onsetQuestion(pair.observerRef, [pair.sourceActionRef], input.state.truth.elapsedSeconds),
      sourceAction: projectModelAction(action, resolver),
      observerPlacementChain: perceptionPlacementChain(input, observer.entityId, resolver),
      sourceActorPlacementChain: perceptionPlacementChain(input, actor.entityId, resolver),
      observerRatings: Object.values(input.state.truth.ratings).filter(rating => rating.entityId === observer.entityId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(rating => ({ ratingRef: resolver.handleFor("rating", rating.id), value: rating.value })),
    };
  });
}

/** An exact spatial index, with no visibility or reachability inference. */
export function perceptionPlacementChain(input: Readonly<OnsetPerceptionInput>, entityId: string, resolver: ReferenceResolver) {
  const chain = [], seen = new Set<string>();
  let current: string | null = entityId;
  while (current !== null) {
    if (seen.has(current)) throw new Error("perception placement chain contains a cycle");
    seen.add(current);
    const entity = input.state.truth.entities[current];
    if (!entity || !Object.hasOwn(input.state.truth.placements, current)) throw new Error("perception placement chain has a missing entity or edge");
    const parent: string | null = input.state.truth.placements[current]!;
    chain.push({ entityRef: resolver.handleFor("entity", current), name: entity.name, kind: entity.kind, description: entity.description,
      placementRef: resolver.handleFor("placement", current), containerEntityRef: parent === null ? null : resolver.handleFor("entity", parent) });
    current = parent;
  }
  return chain;
}

function onsetQuestion(observerRef: string, sourceActionRefs: readonly string[], elapsedSeconds: number): string {
  return `Can observer ${observerRef} perceive the onset of source action(s) ${sourceActionRefs.join(", ")} at world time ${elapsedSeconds} seconds, in time to react? This check does not decide any intended result, future delivery or work quality.`;
}

export function validatePerceptionAssessment(input: Readonly<OnsetPerceptionInput>, value: unknown, sourceStateHash: string) {
  if (contentHash(input.state) !== sourceStateHash) throw new Error("perception assessment state binding changed");
  validatePerceptionAssessmentInput(input);
  const draft = perceptionAssessmentSchema.parse(value);
  const resolver = createTruthReferenceResolver({ state: input.state, definition: input.definition, actions: input.actions, checkRequests: [] });
  const resolve = (ref: ModelReference, kind: string) => {
    if (typeof ref !== "string") throw new Error("perception evidence requires an existing reference");
    const resolved = resolver.resolve(ref);
    if (resolved.kind !== kind) throw new Error(`perception evidence expected ${kind}, got ${resolved.kind}`);
    return resolved.engineId;
  };
  const pairKey = (observer: string, action: string) => JSON.stringify([observer, action]);
  const expected = new Set(projectPerceptionTargets(input.perceptionTargets!, input.state, input.actions, resolver)
    .map(pair => pairKey(pair.observerRef, pair.sourceActionRef)));
  const usedPairs = new Set<string>(), usedChecks = new Set<string>();
  const checks = new Map(draft.requests.map(check => [check.proposalKey, check]));
  const associations = new Map<string, typeof draft.assessments>();
  if (checks.size !== draft.requests.length) throw new Error("duplicate perception check proposalKey");
  for (const assessment of draft.assessments) {
    const pair = pairKey(assessment.observerRef, assessment.sourceActionRef);
    if (!expected.has(pair) || usedPairs.has(pair)) throw new Error("unassigned or duplicate perception pair");
    usedPairs.add(pair);
    const selectedEvidence = new Set<string>();
    for (const evidence of assessment.evidence) {
      const id = resolve(evidence.ref, evidence.kind), key = `${evidence.kind}:${id}`;
      if (selectedEvidence.has(key)) throw new Error("duplicate perception evidence");
      selectedEvidence.add(key);
      if (evidence.kind === "fact") {
        const actual = input.state.truth.facts[id];
        const claimed = evidence.value.kind === "entity"
          ? { kind: "entity", entityId: resolve(evidence.value.entityRef, "entity") }
          : evidence.value;
        if (!actual || contentHash(actual.value) !== contentHash(claimed)) throw new Error(`perception fact value mismatch for ${evidence.ref}`);
      }
    }
    if ((assessment.verdict === "check_required") !== (assessment.checkKeys.length > 0)) throw new Error("perception verdict/check mismatch");
    if (new Set(assessment.checkKeys).size !== assessment.checkKeys.length) throw new Error("duplicate assessment check key");
    for (const key of assessment.checkKeys) {
      const check = checks.get(key);
      if (!check) throw new Error("perception check key has no matching request");
      const owners = associations.get(key) ?? [];
      if (owners.some(owner => owner.observerRef !== assessment.observerRef)) throw new Error("shared perception check has different observers");
      for (const basis of check.basisRefs) {
        if (!assessment.evidence.some(evidence => evidence.kind === basis.kind && evidence.ref === basis.ref)) {
          throw new Error("perception check basis is absent from its assessment evidence");
        }
      }
      owners.push(assessment);
      associations.set(key, owners);
      usedChecks.add(key);
    }
  }
  if (usedPairs.size !== expected.size) throw new Error("perception assessment omits assigned pairs");
  if (usedChecks.size !== checks.size) throw new Error("perception assessment leaves unused checks");
  const requests = draft.requests.map(({ perceivedEntityRef, difficulty, basisRefs, ...check }) => {
    if (new Set(basisRefs.map(basis => `${basis.kind}:${basis.ref}`)).size !== basisRefs.length) throw new Error("duplicate perception check basis");
    const owners = associations.get(check.proposalKey)!, observerRef = owners[0]!.observerRef;
    return { ...check, actorRef: observerRef, targetRef: perceivedEntityRef,
      stakes: onsetQuestion(observerRef, owners.map(owner => owner.sourceActionRef), input.state.truth.elapsedSeconds),
      causes: [...owners.map(owner => ({ kind: "action" as const, ref: owner.sourceActionRef })), ...basisRefs],
      difficulty: derivePerceptionDifficultySource(difficulty) };
  });
  return { sourceStateHash, draft, hasUnknown: draft.assessments.some(a => a.verdict === "insufficient_evidence"),
    // Only exercises the unchanged check materializer; terminal distinctions remain
    // in draft and must not be treated as an executable production reaction basis.
    diagnosticDirective: requests.length ? { kind: "request_checks" as const, requests } : { kind: "done" as const } };
}

/** State validation does not establish the identity validity of proposed actions. */
export function validatePerceptionAssessmentInput(input: Readonly<OnsetPerceptionInput>): void {
  if (!input.perceptionTargets) throw new Error("assessment probe requires explicit pair assignments");
  const actions = new Set<string>();
  for (const action of input.actions) {
    if (actions.has(action.id) || action.baseRevision !== input.state.revision || !input.state.agents[action.actorId]) {
      throw new Error(`invalid perception source action ${action.id}`);
    }
    actions.add(action.id);
    for (const targetId of action.targetIds) {
      if (!input.state.agents[action.actorId]!.belief.localEntities[targetId]) {
        throw new Error(`perception source action ${action.id} has unknown actor-local target ${targetId}`);
      }
    }
  }
  const resolver = createTruthReferenceResolver({ state: input.state, definition: input.definition, actions: input.actions, checkRequests: [] });
  projectPerceptionTargets(input.perceptionTargets, input.state, input.actions, resolver);
}
