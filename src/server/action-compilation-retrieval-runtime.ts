import {
  CachedPassageEncoder,
} from "../engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { createCoverageAwareJointBudgetSelector } from "../engine/algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget";
import {
  discoverLocalEncoderModelDirectory,
  livingWorldCacheRoot,
  loadLocalEncoder,
  type LocalEncoderRuntime,
} from "../engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { MULTILINGUAL_E5_BASE_ASSET } from "../engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import {
  createRelationalRrfPhysicalBatchRetriever,
  relationalRrfEncoderFingerprint,
  R5_RELATIONAL_PASSAGE_SCHEMA_VERSION,
  RELATIONAL_RRF_RETRIEVAL_CHANNELS,
} from "../engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";
import {
  ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
  createActionCompilationRetrievalRuntime,
} from "../engine/algorithms/eager-reference/candidate-retrieval/runtime";
import { actionCompilationPassagesForState } from "../engine/algorithms/eager-reference/candidate-retrieval/warmup";
import type { CandidateSelectionCapability } from "../engine/algorithms/roles";
import type { SimulationState } from "../engine/contracts/model";
import type { AlgorithmRef } from "../engine/runtime/execution";

const modelLoads = new Map<string, Promise<LocalEncoderRuntime>>();
type EncoderFingerprintResolver = (encoder: LocalEncoderRuntime, passageSchemaVersion: number) => string;

function loadEncoderOnce(modelDirectory: string): Promise<LocalEncoderRuntime> {
  const existing = modelLoads.get(modelDirectory);
  if (existing) return existing;
  const pending = loadLocalEncoder({
    modelDirectory,
    modelId: MULTILINGUAL_E5_BASE_ASSET.modelId,
    expectedHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256,
  });
  modelLoads.set(modelDirectory, pending);
  void pending.catch(() => modelLoads.delete(modelDirectory));
  return pending;
}

interface RetrievalConfig {
  rootRef: AlgorithmRef;
  selectionRef: AlgorithmRef<"candidate-selection">;
  runtimeVersion: string;
  encoderFingerprint: string;
  budgetRatio: 0.2;
  maxPathDepth: 3;
  pseudoSeedCount: 16;
  compactKindRatio: 0.15;
  dynamicPassageWrites: true;
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && JSON.stringify(left) === JSON.stringify(right);
}

function retrievalConfig(ref: AlgorithmRef): RetrievalConfig | undefined {
  const selection = ref.children.actionCompilation?.children.candidateSelection;
  if (!selection || selection.id === "full-catalog") return undefined;
  const ranking = selection.children.ranking;
  const allocation = selection.children.allocation;
  if (selection.role !== "candidate-selection" || selection.id !== "relational-rrf" || selection.version !== "2" ||
    selection.config.budgetPolicy !== "mandatory-floor-v1" ||
    selection.config.budgetRatio !== 0.2 || selection.config.cacheSchemaVersion !== 1 ||
    selection.config.dynamicPassageWrites !== true ||
    ranking?.role !== "candidate-ranking" || ranking.id !== "typed-channel-rrf" || ranking.version !== "1" ||
    ranking.config.encoderFingerprint !== MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint ||
    ranking.config.encoderModel !== MULTILINGUAL_E5_BASE_ASSET.modelId || ranking.config.graphDepth !== 3 ||
    ranking.config.pseudoSeedCount !== 16 || ranking.config.passageSchemaVersion !== R5_RELATIONAL_PASSAGE_SCHEMA_VERSION ||
    ranking.config.querySchemaVersion !== 1 || ranking.config.rrfSchemaVersion !== 1 ||
    !sameStrings(ranking.config.channels, RELATIONAL_RRF_RETRIEVAL_CHANNELS) ||
    allocation?.role !== "candidate-allocation" || allocation.id !== "coverage-aware-joint-budget" ||
    allocation.version !== "1" || allocation.config.compactKindRatio !== 0.15) {
    throw new Error(`candidate selection config is invalid for ${selection.role}/${selection.id}@${selection.version}`);
  }
  return {
    rootRef: ref,
    selectionRef: selection as AlgorithmRef<"candidate-selection">,
    runtimeVersion: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
    encoderFingerprint: MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint,
    budgetRatio: 0.2,
    maxPathDepth: 3,
    pseudoSeedCount: 16,
    compactKindRatio: 0.15,
    dynamicPassageWrites: true,
  };
}

interface RetrievalRuntime {
  runtime: CandidateSelectionCapability;
  preflight(input: { worldContentHash: string; state: Readonly<SimulationState> }): Promise<void>;
}

