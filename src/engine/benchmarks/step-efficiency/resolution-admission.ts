import { z } from "zod";
import type { TruthResolutionInput } from "../../algorithms/roles";
import type { AgentActionProposal } from "../../contracts/model";
import { createTruthReferenceResolver, projectCanonicalTruthForModel } from "../../contracts/prompts";
import { modelReferenceSchema } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type ModelExecutionScope, type StructuredModelProvider, type StructuredModelRequest } from "../../models/model-provider";
import { dependentFieldsProvider } from "../../mechanics/resolution-dependent-fields-codec";
import { SHARED_BATCH_CONTEXT_CODEC, type SharedBatchContext } from "../../mechanics/shared-batch-context";
import { withTruthRequestPolicy } from "../../mechanics/truth-request-policy";
import { TRUTH_BATCH_REQUEST_CONTRACT, TruthBatchCoordinator } from "../../mechanics/truth-batch-provider";
import { TruthEngine } from "../../mechanics/truth-engine";

const contextSchema = z.object({ execution: z.object({ instanceId: z.string(), advanceId: z.string() }), state: z.object({
  canonicalTruth: z.unknown(), actionSet: z.object({ assigned: z.array(z.object({ actionRef: modelReferenceSchema,
    rawText: z.string(), goal: z.string(), means: z.string().nullable(), allowedMeansSources: z.array(z.unknown()).optional() })).min(1) }),
  temporalBoundary: z.object({ fromElapsedSeconds: z.number(), toElapsedSeconds: z.number(), deltaSeconds: z.number(),
    reasons: z.array(z.unknown()), dueActivityIds: z.array(z.string()), dueTimerIds: z.array(z.string()), dueConditionIds: z.array(z.string()) }),
}) });

export interface ResolutionAdmissionSource {
  definition: TruthResolutionInput["definition"];
  state: TruthResolutionInput["state"];
  actions: AgentActionProposal[];
  groundings: TruthResolutionInput["groundings"];
  contexts: readonly unknown[];
}

/** Bind each original logical slot to the actual complete canonical snapshot. */
export function bindResolutionAdmission(source: ResolutionAdmissionSource) {
  if (source.groundings.some(grounding => grounding.kind !== "action")) throw new Error("admission source requires the original action-only dependency scope");
  const resolver = createTruthReferenceResolver({ state: source.state, definition: source.definition, actions: source.actions });
  const projectionHash = contentHash(projectCanonicalTruthForModel(source.state.truth, resolver));
  const contexts = source.contexts.map(context => contextSchema.parse(context));
  const inventories = contexts.flatMap(context => context.state.actionSet.assigned.map(action => action.allowedMeansSources !== undefined));
  if (inventories.some(value => value !== inventories[0])) throw new Error("admission source inventory policy is inconsistent");
  const used = new Set<string>();
  return contexts.map((context, slot) => {
    if (contentHash(context.state.canonicalTruth) !== projectionHash) throw new Error("admission canonical snapshot mismatch");
    if (contentHash(context.execution) !== contentHash(contexts[0]!.execution) ||
      contentHash(context.state.temporalBoundary) !== contentHash(contexts[0]!.state.temporalBoundary)) throw new Error("admission execution or temporal boundary mismatch");
    const actions = context.state.actionSet.assigned.map(record => {
      if (typeof record.actionRef !== "string") throw new Error("admission requires existing action references");
      const resolved = resolver.resolve(record.actionRef, "source");
      const action = source.actions.find(value => value.id === resolved.engineId);
      if (resolved.kind !== "action" || !action || used.has(action.id) || action.rawText !== record.rawText ||
        action.goal !== record.goal || action.means !== record.means) throw new Error("admission action identity or meaning mismatch");
      used.add(action.id);
      return structuredClone(action);
    });
    const selected = new Set(actions.map(action => action.id));
    const groundings = source.groundings.filter(grounding => selected.has(grounding.id));
    if (actions.some(action => !groundings.some(grounding => grounding.kind === "action" && grounding.id === action.id))) throw new Error("admission action grounding missing");
    return { slot, includeResolutionMeansSources: inventories[0] ?? false,
      identityOwner: `component-${[...new Set(actions.map(action => action.actorId))].sort().join("+")}`,
      contextHash: contentHash(source.contexts[slot]), actions, groundings, execution: context.execution,
      temporalBoundary: context.state.temporalBoundary as TruthResolutionInput["temporalBoundary"] };
  });
}

