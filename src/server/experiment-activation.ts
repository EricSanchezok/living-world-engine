import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../engine/models/model-audit";
import type { AlgorithmExperimentManifest } from "../engine/runtime/experiments";

export interface ExperimentActivationPreflight {
  experimentId: string;
  experimentVersion: string;
  artifact: string;
  artifactHash: string;
  verifier: string;
  offlineGatesPassed: boolean;
  cacheReadiness: number;
  replayMatched: boolean;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function runtimeEncoderFingerprints(manifest: AlgorithmExperimentManifest): readonly string[] {
  return manifest.variants.flatMap(({ algorithmRef }) => {
    const selection = algorithmRef.children.actionCompilation?.children.candidateSelection;
    const fingerprint = selection?.id === "relational-rrf"
      ? selection.children.ranking?.config.encoderFingerprint
      : undefined;
    return typeof fingerprint === "string"
      ? [fingerprint]
      : [];
  });
}

export function verifyExperimentActivationEvidence(
  manifest: AlgorithmExperimentManifest,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExperimentActivationPreflight {
  if (manifest.activationEvidence.verifier !== "action-compilation-retrieval-v4") {
    throw new Error(`unknown experiment activation verifier: ${manifest.activationEvidence.verifier}`);
  }
  const artifact = path.resolve(/* turbopackIgnore: true */ env.LIVINGWORLD_RETRIEVAL_EVALUATION_PATH ??
    "benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-runtime-ab-v4/results.json");
  const bytes = readFileSync(/* turbopackIgnore: true */ artifact);
  const artifactHash = sha256(bytes);
  if (artifactHash !== manifest.activationEvidence.artifactHash) {
    throw new Error(`experiment activation artifact hash mismatch: expected ${manifest.activationEvidence.artifactHash}, got ${artifactHash}`);
  }
  const document = object(JSON.parse(bytes.toString("utf8")) as unknown);
  if (document?.schemaVersion !== 4 || document.kind !== "action-compilation-retrieval-experiment-v4") {
    throw new Error("experiment activation artifact is not an Action Compilation v4 evaluation");
  }
  if (document.datasetId !== "action-compilation/fullcatalog-stabilized" ||
    !Number.isSafeInteger(document.datasetVersion) || Number(document.datasetVersion) < 1) {
    throw new Error("experiment activation artifact references an unsupported dataset");
  }
  const offline = object(document.offline);
  if (offline?.llmRequests !== 0 || offline.networkRequests !== 0 || offline.worldMutations !== 0) {
    throw new Error("experiment activation artifact is not an offline, zero-mutation evaluation");
  }
  const runs = Array.isArray(document?.runs) ? document.runs.map(object).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
  const controls = runs.filter((run) => run.algorithm === "A0-full-catalog");
  const treatments = runs.filter((run) => run.algorithm !== "A0-full-catalog");
  if (controls.length !== 1 || treatments.length !== 1) throw new Error("experiment activation artifact must contain one control and one treatment run");
  const control = controls[0]!;
  const treatment = treatments[0]!;
  if (control.microRecall !== 1 || control.macroRecall !== 1 || control.deterministic !== true) {
    throw new Error("experiment activation FullCatalog control is invalid");
  }
  const encoder = object(document.encoder);
  const encoderFingerprints = [...new Set(runtimeEncoderFingerprints(manifest))];
  if (encoderFingerprints.length !== 1 || encoderFingerprints[0] !== encoder?.encoderFingerprint) {
    throw new Error("experiment activation encoder fingerprint does not match the treatment algorithm");
  }
  const batches = Array.isArray(treatment?.batchResults) ? treatment.batchResults.map(object).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
  const cacheReadiness = batches.length === 0 ? 0 : batches.filter((batch) => {
    const cache = object(batch.cache);
    return Number(cache?.passageHits) > 0 && Number(cache?.passageMisses) === 0;
  }).length / batches.length;
  const offlineGatesPassed = treatment?.hardGate === true &&
    Number(treatment.microRecall) >= 0.9 && Number(treatment.macroRecall) >= 0.9 &&
    Number(treatment.averageBatchCompression) > 0.8 && Number(treatment.p95BatchShortlistRatio) < 0.2 &&
    treatment.deterministic === true && Number(treatment.invalidKeys) === 0 && Number(treatment.privateKeys) === 0 &&
    Number(treatment.outOfShortlistAccepted) === 0 && Number(treatment.budgetExceededCases) === 0;
  const activation = object(document?.activation);
  const replayMatched = activation?.replayMatched === true;
  const worldContentHashes = Array.isArray(activation?.worldContentHashes)
    ? activation.worldContentHashes.filter((value): value is string => typeof value === "string").sort()
    : [];
  const eligibleWorlds = [...manifest.eligibility.worldContentHashes].sort();
  if (contentHash(worldContentHashes) !== contentHash(eligibleWorlds)) {
    throw new Error("experiment activation worlds do not match manifest eligibility");
  }
  if (typeof activation?.datasetManifestHash !== "string" || activation.datasetManifestHash.length === 0) {
    throw new Error("experiment activation dataset manifest hash is missing");
  }
  const datasetManifest = path.resolve(/* turbopackIgnore: true */ env.LIVINGWORLD_RETRIEVAL_DATASET_MANIFEST_PATH ??
    `benchmarks/action-compilation/fullcatalog-stabilized/v${String(document.datasetVersion)}/manifest.json`);
  const datasetManifestBytes = readFileSync(/* turbopackIgnore: true */ datasetManifest);
  const datasetManifestHash = sha256(datasetManifestBytes);
  if (datasetManifestHash !== activation.datasetManifestHash) {
    throw new Error(`experiment activation dataset manifest hash mismatch: expected ${activation.datasetManifestHash}, got ${datasetManifestHash}`);
  }
  const datasetDocument = object(JSON.parse(datasetManifestBytes.toString("utf8")) as unknown);
  const generation = object(datasetDocument?.generation);
  const expectedCases = Number(generation?.targetCases);
  if (!Number.isSafeInteger(expectedCases) || expectedCases < 1 ||
    Number(control.cases) !== expectedCases || Number(treatment.cases) !== expectedCases) {
    throw new Error("experiment activation artifact does not evaluate every frozen benchmark case");
  }
  if (!offlineGatesPassed) {
    throw new Error(
      "experiment activation artifact did not pass every offline retrieval gate: " +
      `micro=${String(treatment.microRecall)}, macro=${String(treatment.macroRecall)}, ` +
      `averageBatchCompression=${String(treatment.averageBatchCompression)}, ` +
      `p95BatchShortlistRatio=${String(treatment.p95BatchShortlistRatio)}`,
    );
  }
  if (cacheReadiness !== 1) throw new Error("experiment activation cache readiness is below 100%");
  if (!replayMatched) throw new Error("experiment activation artifact has no successful replay equivalence evidence");
  const recommendation = object(document.recommendation);
  if (recommendation?.status !== "candidate-selected" || recommendation.runId !== treatment.algorithm) {
    throw new Error("experiment activation artifact does not recommend its treatment run");
  }
  return {
    experimentId: manifest.id,
    experimentVersion: manifest.version,
    artifact,
    artifactHash,
    verifier: manifest.activationEvidence.verifier,
    offlineGatesPassed,
    cacheReadiness,
    replayMatched,
  };
}
