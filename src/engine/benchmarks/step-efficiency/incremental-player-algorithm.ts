import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { defineAlgorithmRef } from "../../algorithms/composition";
import { createComposedEagerReferenceAlgorithm } from "../../algorithms/registry";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelProvider } from "../../models/model-provider";
import { WORLD_EXECUTION_CONTRACT_VERSION, type WorldExecutionAlgorithmRegistry } from "../../runtime/execution";
import { localPlanRepairAlgorithmRef } from "./local-plan-repair-algorithm";
import { AGENT_INTENT_CONTROL, agentIntentControlRequest, type IntentCognitionScope } from "./agent-intent-control";
import { incrementalIntentSelector, INTENT_GUARD_VERSION } from "./incremental-intent-execution";
import { PLAN_TRANSITION_FUSION } from "../../mechanics/plan-transition-fusion";
import type { EagerReferenceComponents } from "../../algorithms/eager-reference/eager-reference";
import { OBSERVATION_ACTION_DICTIONARY, observationActionDictionaryRequest } from "./observation-action-dictionary";

const config = { cognition: AGENT_INTENT_CONTROL, guard: INTENT_GUARD_VERSION, execution: "persistent-frontier-groups-v1",
  planningPartition: "ready-wave-work-v1", observation: OBSERVATION_ACTION_DICTIONARY };
function foundation(fusion = false) {
  const base = localPlanRepairAlgorithmRef(), truth = base.children.truthResolution!;
  const batching = truth.children.batching!;
  return defineAlgorithmRef({ ...base, children: { ...base.children,
    truthResolution: defineAlgorithmRef({ ...truth, config: { ...truth.config,
      ...(fusion ? { planTransitionFusion: PLAN_TRANSITION_FUSION } : {}) }, children: { ...truth.children,
      batching: defineAlgorithmRef({ ...batching, config: { ...batching.config, planningPartition: config.planningPartition } }),
    } }),
  } });
}
export function incrementalPlayerAlgorithmRef(fusion = false) {
  return defineAlgorithmRef({ role: "world-execution", id: fusion ? "fused-player-diagnostic" : "incremental-player-diagnostic", version: fusion ? "2" : "3",
    contractVersion: WORLD_EXECUTION_CONTRACT_VERSION, config: { ...config, ...(fusion ? { planTransitionFusion: PLAN_TRANSITION_FUSION } : {}) }, children: foundation(fusion).children });
}

export function createIncrementalPlayerAlgorithm(context: Parameters<typeof createComposedEagerReferenceAlgorithm>[0],
  configure: (components: EagerReferenceComponents) => EagerReferenceComponents = components => components) {
  const cognition = new AsyncLocalStorage<IntentCognitionScope>(), original = context.services.provider;
  const producerHash = context.ref.manifestHash;
  const provider: StructuredModelProvider = { catalog: original.catalog,
    availableProfileSummaries: role => original.availableProfileSummaries(role),
    assertProfilesAvailable: profiles => original.assertProfilesAvailable(profiles),
    generateStructured: request => {
      const scope = cognition.getStore();
      const compacted = observationActionDictionaryRequest(request);
      return original.generateStructured(scope ? agentIntentControlRequest(compacted, scope, producerHash) : compacted);
    } };
  const slots = context.ref.children.agentCognition!.children.batching!.config.maxSlots;
  if (typeof slots !== "number" || !Number.isSafeInteger(slots) || slots < 1) throw new Error("intent guard batch cardinality is not pinned");
  return createComposedEagerReferenceAlgorithm({ ...context, services: { ...context.services, provider } }, components => {
    const base = components.agentCognition;
    return configure({ ...components, selectActions: incrementalIntentSelector(original, producerHash, slots),
      agentCognition: { thinkBatch: (state, inputs, scope, purpose, maxSlots) =>
        cognition.run({ state, inputs }, () => base.thinkBatch(state, inputs, scope, purpose, maxSlots)) } });
  });
}

/** Complete diagnostic integration; semantic and player-latency qualification
 * remain separate from construction and deterministic persistence checks. */
export function registerIncrementalPlayerAlgorithm(registry: WorldExecutionAlgorithmRegistry) {
  for (const fusion of [false, true]) {
    const ref = incrementalPlayerAlgorithmRef(fusion);
    registry.registerDefinition({ role: "world-execution", id: ref.id, version: ref.version,
    contractVersion: WORLD_EXECUTION_CONTRACT_VERSION, maturity: "diagnostic",
    configSchema: z.custom<typeof config>(value => contentHash(value) === contentHash(ref.config)),
    children: Object.entries(ref.children).map(([name, child]) => ({ name, role: child.role })),
    create: context => {
      if (contentHash(context.ref.children) !== contentHash(ref.children)) throw new Error("incremental diagnostic foundation changed");
      return createIncrementalPlayerAlgorithm(context);
    } });
  }
  return registry;
}
