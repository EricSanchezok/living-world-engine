import { describe, expect, it } from "vitest";
import { GRAPH_AWARE_CANDIDATE_SELECTION_STRATEGIES } from "../../../algorithms/eager-reference/candidate-retrieval/graph-aware";
import { registerBuiltinAlgorithms } from "../../../algorithms/registry";
import { WorldExecutionAlgorithmRegistry } from "../../../runtime/execution";
import { ADVANCED_ACTION_COMPILATION_RETRIEVER_STRATEGIES } from "./advanced";
import { BENCHMARK_CANDIDATE_SELECTION_ALGORITHMS } from "./catalog";
import { ACTION_COMPILATION_RETRIEVER_STRATEGIES } from "./core";

describe("benchmark candidate-selection catalog", () => {
  it("accounts for every replaceable benchmark strategy without registering diagnostics for instance execution", () => {
    const expected = ACTION_COMPILATION_RETRIEVER_STRATEGIES.length - 1 +
      ADVANCED_ACTION_COMPILATION_RETRIEVER_STRATEGIES.length +
      GRAPH_AWARE_CANDIDATE_SELECTION_STRATEGIES.length;
    expect(BENCHMARK_CANDIDATE_SELECTION_ALGORITHMS).toHaveLength(expected);
    expect(new Set(BENCHMARK_CANDIDATE_SELECTION_ALGORITHMS.map((entry) => entry.id)).size).toBe(expected);
    expect(BENCHMARK_CANDIDATE_SELECTION_ALGORITHMS.every((entry) =>
      entry.role === "candidate-selection" && entry.maturity === "diagnostic" && entry.availability === "benchmark-only",
    )).toBe(true);

    const runtimeIds = new Set(registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).catalog()
      .map((entry) => `${entry.role}/${entry.id}@${entry.version}`));
    expect(BENCHMARK_CANDIDATE_SELECTION_ALGORITHMS.every((entry) =>
      !runtimeIds.has(`${entry.role}/${entry.id}@${entry.version}`),
    )).toBe(true);
  });

  it("records the deliberately renamed advanced hybrid and historical graph diagnostic", () => {
    expect(BENCHMARK_CANDIDATE_SELECTION_ALGORITHMS).toContainEqual(expect.objectContaining({
      id: "structure-encoder-hybrid",
      strategy: "hybrid",
    }));
    expect(BENCHMARK_CANDIDATE_SELECTION_ALGORITHMS).toContainEqual(expect.objectContaining({
      id: "graph-hybrid",
      availability: "benchmark-only",
    }));
  });
});
