import { describe, expect, it } from "vitest";
import { AC_FP1_ARMS, AC_FP1_SOURCES, firstPassAlgorithmRef, firstPassSchedule, orderedFirstPassSources } from "./first-pass-protocol";
import { DEFAULT_ALGORITHM_REF, FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../algorithms/registry";
import { WorldExecutionAlgorithmRegistry } from "../../runtime/execution";
import { DeterministicModelProvider } from "../../testing/model-provider";
import { contentHash } from "../../models/model-audit";
import type { RawBenchmarkSource } from "../source-capture";

describe("frozen AC-FP1 protocol", () => {
  it("seals balanced discovery/confirmation blocks with the prescribed Latin rotations", () => {
    for (const phase of ["discovery", "confirmation"] as const) {
      const schedule = firstPassSchedule(phase, "AT");
      expect(schedule).toEqual(firstPassSchedule(phase, "AT"));
      expect(schedule).toHaveLength(phase === "discovery" ? 64 : 128);
      expect(new Set(schedule.map((trial) => trial.id)).size).toBe(schedule.length);
      const arms = phase === "discovery" ? AC_FP1_ARMS : ["B1", "AT"];
      for (const arm of arms) {
        const trials = schedule.filter((trial) => trial.arm === arm);
        expect(trials).toHaveLength(phase === "discovery" ? 16 : 64);
        expect(trials.reduce((sum, trial) => sum + AC_FP1_SOURCES[trial.sourceIndex]!.size, 0)).toBe(phase === "discovery" ? 172 : 688);
      }
      for (let index = 0; index < schedule.length; index += arms.length) {
        const first = schedule[index]!;
        const offset = (first.sourceIndex + first.repetition) % arms.length;
        expect(first.arm).toBe(arms[offset]);
        expect(new Set(schedule.slice(index, index + arms.length).map((trial) => trial.sourceId)).size).toBe(1);
      }
    }
    expect(() => firstPassSchedule("confirmation")).toThrow("sealed discovery winner");
  });

  it("registers all arms without altering retrieval, batching, recovery or the default", () => {
    const before = contentHash(DEFAULT_ALGORITHM_REF);
    const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    const identities = AC_FP1_ARMS.map((arm) => {
      const ref = firstPassAlgorithmRef(DEFAULT_ALGORITHM_REF, arm);
      registry.validateExperimentComposition(ref);
      expect(ref.children.actionCompilation!.children).toEqual(DEFAULT_ALGORITHM_REF.children.actionCompilation!.children);
      expect(ref.config).toEqual(DEFAULT_ALGORITHM_REF.config);
      const full = firstPassAlgorithmRef(FULL_CATALOG_ALGORITHM_REF, arm);
      expect(registry.create(full, { provider: new DeterministicModelProvider() }).manifest.hash).toBe(full.manifestHash);
      return ref.manifestHash;
    });
    expect(new Set(identities).size).toBe(4);
    expect(contentHash(DEFAULT_ALGORITHM_REF)).toBe(before);
    expect(DEFAULT_ALGORITHM_REF.children.actionCompilation!.config.representation).toBe("AT");
  });

  it("orders only approved initial sources and refuses provenance or batch drift", () => {
    const sources = AC_FP1_SOURCES.map((source) => ({
      sourceInvocationId: `rt:model-audit:${source.invocation}`, actions: Array(source.size).fill({}),
      sourceExecutionId: "dec46f38-a50b-4a28-85d6-73f95a9405fb",
      stateHash: "162934b66695b95cc6ea9c4b355fbbdceecef7f41b20a5c3a31c47f429bbc485",
      modelId: "deepseek-v4-flash", profileId: "truth-deepseek",
      captureAlgorithmManifestHash: "f54358535f735da671573aac63f8b4267f3b981907ffabda10f27e07bab8ca54",
    })) as RawBenchmarkSource[];
    expect(orderedFirstPassSources([...sources].reverse())).toEqual(sources);
    expect(() => orderedFirstPassSources(sources.slice(1))).toThrow("exactly");
    const changed = structuredClone(sources);
    changed[0]!.actions.pop();
    expect(() => orderedFirstPassSources(changed)).toThrow("P01");
    changed[0] = { ...sources[0]!, modelId: "another-model" };
    expect(() => orderedFirstPassSources(changed)).toThrow("P01");
  });

  it.each([false, true])("pins source description and profile evidence choices with omitted schema %s", omitDescription => {
    const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    const ref = firstPassAlgorithmRef(FULL_CATALOG_ALGORITHM_REF, "AT", true, true, true, true, omitDescription);
    registry.validateExperimentComposition(ref);
    expect(registry.create(ref, { provider: new DeterministicModelProvider() }).manifest.hash).toBe(ref.manifestHash);
    expect(ref.children.actionCompilation!.config).toMatchObject({ descriptionPolicy: omitDescription ? "original-action-omitted-v2" : "original-action-v1", profileChoiceEvidence: "visible-schema-v1", temporalContractSelection: "named-operators-v1" });
    expect(firstPassAlgorithmRef(ref, "T")).toEqual(firstPassAlgorithmRef(FULL_CATALOG_ALGORITHM_REF, "T"));
    expect(ref.children.actionCompilation!.children).toEqual(FULL_CATALOG_ALGORITHM_REF.children.actionCompilation!.children);
  });
});
