import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { validateActionCompilationCapturedSource } from "../source-capture";
import { bindFirstPassOracle } from "./first-pass-oracle";
import { AC_FP1_SOURCES, orderedFirstPassSources } from "./first-pass-protocol";
import { AC_FP2_PROTOCOL } from "./constrained-first-pass-protocol";
import { firstPassReviewEntries, validatedFirstPassOutputs } from "./first-pass-scoring";
import type { FirstPassTrialEvidence } from "./first-pass-runner";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestFrameSchema = z.object({ hash: hashSchema, manifest: z.object({
  version: z.literal(1), codeHash: hashSchema, oracleHash: hashSchema,
  files: z.array(z.strictObject({ file: z.string(), hash: hashSchema })).length(23),
}).passthrough() });
const expectedFiles = [...AC_FP1_SOURCES.flatMap(({ id }) => ["B1", "A", "T", "AT", "source"].map((arm) => `${id}-${arm}.json`)),
  "oracle.json", "verification.json", "protocol.json"].sort();

/** Verify historical evidence independently of the new experiment's executable code hash. */
export function verifyConstrainedSourceManifest(value: unknown, trustedHash: string) {
  const parsed = manifestFrameSchema.parse(value);
  if (parsed.hash !== trustedHash || contentHash(parsed.manifest) !== trustedHash) throw new Error("historical source manifest hash mismatch");
  if (contentHash(parsed.manifest.files.map(({ file }) => file).sort()) !== contentHash(expectedFiles)) {
    throw new Error("historical source file set mismatch");
  }
  return parsed.manifest;
}

export function readConstrainedFirstPassSources(sourceRoot: string) {
  const directory = realpathSync(path.join(sourceRoot, "frozen"));
  const read = (file: string): unknown => {
    const resolved = realpathSync(path.join(directory, file));
    if (path.dirname(resolved) !== directory) throw new Error("historical artifact escapes frozen directory");
    return JSON.parse(readFileSync(resolved, "utf8"));
  };
  const manifest = verifyConstrainedSourceManifest(read("manifest.json"), AC_FP2_PROTOCOL.sourceManifestHash);
  const artifacts = new Map<string, unknown>();
  for (const { file, hash } of manifest.files) {
    const value = read(file);
    if (contentHash(value) !== hash) throw new Error(`historical artifact hash mismatch: ${file}`);
    artifacts.set(file, value);
  }
  const sources = orderedFirstPassSources(AC_FP1_SOURCES.map(({ id }) => validateActionCompilationCapturedSource(artifacts.get(`${id}-source.json`))));
  const frozenOracle = artifacts.get("oracle.json") as ReturnType<typeof bindFirstPassOracle>;
  const oracle = bindFirstPassOracle({ ...frozenOracle, actions: frozenOracle.actions.map(({ actor, source, must, may, forbidden }) =>
    ({ actor, source, must, may, forbidden })) }, sources);
  if (contentHash(oracle) !== manifest.oracleHash || contentHash(oracle) !== contentHash(frozenOracle)) {
    throw new Error("historical oracle action binding drift");
  }
  return { manifest, sources, oracle, artifacts };
}

/** Rebuild the blind pack from results bound by the already-published score hash. */
export function readConstrainedHistoricalReviews(sourceRoot: string, frozen: ReturnType<typeof readConstrainedFirstPassSources>) {
  const root = realpathSync(sourceRoot);
  const read = (file: string): unknown => {
    const resolved = realpathSync(path.join(root, file));
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("historical review artifact escapes source root");
    return JSON.parse(readFileSync(resolved, "utf8"));
  };
  const scoreDirectory = `scores/${AC_FP2_PROTOCOL.sourceScoreHash}`;
  const metrics = read(`${scoreDirectory}/metrics.json`) as {
    frozenHash: string; resultHashes: Array<{ trialId: string; hash: string }>;
  };
  if (contentHash(metrics) !== AC_FP2_PROTOCOL.sourceScoreHash || metrics.frozenHash !== AC_FP2_PROTOCOL.sourceManifestHash) {
    throw new Error("historical score hash mismatch");
  }
  const entries = new Map<string, ReturnType<typeof firstPassReviewEntries>[number]>();
  const origins: Record<string, Array<{ trialId: string; invocationId: string; artifact: string }>> = {};
  for (const { trialId, hash } of metrics.resultHashes) {
    if (!/^discovery-P0[1-4]-\d{2}-(B1|A|T|AT)$/u.test(trialId)) throw new Error("unexpected historical trial identity");
    const result = read(`trials/${trialId}/result.json`) as {
      frozenHash: string; hash: string; evidence: FirstPassTrialEvidence;
    };
    if (result.frozenHash !== metrics.frozenHash || result.hash !== hash || contentHash(result.evidence) !== hash ||
      result.evidence.trial.id !== trialId) throw new Error("historical result hash mismatch");
    const source = frozen.sources[result.evidence.trial.sourceIndex];
    if (!source || result.evidence.sourceHash !== contentHash(source)) throw new Error("historical result source mismatch");
    const validated = validatedFirstPassOutputs(result.evidence);
    for (const entry of firstPassReviewEntries(result.evidence, source, frozen.manifest.oracleHash)) {
      entries.set(entry.reviewId, entry);
      const calls = validated.filter(({ accepted }) => accepted.some(({ key, result: compilation }) =>
        key === entry.actionId && contentHash(compilation) === entry.canonicalCompilationHash));
      if (!calls.length) throw new Error("historical review lacks originating invocation");
      (origins[entry.reviewId] ??= []).push(...calls.map(({ call }) => {
        if (!call.invocationId) throw new Error("historical accepted output lacks invocation identity");
        return { trialId, invocationId: call.invocationId, artifact: `trials/${trialId}/result.json` };
      }));
    }
  }
  const pack = read(`${scoreDirectory}/review-pack.json`) as { oracleHash: string; entries: ReturnType<typeof firstPassReviewEntries> };
  const rebuilt = [...entries.values()].sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  if (pack.oracleHash !== frozen.manifest.oracleHash || contentHash(pack.entries) !== contentHash(rebuilt) || rebuilt.length !== 601) {
    throw new Error("historical review pack differs from validated results");
  }
  return { packHash: contentHash(pack), entries: rebuilt, origins, validatedTrials: metrics.resultHashes.length };
}
