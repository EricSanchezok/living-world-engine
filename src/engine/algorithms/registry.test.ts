import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DeterministicModelProvider } from "../testing/model-provider";
import { WorldExecutionAlgorithmRegistry } from "../runtime/execution";
import { defineAlgorithmRef, type AlgorithmRef, type AlgorithmRole } from "./composition";
import {
  ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
  DEFAULT_ALGORITHM_REF,
  eagerReferenceAlgorithmRef,
  FULL_CATALOG_ALGORITHM_REF,
  registerBuiltinAlgorithms,
} from "./registry";
import {
  DEFAULT_EAGER_REFERENCE_CONFIG,
  EagerReferenceAlgorithm,
} from "./eager-reference/eager-reference";
import { RELATIONAL_RRF_ENCODER_FINGERPRINT } from "./eager-reference/candidate-retrieval/relational-rrf";
import { ORDERED_RANDOM_SCHEDULING } from "../mechanics/ordered-random-stream";

function replaceChild<R extends AlgorithmRole>(
  ref: AlgorithmRef<R>,
  slot: string,
  child: AlgorithmRef,
): AlgorithmRef<R> {
  return defineAlgorithmRef({
    role: ref.role,
    id: ref.id,
    version: ref.version,
    contractVersion: ref.contractVersion,
    config: ref.config,
    children: { ...ref.children, [slot]: child },
  });
}

it("rejects historical Truth contracts and random scheduling instead of changing pinned candidates", () => {
  const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
  const truth = FULL_CATALOG_ALGORITHM_REF.children.truthResolution!;
  const candidate = (randomScheduling: string) => replaceChild(FULL_CATALOG_ALGORITHM_REF, "truthResolution",
    defineAlgorithmRef({ ...truth, id: "ordered-rng-truth-resolution", config: { randomScheduling } }));
  const current = candidate(ORDERED_RANDOM_SCHEDULING);
  const historical = candidate("canonical-component-order-v1");
  expect(current.manifestHash).not.toBe(historical.manifestHash);
  expect(registry.has(current)).toBe(true);
  expect(registry.has(historical)).toBe(false);
  const previousContract = replaceChild(FULL_CATALOG_ALGORITHM_REF, "truthResolution",
    defineAlgorithmRef({ ...truth, contractVersion: 1 }));
  expect(registry.has(previousContract)).toBe(false);
});

