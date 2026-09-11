import { z } from "zod";
import { defineAlgorithmRef } from "../../algorithms/composition";
import { createComposedEagerReferenceAlgorithm, registerBuiltinAlgorithms } from "../../algorithms/registry";
import { standardEagerReferenceAlgorithmRef } from "../../algorithms/standard-composition";
import { WorldExecutionAlgorithmRegistry } from "../../runtime/execution";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelProvider, StructuredModelRequest } from "../../models/model-provider";
import { CONDITIONAL_PLAN_STAKES, conditionalPlanStakesRequest } from "./conditional-plan-stakes";
import { EFFECT_PROFILE_DOMAINS, effectProfileDomainsRequest } from "./effect-profile-domains";
import { PLANNING_ACTION_FRAMES, planningActionFramesRequest } from "./planning-action-frames";
import { FACTOR_CHOICE_PRODUCTS, factorChoiceProductsRequest } from "./factor-choice-products";
import { OBSERVATION_ACTION_DICTIONARY, observationActionDictionaryRequest } from "./observation-action-dictionary";
import { AGENT_ACTION_TEXT, agentActionTextRequest } from "./agent-action-text";
import { UNMATCHED_CLOSER_RECOVERY } from "../../models/unmatched-closer-recovery";

const config = { planning: [CONDITIONAL_PLAN_STAKES, EFFECT_PROFILE_DOMAINS, PLANNING_ACTION_FRAMES, FACTOR_CHOICE_PRODUCTS],
  observation: OBSERVATION_ACTION_DICTIONARY,
  cognition: { actionText: AGENT_ACTION_TEXT, jsonSyntaxRecovery: UNMATCHED_CLOSER_RECOVERY } };

/** Diagnostic composition only; its combined result cannot qualify individual adapters. */
export function integratedPlayerAlgorithmRef() {
  const foundation = standardEagerReferenceAlgorithmRef();
  return defineAlgorithmRef({ role: "world-execution", id: "integrated-player-diagnostic", version: "6", contractVersion: 9,
    config, children: foundation.children });
}

export function integratedPlayerRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (["agent-bootstrap", "agent-mind", "agent-reaction"].includes(request.role)) {
    return { ...agentActionTextRequest(request), jsonSyntaxRecovery: UNMATCHED_CLOSER_RECOVERY };
  }
  return observationActionDictionaryRequest(factorChoiceProductsRequest(planningActionFramesRequest(
    effectProfileDomainsRequest(conditionalPlanStakesRequest(request)))));
}

export function registerIntegratedPlayerAlgorithm(registry = new WorldExecutionAlgorithmRegistry()) {
  registerBuiltinAlgorithms(registry);
  registry.registerDefinition({ role: "world-execution", id: "integrated-player-diagnostic", version: "6", contractVersion: 9,
    maturity: "diagnostic", configSchema: z.custom<typeof config>(value => contentHash(value) === contentHash(config)),
    children: Object.entries(standardEagerReferenceAlgorithmRef().children).map(([name, child]) => ({ name, role: child.role })),
    create: context => {
      const { ref, services } = context;
      const foundation = standardEagerReferenceAlgorithmRef();
      if (contentHash(ref.children) !== contentHash(foundation.children)) {
        throw new Error("integrated player diagnostic requires the current standard foundation");
      }
      const original = services.provider;
      const provider: StructuredModelProvider = { catalog: original.catalog,
        availableProfileSummaries: role => original.availableProfileSummaries(role),
        assertProfilesAvailable: profiles => original.assertProfilesAvailable(profiles),
        generateStructured: request => original.generateStructured(integratedPlayerRequest(request)),
      };
      return createComposedEagerReferenceAlgorithm({ ...context, services: { ...services, provider } });
    },
  });
  return registry;
}
