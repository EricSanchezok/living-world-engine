import { z } from "zod";
import { defineAlgorithmRef } from "../../algorithms/composition";
import { createComposedEagerReferenceAlgorithm } from "../../algorithms/registry";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelProvider } from "../../models/model-provider";
import { WORLD_EXECUTION_CONTRACT_VERSION, type WorldExecutionAlgorithmRegistry } from "../../runtime/execution";
import { AGENT_RECURSIVE_INTENT, agentRecursiveIntentRequest } from "./agent-recursive-intent";
import { localPlanRepairAlgorithmRef } from "./local-plan-repair-algorithm";

const config = { cognition: AGENT_RECURSIVE_INTENT };

/** Unqualified full-player diagnostic under decision 0184; intentions remain opaque to the runtime. */
export function recursivePlayerAlgorithmRef() {
  return defineAlgorithmRef({ role: "world-execution", id: "recursive-player-diagnostic", version: "1", contractVersion: WORLD_EXECUTION_CONTRACT_VERSION,
    config, children: localPlanRepairAlgorithmRef().children });
}

export function registerRecursivePlayerAlgorithm(registry: WorldExecutionAlgorithmRegistry) {
  registry.registerDefinition({ role: "world-execution", id: "recursive-player-diagnostic", version: "1", contractVersion: WORLD_EXECUTION_CONTRACT_VERSION,
    maturity: "diagnostic", configSchema: z.custom<typeof config>(value => contentHash(value) === contentHash(config)),
    children: Object.entries(localPlanRepairAlgorithmRef().children).map(([name, child]) => ({ name, role: child.role })),
    create: context => {
      if (contentHash(context.ref.children) !== contentHash(localPlanRepairAlgorithmRef().children)) {
        throw new Error("recursive player diagnostic requires the current local plan repair foundation");
      }
      const original = context.services.provider;
      const provider: StructuredModelProvider = { catalog: original.catalog,
        availableProfileSummaries: role => original.availableProfileSummaries(role),
        assertProfilesAvailable: profiles => original.assertProfilesAvailable(profiles),
        generateStructured: request => original.generateStructured(agentRecursiveIntentRequest(request)),
      };
      return createComposedEagerReferenceAlgorithm({ ...context, services: { ...context.services, provider } });
    },
  });
  return registry;
}