describe("built-in algorithm registry", () => {
  it("resolves every node in the default Composition", () => {
    const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    expect(registry.has(DEFAULT_ALGORITHM_REF)).toBe(true);
    expect(registry.catalog().map((entry) => `${entry.role}/${entry.id}@${entry.version}`)).toEqual([
      "action-compilation/constrained-action-compilation@1",
      "action-compilation/model-action-compilation@2",
      "action-compilation/represented-action-compilation@2",
      "agent-cognition/model-agent-cognition@1",
      "candidate-allocation/coverage-aware-joint-budget@1",
      "candidate-ranking/typed-channel-rrf@1",
      "candidate-selection/full-catalog@1",
      "candidate-selection/relational-rrf@2",
      "interaction-grounding/model-interaction-grounding@1",
      "observation-rendering/model-observation-rendering@2",
      "observation-rendering/source-bound-observation-rendering@2",
      "onset-perception/model-onset-perception@5",
      "output-recovery/localized-repair-bisect@1",
      "reaction-decision/model-reaction-decision@1",
      "reaction-resolution/onset-reaction@1",
      "symbol-repair/bounded-symbol-repair@1",
      "truth-resolution/dependent-fields-truth-resolution@1",
      "truth-resolution/indexed-reviewed-truth-resolution@5",
      "truth-resolution/model-truth-resolution@1",
      "truth-resolution/ordered-rng-truth-resolution@1",
      "truth-resolution/source-inventory-truth-resolution@1",
      "truth-resolution/worklist-truth-resolution@1",
      "work-batching/bounded-slot-batching@1",
      "work-batching/shared-context-slot-batching@2",
      "work-batching/shared-state-first-slot-batching@1",
      "work-scheduling/bounded-concurrency@1",
      "world-execution/eager-reference@22",
    ]);
  });

  it("accepts a substitutable candidate-selection implementation through its Role contract", () => {
    const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    registry.registerAlgorithmDefinition({
      role: "candidate-selection",
      id: "test-full-catalog",
      version: "1",
      contractVersion: 1,
      maturity: "diagnostic",
      configSchema: z.strictObject({}),
      children: [],
      create: ({ ref, children }) => ({
        algorithmIdentity: {
          role: "candidate-selection",
          id: "test-full-catalog",
          version: "1",
          contractVersion: 1,
        },
        config: ref.config,
        children,
        runtime: undefined,
      }),
    });
    const replacement = defineAlgorithmRef({
      role: "candidate-selection",
      id: "test-full-catalog",
      version: "1",
      contractVersion: 1,
      config: {},
    });
    const actionCompilation = replaceChild(
      FULL_CATALOG_ALGORITHM_REF.children.actionCompilation!,
      "candidateSelection",
      replacement,
    );
    const composition = replaceChild(FULL_CATALOG_ALGORITHM_REF, "actionCompilation", actionCompilation);
    const algorithm = registry.create(composition, { provider: new DeterministicModelProvider() });

    expect(algorithm.manifest.hash).toBe(composition.manifestHash);
    expect(algorithm.manifest.children.actionCompilation?.children.candidateSelection?.id).toBe("test-full-catalog");
  });

  it("consumes typed batching capabilities instead of implementation-specific config fields", () => {
    const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    registry.registerAlgorithmDefinition({
      role: "work-batching",
      id: "fixed-small-batches",
      version: "1",
      contractVersion: 1,
      maturity: "candidate",
      configSchema: z.strictObject({ profile: z.literal("small") }),
      children: [],
      create: ({ ref, children }) => ({
        algorithmIdentity: {
          role: "work-batching",
          id: "fixed-small-batches",
          version: "1",
          contractVersion: 1,
        },
        config: ref.config,
        children,
        maxSlots: 3,
      }),
    });
    const batching = defineAlgorithmRef({
      role: "work-batching",
      id: "fixed-small-batches",
      version: "1",
      contractVersion: 1,
      config: { profile: "small" },
    });
    const actionCompilation = replaceChild(
      FULL_CATALOG_ALGORITHM_REF.children.actionCompilation!,
      "batching",
      batching,
    );
    const composition = replaceChild(FULL_CATALOG_ALGORITHM_REF, "actionCompilation", actionCompilation);
    const algorithm = registry.create(composition, { provider: new DeterministicModelProvider() });

    expect(algorithm).toBeInstanceOf(EagerReferenceAlgorithm);
    expect((algorithm as EagerReferenceAlgorithm).config.actionCompilationMaxSlots).toBe(3);
  });

  it("fails preflight for missing or incompatible candidate-selection resources", () => {
    const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    const treatment = eagerReferenceAlgorithmRef({
      ...DEFAULT_EAGER_REFERENCE_CONFIG,
      candidateRetrieval: {
        mode: "runtime",
        runtimeVersion: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
        encoderFingerprint: RELATIONAL_RRF_ENCODER_FINGERPRINT,
        budgetRatio: 0.2,
      },
    });
    const provider = new DeterministicModelProvider();

    expect(() => registry.create(treatment, { provider })).toThrow("requires its pinned runtime");
    expect(() => registry.create(treatment, {
      provider,
      resources: {
        resolve: () => ({
          role: "candidate-selection",
          version: "wrong-runtime",
          retrieveBatch: async () => { throw new Error("unused"); },
        }) as never,
      },
    })).toThrow("received an incompatible runtime");
  });
});