export interface ActionCompilationRetrievalRuntimeProvider {
  runtime(ref: AlgorithmRef): CandidateSelectionCapability | undefined;
  preflight(ref: AlgorithmRef, input: {
    worldContentHash: string;
    state: Readonly<SimulationState>;
  }): Promise<void>;
}

function lazyRetrievalRuntime(input: {
  config: RetrievalConfig;
  cacheRoot: string;
  loadEncoder: () => Promise<LocalEncoderRuntime>;
  fingerprint: EncoderFingerprintResolver;
  onSafetyViolation: (ref: AlgorithmRef, reason: string) => void;
}): RetrievalRuntime {
  let delegate: Promise<{
    runtime: CandidateSelectionCapability;
    passageEncoder: CachedPassageEncoder;
  }> | undefined;
  const load = () => {
    delegate ??= input.loadEncoder().then((encoder) => {
      const fingerprint = input.fingerprint(encoder, R5_RELATIONAL_PASSAGE_SCHEMA_VERSION);
      if (fingerprint !== input.config.encoderFingerprint) {
        throw new Error(`candidate retrieval encoder fingerprint drift: expected ${input.config.encoderFingerprint}, got ${fingerprint}`);
      }
      const passageEncoder = new CachedPassageEncoder(encoder, fingerprint, input.cacheRoot);
      return {
        passageEncoder,
        runtime: createActionCompilationRetrievalRuntime({
          version: input.config.runtimeVersion,
          budgetRatio: input.config.budgetRatio,
          selectBatch: createCoverageAwareJointBudgetSelector({
            compactKindBudgetRatio: input.config.compactKindRatio,
          }),
          retrievePhysicalBatch: createRelationalRrfPhysicalBatchRetriever({
            encoder,
            passageEncoder,
            maxPathDepth: input.config.maxPathDepth,
            pseudoSeedCount: input.config.pseudoSeedCount,
            allowPassageWrites: input.config.dynamicPassageWrites,
          }),
        }),
      };
    });
    return delegate;
  };
  const withSafetyBoundary = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      input.onSafetyViolation(
        input.config.rootRef,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  };
  return {
    runtime: {
      version: input.config.runtimeVersion,
      role: "candidate-selection",
      async retrieveBatch(request) {
        return withSafetyBoundary(async () => (await load()).runtime.retrieveBatch(request));
      },
    },
    async preflight(request) {
      return withSafetyBoundary(async () => {
        if (request.state.worldHash !== request.worldContentHash) {
          throw new Error("candidate retrieval preflight world hash does not match state");
        }
        const passages = actionCompilationPassagesForState(request.state);
        const prepared = await load();
        const result = await prepared.passageEncoder.encodePassages({
          worldContentHash: request.worldContentHash,
          passages,
          allowWrite: false,
        });
        if (result.misses !== 0 || result.hits !== new Set(passages).size) {
          throw new Error("candidate retrieval preflight did not verify every world passage");
        }
      });
    },
  };
}

export function createActionCompilationRetrievalRuntimeProvider(
  options: {
    cacheRoot?: string;
    modelDirectory?: string;
    encoder?: LocalEncoderRuntime;
    fingerprint?: EncoderFingerprintResolver;
    onSafetyViolation?: (ref: AlgorithmRef, reason: string) => void;
  } = {},
): ActionCompilationRetrievalRuntimeProvider {
  const cacheRoot = options.cacheRoot ?? livingWorldCacheRoot();
  const supports = new Map<string, RetrievalRuntime | null>();
  const support = (ref: AlgorithmRef): RetrievalRuntime | undefined => {
    const existing = supports.get(ref.manifestHash);
    if (existing !== undefined) return existing ?? undefined;
    const config = retrievalConfig(ref);
    if (!config) {
      supports.set(ref.manifestHash, null);
      return undefined;
    }
    const created = lazyRetrievalRuntime({
      config,
      cacheRoot,
      loadEncoder: options.encoder
        ? async () => options.encoder!
        : () => loadEncoderOnce(
            options.modelDirectory ?? discoverLocalEncoderModelDirectory(
              cacheRoot,
              MULTILINGUAL_E5_BASE_ASSET.name,
            ),
          ),
      fingerprint: options.fingerprint ?? relationalRrfEncoderFingerprint,
      onSafetyViolation: options.onSafetyViolation ?? (() => undefined),
    });
    supports.set(ref.manifestHash, created);
    return created;
  };
  return {
    runtime(ref) {
      return support(ref)?.runtime;
    },
    async preflight(ref, input) {
      const selected = support(ref);
      if (selected) await selected.preflight(input);
    },
  };
}

export function clearActionCompilationEncoderSingletonsForTests(): void {
  modelLoads.clear();
}