class AdmissionStageStopped extends ModelConfigurationError {}

/** Run the real batch/repair/materialization path, stopping before semantic
 * verification and RNG. Admission is neither a semantic verdict nor a step. */
export async function runResolutionAdmission(source: ResolutionAdmissionSource, provider: StructuredModelProvider, options: {
  candidate: boolean;
  includeActivityTemporalEvidence?: boolean;
  maxPhysicalRequests: number;
  contextCodec?: SharedBatchContext["codec"];
  jsonSyntaxRecovery?: StructuredModelRequest<unknown>["jsonSyntaxRecovery"];
  contextLayout?: StructuredModelRequest<unknown>["contextLayout"];
  scope?: Partial<ModelExecutionScope>;
  onPhysicalRequest?: (request: StructuredModelRequest<unknown>) => void;
  onVerifierRequest?: (request: StructuredModelRequest<unknown>, slot: number) => void;
}) {
  if (!Number.isSafeInteger(options.maxPhysicalRequests) || options.maxPhysicalRequests < 1) throw new Error("admission requires a positive physical request ceiling");
  const bindings = bindResolutionAdmission(source);
  if (!bindings.length || bindings.length > 12) throw new Error("admission retains one root batch of at most twelve original slots");
  const beforeHash = contentHash(source);
  const admitted = new Map<number, unknown>();
  const physicalOrdinals = new Map<string, number>();
  const acceptedFrom = new Map<number, number>();
  const logicalAttempts = new Map<number, number>();
  const repairEvidence = new Map<number, Array<{ logicalAttempt: number; issues: unknown }>>();
  const physicalFailures: Array<{ physicalRequest: number; schemaName: string; message: string; cause: string | null; issues: unknown[] }> = [];
  const subjects = new Map(bindings.map(binding => [binding.identityOwner, binding.slot]));
  if (subjects.size !== bindings.length) throw new Error("admission component identity is ambiguous");
  let physicalRequests = 0;
  const bounded: StructuredModelProvider = {
    catalog: provider.catalog,
    availableProfileSummaries: role => provider.availableProfileSummaries(role),
    assertProfilesAvailable: ids => provider.assertProfilesAvailable(ids),
    generateStructured: async request => {
      if (physicalRequests >= options.maxPhysicalRequests) throw new ModelConfigurationError("admission physical request ceiling reached");
      const ordinal = ++physicalRequests;
      options.onPhysicalRequest?.(request);
      try {
        const result = await provider.generateStructured(request);
        result.audit.invocations.forEach(invocation => physicalOrdinals.set(invocation.id, ordinal));
        return result;
      } catch (error) {
        if (error instanceof ModelOutputError) error.audit?.invocations.forEach(invocation => physicalOrdinals.set(invocation.id, ordinal));
        physicalFailures.push({ physicalRequest: ordinal, schemaName: request.schemaName,
          message: String(error), cause: error instanceof Error && error.cause !== undefined ? String(error.cause) : null,
          issues: error instanceof ModelOutputError ? structuredClone(error.audit?.invocations.flatMap(invocation => invocation.issues ?? []) ?? []) : [] });
        throw error;
      }
    },
  };
  const represented = options.candidate ? dependentFieldsProvider(bounded) : bounded;
  const physical = withTruthRequestPolicy(represented, options);
  const coordinator = new TruthBatchCoordinator(physical,
    12, 2, options.contextCodec ?? SHARED_BATCH_CONTEXT_CODEC, TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const logical: StructuredModelProvider = {
    catalog: provider.catalog,
    availableProfileSummaries: role => provider.availableProfileSummaries(role),
    assertProfilesAvailable: ids => provider.assertProfilesAvailable(ids),
    generateStructured: async request => {
      if (request.role === "causal-verifier" && request.schemaName === "resolution_plan_verification") {
        const slot = subjects.get(request.subjectId);
        if (slot === undefined || admitted.has(slot)) throw new Error("admission verifier identity mismatch");
        admitted.set(slot, structuredClone(request.context));
        options.onVerifierRequest?.(request, slot);
        throw new AdmissionStageStopped("mechanical plan admission observed; semantic verifier deliberately not called");
      }
      if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit") {
        throw new ModelConfigurationError(`unexpected admission stage ${request.role}/${request.schemaName}`);
      }
      const slot = subjects.get(request.subjectId);
      if (slot === undefined) throw new ModelConfigurationError("admission logical subject changed");
      logicalAttempts.set(slot, (logicalAttempts.get(slot) ?? 0) + 1);
      const repair = (request.context as { repair?: { issues?: unknown } | null }).repair;
      if (repair?.issues !== undefined) {
        const entries = repairEvidence.get(slot) ?? [];
        entries.push({ logicalAttempt: logicalAttempts.get(slot)!, issues: structuredClone(repair.issues) });
        repairEvidence.set(slot, entries);
      }
      const result = await coordinator.generateStructured(request);
      const ordinals = result.audit.invocations.map(invocation => physicalOrdinals.get(invocation.id));
      if (!ordinals.length || ordinals.some(ordinal => ordinal === undefined)) throw new ModelConfigurationError("admission physical audit mapping missing");
      acceptedFrom.set(slot, Math.max(...ordinals as number[]));
      return result;
    },
  };
  const engine = new TruthEngine(logical, { repairAttempts: 2, includeActivityTemporalEvidence: options.includeActivityTemporalEvidence, includeResolutionMeansSources: bindings[0]!.includeResolutionMeansSources });
  const settled = await Promise.allSettled(bindings.map(binding => engine.resolve({
    definition: source.definition, state: source.state, initialActions: binding.actions, groundings: binding.groundings,
    identityOwner: binding.identityOwner, temporalBoundary: binding.temporalBoundary,
    modelWorkset: { state: source.state, initialActions: source.actions, availableActions: source.actions, availableDependencies: source.groundings },
    resolutionScope: { mode: "component", selectedActionIds: binding.actions.map(action => action.id).sort(), totalActionCount: source.actions.length },
    renderObservations: async () => { throw new Error("admission cannot render observations"); },
    validateProposal: () => { throw new Error("admission cannot execute transitions"); },
  }, { ...options.scope, runtimeIdentity: { worldHash: source.state.worldHash, revision: source.state.revision },
    workloadId: binding.execution.instanceId, batchId: binding.execution.advanceId })));
  if (contentHash(source) !== beforeHash) throw new Error("admission modified bound source data");
  return { physicalRequests, physicalFailures, complete: admitted.size === bindings.length,
    firstHttpComplete: bindings.every(binding => admitted.has(binding.slot) && acceptedFrom.get(binding.slot) === 1),
    rows: bindings.map((binding, index) => ({ slot: binding.slot, actions: binding.actions.length,
      admitted: admitted.has(binding.slot), verifierContext: admitted.get(binding.slot) ?? null,
      logicalAttempts: logicalAttempts.get(binding.slot) ?? 0,
      repairEvidence: repairEvidence.get(binding.slot) ?? [],
      admittedFromPhysicalRequest: admitted.has(binding.slot) ? acceptedFrom.get(binding.slot) ?? null : null,
      error: settled[index]!.status === "rejected" ? String(settled[index]!.reason) : "unexpected full resolution completion" })),
    stateHash: contentHash(source.state), sourceHash: beforeHash, semanticVerdict: "unassessed", stepCommitted: false };
}
