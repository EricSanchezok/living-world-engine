import type { AlgorithmMaturity } from "../../../algorithms/composition";
import { GRAPH_AWARE_CANDIDATE_SELECTION_STRATEGIES } from "../../../algorithms/eager-reference/candidate-retrieval/graph-aware";
import { ADVANCED_ACTION_COMPILATION_RETRIEVER_STRATEGIES } from "./advanced";
import { ACTION_COMPILATION_RETRIEVER_STRATEGIES } from "./core";

export const BENCHMARK_CANDIDATE_SELECTION_CONTRACT = "benchmark-candidate-selection-v1" as const;

export interface BenchmarkCandidateSelectionCatalogEntry {
  role: "candidate-selection";
  id: string;
  version: "1";
  maturity: Extract<AlgorithmMaturity, "diagnostic">;
  availability: "benchmark-only";
  contract: typeof BENCHMARK_CANDIDATE_SELECTION_CONTRACT;
  family: "catalog" | "structure-encoder" | "graph";
  strategy: string;
  source: string;
  evidence: string;
}

function entry(input: Omit<BenchmarkCandidateSelectionCatalogEntry,
  "availability" | "contract" | "maturity" | "role" | "version"
>): BenchmarkCandidateSelectionCatalogEntry {
  return Object.freeze({
    role: "candidate-selection",
    version: "1",
    maturity: "diagnostic",
    availability: "benchmark-only",
    contract: BENCHMARK_CANDIDATE_SELECTION_CONTRACT,
    ...input,
  });
}

const core = ACTION_COMPILATION_RETRIEVER_STRATEGIES
  .filter((strategy) => strategy !== "full-catalog")
  .map((strategy) => entry({
    id: strategy,
    strategy,
    family: "catalog",
    source: "src/engine/benchmarks/action-compilation/retrievers/core.ts",
    evidence: "benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-ab-v1/results.json",
  }));

const advancedIds: Readonly<Record<typeof ADVANCED_ACTION_COMPILATION_RETRIEVER_STRATEGIES[number], string>> = {
  "structure-closure": "structure-closure",
  "structure-bm25f": "structure-bm25f",
  "encoder-anchor": "encoder-anchor",
  "encoder-coverage": "encoder-coverage",
  hybrid: "structure-encoder-hybrid",
  "retrieve-expand-refine": "retrieve-expand-refine",
};

const advanced = ADVANCED_ACTION_COMPILATION_RETRIEVER_STRATEGIES.map((strategy) => entry({
  id: advancedIds[strategy],
  strategy,
  family: "structure-encoder",
  source: "src/engine/benchmarks/action-compilation/retrievers/advanced.ts",
  evidence: "benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-structure-ab-v2/README.md",
}));

const graph = GRAPH_AWARE_CANDIDATE_SELECTION_STRATEGIES.map((strategy) => entry({
  id: strategy,
  strategy,
  family: "graph",
  source: "src/engine/algorithms/eager-reference/candidate-retrieval/graph-aware.ts",
  evidence: strategy === "graph-hybrid"
    ? "benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-runtime-ab-v4/results.json"
    : "benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-graph-ab-v3/results.json",
}));

/** Offline implementations are intentionally separate from the executable
 * instance registry. Promotion requires a production-batch adapter, pinned
 * resources, and evidence that passes the current activation gate. */
export const BENCHMARK_CANDIDATE_SELECTION_ALGORITHMS: readonly BenchmarkCandidateSelectionCatalogEntry[] =
  Object.freeze([...core, ...advanced, ...graph].sort((left, right) => left.id.localeCompare(right.id)));
