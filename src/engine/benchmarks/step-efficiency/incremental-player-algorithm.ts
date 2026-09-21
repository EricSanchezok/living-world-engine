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

const config = { cognition: AGENT_INTENT_CONTROL, guard: INTENT_GUARD_VERSION, execution: "persistent-frontier-groups-v1",
  planningPartition: "ready-wave-work-v1" };
function foundation() {
  const base = localPlanRepairAlgorithmRef(), truth = base.children.truthResolution!;
  const batching = truth.children.batching!;
  return defineAlgorithmRef({ ...base, children: { ...base.children,
    truthResolution: defineAlgorithmRef({ ...truth, children: { ...truth.children,
      batching: defineAlgorithmRef({ ...batching, config: { ...batching.config, planningPartition: config.planningPartition } }),
    } }),
  } });
}
export function incrementalPlayerAlgorithmRef() {
  return defineAlgorithmRef({ role: "world-execution", id: "incremental-player-diagnostic", version: "2",
    contractVersion: WORLD_EXECUTION_CONTRACT_VERSION, config, children: foundation().children });
}

/** Complete diagnostic integration; semantic and player-latency qualification
 * remain separate from construction and deterministic persistence checks. */
export function registerIncrementalPlayerAlgorithm(registry: WorldExecutionAlgorithmRegistry) {
  registry.registerDefinition({ role: "world-execution", id: "incremental-player-diagnostic", version: "2",
    contractVersion: WORLD_EXECUTION_CONTRACT_VERSION, maturity: "diagnostic",
    configSchema: z.custom<typeof config>(value => contentHash(value) === contentHash(config)),
    children: Object.entries(foundation().children).map(([name, child]) => ({ name, role: child.role })),
    create: context => {
      if (contentHash(context.ref.children) !== contentHash(foundation().children)) throw new Error("incremental diagnostic foundation changed");
      const cognition = new AsyncLocalStorage<IntentCognitionScope>(), original = context.services.provider;
      const producerHash = context.ref.manifestHash;
      const provider: StructuredModelProvider = { catalog: original.catalog,
        availableProfileSummaries: role => original.availableProfileSummaries(role),
        assertProfilesAvailable: profiles => original.assertProfilesAvailable(profiles),
        generateStructured: request => {
          const scope = cognition.getStore();
          return original.generateStructured(scope ? agentIntentControlRequest(request, scope, producerHash) : request);
        } };
      const slots = context.ref.children.agentCognition!.children.batching!.config.maxSlots;
      if (typeof slots !== "number" || !Number.isSafeInteger(slots) || slots < 1) throw new Error("intent guard batch cardinality is not pinned");
      return createComposedEagerReferenceAlgorithm({ ...context, services: { ...context.services, provider } }, components => {
        const base = components.agentCognition;
        return { ...components, selectActions: incrementalIntentSelector(original, producerHash, slots),
          agentCognition: { thinkBatch: (state, inputs, scope, purpose, maxSlots) =>
            cognition.run({ state, inputs }, () => base.thinkBatch(state, inputs, scope, purpose, maxSlots)) } };
      });
    } });
  return registry;
}
