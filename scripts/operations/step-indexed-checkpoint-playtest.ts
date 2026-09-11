import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { RESOLUTION_SOURCE_ROLE_INSTRUCTION } from "../../src/engine/mechanics/resolution-source-role-contract";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { INDEXED_REVIEWED_PLANNING_PIPELINE, INDEXED_REVIEWED_PLANNING_PROMPT_VERSION } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { admissionRequestEvidence } from "../experiments/step-runtime-admission-probe";
import { loadPromptAsset } from "../../src/engine/prompts";
import { prepareCheckpointWorld } from "../experiments/step-checkpoint-world";
import { prepareCanonicalTransitionPreflight } from "../experiments/step-canonical-transition-preflight";
import { prepareOwnershipReview, scoreOwnershipReview } from "../experiments/step-plan-review-ownership-probe";
import { assertStepEfficiencyInstrumentation, runStepEfficiencyPlaytest, type StepEfficiencyVariant } from "./step-efficiency-playtest";

interface InitialReviewWireEvidence {
  historicalRequest: Record<string, unknown>;
  currentRequest: Record<string, unknown>;
  historicalTransport: { id: string; body: unknown; bodyHash: string };
  currentBody: string;
}

export function assertOwnershipDiagnostic(report: Record<string, unknown>, manifest: Record<string, unknown>,
  wire?: InitialReviewWireEvidence) {
  const frozen = Object.fromEntries(Object.keys(manifest).map(key => [key, report[key]]));
  let equivalence: NonNullable<StepEfficiencyVariant["truthTransportReviews"]>[number]["initialRequestEquivalence"];
  if (report.initialPhysicalRequestHash !== manifest.initialPhysicalRequestHash && wire) {
    const previousVersion = wire.historicalRequest.promptVersion;
    const expectedVersion = typeof previousVersion === "string" && previousVersion.endsWith(":physical-cardinality-no-example-v1")
      ? previousVersion.replace(/:physical-cardinality-no-example-v1$/u, ":physical-cardinality-slot-repair-v2") : null;
    if (!expectedVersion || wire.currentRequest.promptVersion !== expectedVersion ||
      contentHash(wire.historicalRequest) !== report.initialPhysicalRequestHash ||
      contentHash(wire.currentRequest) !== manifest.initialPhysicalRequestHash ||
      contentHash({ ...wire.historicalRequest, promptVersion: expectedVersion }) !== contentHash(wire.currentRequest) ||
      wire.historicalTransport.id !== `${report.trialId}-http-001` ||
      contentHash(wire.historicalTransport.body) !== wire.historicalTransport.bodyHash ||
      wire.currentBody !== JSON.stringify(wire.historicalTransport.body)) {
      throw new Error("initial review HTTP equivalence is not proven");
    }
    equivalence = { historicalPhysicalRequestHash: String(report.initialPhysicalRequestHash),
      currentPhysicalRequestHash: String(manifest.initialPhysicalRequestHash),
      bodyHash: wire.historicalTransport.bodyHash, scope: "first-response-only" };
    frozen.initialPhysicalRequestHash = manifest.initialPhysicalRequestHash;
  }
  if (contentHash(frozen) !== contentHash(manifest) || !scoreOwnershipReview(
    report.labels as Parameters<typeof scoreOwnershipReview>[0], report as Parameters<typeof scoreOwnershipReview>[1]).eligible) {
    throw new Error("frozen source-intent diagnostic has not passed");
  }
  return equivalence;
}

async function captureInitialReviewWire(prepared: Awaited<ReturnType<typeof prepareOwnershipReview>>, root: string) {
  let currentBody: string | undefined;
  let captures = 0;
  const gateway = createModelGateway(prepared.catalog,
    { [prepared.catalog.account("deepseek-api").api_key_env]: "offline-equivalence-only" }, {
      maxTransportAttempts: 1,
      registry: { catalog: prepared.catalog, capture: async hash => {
        if (hash && hash !== prepared.snapshot.hash) throw new ModelConfigurationError("equivalence registry drift");
        return prepared.snapshot;
      }, refresh: options => prepared.registry.refresh(options), status: () => prepared.registry.status() },
      fetchForAccount: () => async (_input, init) => {
        if (++captures !== 1 || typeof init?.body !== "string") throw new ModelConfigurationError("invalid offline equivalence capture");
        currentBody = init.body;
        throw new ModelConfigurationError("offline equivalence body captured without network");
      },
    });
  try { await gateway.generateStructured(prepared.physicalRequest); }
  catch (error) { if (currentBody === undefined || captures !== 1) throw error; }
  if (currentBody === undefined) throw new Error("initial review HTTP body was not captured");
  const trialId = prepared.manifest.trialId;
  return {
    historicalRequest: JSON.parse(gunzipSync(readFileSync(path.join(root, "runs", trialId, "request-1.json.gz"))).toString()),
    currentRequest: admissionRequestEvidence(prepared.physicalRequest),
    // Experiment transport records contain bodies only, never authentication headers.
    historicalTransport: JSON.parse(readFileSync(path.join(root, "http", `${trialId}-http-001`, "request.json"), "utf8")),
    currentBody,
  } satisfies InitialReviewWireEvidence;
}

export function assertMechanicalTransitionDiagnostic(report: Record<string, unknown>, request: unknown, commit: string) {
  if (report.commit !== commit || report.pipelineFingerprint !== INDEXED_REVIEWED_PLANNING_PROMPT_VERSION ||
    report.sourceHash !== "94449d84514493f039d659e9dd5c72cf589ac2acc29e7e9f7e9f116b1de13934" ||
    report.canonicalHash !== "ae90d7f4fbbaa8b3246b35c722683bba7ecd54932b1c74782f2fc8db65303ef4" ||
    report.slots !== 12 || report.actions !== 43 || report.fixtureCalls !== 1 || report.actualHttp !== 0 ||
    report.mechanicalOnly !== true || report.researchInterval !== false || report.fixtureAuditUsageDiscarded !== true ||
    report.requestHash !== contentHash(request)) throw new Error("current complete mechanical transition preflight is required");
}

export function assertSourceRoleDiagnostic(root: string) {
  const directory = path.join(root, "runs/probes-e2-source-role-01");
  const expected = {
    "manifest.json": "0d5fe4bc6e0c686a930b72cf4ecae65cbc2bbcdcac2e653bb4b76621620a2ba4",
    "report.json": "a74c5e2d142fcc96395184a813772daa50073602d3211a46f914da74c2d5fb46",
    "source-review.json": "9a0a1a6c245707c4b6876dd275f406f3084cd87819a56b00085de6949a351e02",
  };
  for (const [file, hash] of Object.entries(expected)) {
    if (createHash("sha256").update(readFileSync(path.join(directory, file))).digest("hex") !== hash) {
      throw new Error("closed source-role diagnostic evidence changed");
    }
  }
  if (contentHash(RESOLUTION_SOURCE_ROLE_INSTRUCTION) !== "ebadb691dd50aa2a8492c49662b276bf44f47fa3ffd46a7b49dd87c4b2557c36") {
    throw new Error("source-role instruction differs from the paired diagnostic");
  }
  return { trialId: "probes-e2-source-role-01", reportHash: expected["report.json"], preflightHash: expected["manifest.json"],
    sourceReviewHash: expected["source-review.json"], hashAlgorithm: "sha256-file-bytes",
    interpretation: "One-case mechanical improvement and limited source review only; later behavior remains untested." };
}

export function assertSparseArrayDiagnostic(root: string) {
  const directory = path.join(root, "runs/probes-e2-sparse-arrays-01");
  const expected = {
    "manifest.json": "29fb2d33a4fa2a5725f5bd7099197473f2d1ac5280d5362f761b278fa076215e",
    "report.json": "3ca3cb5bac71486c9cd207012850ba96c26da751283b34e21224db492bf290a8",
    "source-review.json": "517e17ecee42805247f008d35222b8ab69ca4a26c3adda478fc6a5107bcdb7a5",
  };
  for (const [file, hash] of Object.entries(expected)) {
    if (createHash("sha256").update(readFileSync(path.join(directory, file))).digest("hex") !== hash) {
      throw new Error("closed sparse-array diagnostic evidence changed");
    }
  }
  if (contentHash(loadPromptAsset("shared/canonical-sparse-arrays.md")) !== "3339a1fc6c7a973b9d70b787ae807b317e06ed98c672f665e6273bae18bafba2") {
    throw new Error("sparse instruction differs from the paired diagnostic");
  }
  return { trialId: "probes-e2-sparse-arrays-01", reportHash: expected["report.json"], preflightHash: expected["manifest.json"],
    sourceReviewHash: expected["source-review.json"], hashAlgorithm: "sha256-file-bytes",
    interpretation: "One-case formal admission only. Full semantics remain unknown; actual cognition and completion require committed-state review." };
}

export async function prepareIndexedCheckpointVariant(trialId: string): Promise<StepEfficiencyVariant> {
  const root = path.resolve(STEP_E2_PROTOCOL.root);
  if (!/^(trajectory|confirmation)-e2-\d{2}$/u.test(trialId) || existsSync(path.join(root, "runs", trialId))) throw new Error("fresh integrated trajectory identity required");
  const sourceRole = assertSourceRoleDiagnostic(root);
  const sparseArrays = assertSparseArrayDiagnostic(root);
  const directory = path.join(root, "runs/probes-e2-indexed-planning-01");
  const mechanicalManifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const mechanicalReport = JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8"));
  if (contentHash(mechanicalManifest) !== "75ed9b7ffcdcdd4d24efd508e3f161375c120f1e5ee1cec3ca2f805da8786742" ||
    contentHash(mechanicalReport) !== "e3e6316addbe29fd23c4477dc0b6f4069b20e655b8c4d9711b678ca1457bb729" ||
    mechanicalReport.status !== "completed" || mechanicalReport.decision !== "eligible-for-source-semantic-review-no-comparative-claim") throw new Error("full indexed mechanical qualification changed");
  for (const [id, hash] of [["045", "194040c2fda78f25c45649728f7aa8adf952d17d6272925e2b8e53647c8e0dde"],
    ["003", "90d1c28fd3c46709dc95bb42f8c110f1ba619588a14b802b77bc385cfeba29e2"]]) {
    const result = JSON.parse(gunzipSync(readFileSync(path.join(directory, `${id}-I-result.json.gz`))).toString());
    if (contentHash(result) !== hash || !result.result.complete) throw new Error("full source mechanical result changed");
  }
  const rejected = readFileSync(path.join(root, "runs/review-e2-indexed-045/report.json"));
  if (createHash("sha256").update(rejected).digest("hex") !== "e7d404fec9399a21fd72852be292af895431e35f701f8241342767d9f1a9858a" ||
    JSON.parse(rejected.toString()).verdict !== "reject") throw new Error("historical indexed rejection must remain intact");
  const prepared = await prepareOwnershipReview("C"); prepared.registry.stopBackgroundRefresh();
  const reviewReport = JSON.parse(readFileSync(path.join(root, "runs", prepared.manifest.trialId, "report.json"), "utf8"));
  const initialRequestEquivalence = assertOwnershipDiagnostic(reviewReport, prepared.manifest,
    reviewReport.initialPhysicalRequestHash === prepared.manifest.initialPhysicalRequestHash
      ? undefined : await captureInitialReviewWire(prepared, root));
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const transitionDirectory = path.join(root, "evidence/mechanical-transition-v2", currentCommit);
  const transitionReport = JSON.parse(readFileSync(path.join(transitionDirectory, "report.json"), "utf8"));
  const transitionRequest = JSON.parse(gunzipSync(readFileSync(path.join(transitionDirectory, "request.json.gz"))).toString());
  assertMechanicalTransitionDiagnostic(transitionReport, transitionRequest, currentCommit);
  const canonicalDirectory = path.join(root, "evidence/canonical-transition-v1", currentCommit);
  const canonicalReport = JSON.parse(readFileSync(path.join(canonicalDirectory, "report.json"), "utf8"));
  const canonicalRequests = JSON.parse(gunzipSync(readFileSync(path.join(canonicalDirectory, "requests.json.gz"))).toString());
  const canonical = await prepareCanonicalTransitionPreflight();
  if (contentHash(canonicalReport) !== contentHash(canonical.report) || contentHash(canonicalRequests) !== contentHash(canonical.bodies)) throw new Error("current canonical source/wire proof changed");
  const checkpoint = prepareCheckpointWorld();
  return { dataRoot: path.join(checkpoint.destination, "game-data", trialId),
    catalogPath: path.join(checkpoint.destination, "model-catalog.json"), worldsRoot: path.join(checkpoint.destination, "worlds"),
    manifestHash: contentHash(checkpoint.manifest), groundingProfileId: "truth-deepseek", nonthinkingBaseline: true, sourceInventory: true,
    compilation: "source-owned-visible-choice-v1", resolutionRepresentation: "resolution-dependent-fields-v1", truthTransport: "shared-state-first-v1",
    planningPipeline: INDEXED_REVIEWED_PLANNING_PIPELINE, observationRepairBatching: true, truthFlushBoundary: "post-promise-v1",
    resolutionAdmissionEvidence: { trialId: mechanicalManifest.trialId, reportHash: contentHash(mechanicalReport), preflightHash: contentHash(mechanicalManifest) },
    truthTransportReviews: [sourceRole, sparseArrays, { trialId: prepared.manifest.trialId, reportHash: contentHash(reviewReport), preflightHash: contentHash(prepared.manifest),
      ...(initialRequestEquivalence ? { initialRequestEquivalence } : {}) },
      { trialId: "offline-mechanical-transition-v2", reportHash: contentHash(transitionReport), preflightHash: contentHash(transitionRequest) },
      { trialId: "offline-canonical-transition-v1", reportHash: contentHash(canonicalReport), preflightHash: contentHash(canonicalRequests) }],
    label: "New integrated full48-Agent/232-entity checkpoint-world diagnostic. The prospective truth configuration collects ready ordered commitment continuations with the post-promise-v1 flush boundary, preserving existing grouping and slot limits. The prospective observation configuration enables the existing slot-local repair batching contract and tail placement; offline equivalence of logical slot inputs does not establish model success or gameplay savings. Source-indexed physical planning and source-intent logical review are pinned. Candidate version5 retains source-role exclusivity and adds the prospectively declared sparse empty-array representation to canonical initial/repair transitions; its one-case formal admission leaves cognition and completion semantics unknown pending actual state review; it retains mechanical indexed transition output, nonempty assertion encoding and lossless evidence/catalog layouts, and shares the action-to-state evidence view with canonical single-request transitions. Canonical output counts/reference domains are source-bound, assertion schema definitions are losslessly shared, and invented empty examples are omitted. It excludes research intervalAssessment generation and the unqualified logical-tail experiment. The current-commit full12-slot/43-action historical fixture proves mechanical source/field preservation only; its semantic rejection remains intact. Real downstream causal verification, observation validation and existing bounded repair are part of this diagnostic, followed by independent final source-state review. The historical045 source review remains rejected, not re-reviewed or overridden. Twelve independent authored development controls passed; they do not certify open semantics. Every fresh runtime plan must pass actual formal/semantic gates before committing. Inspect every source action and real effect after each commit, veto premature success, misattribution and no-effect non-progress; three credible steps plus fresh confirmation remain required. Keep disabled thinking, original batch/context cardinality and bounded recovery; charge all actual calls. This combined diagnostic cannot attribute comparative efficiency to one change." };
}

async function main() {
  assertStepEfficiencyInstrumentation();
  const [command, trialId, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || !trialId || extra.length) throw new Error("usage: step-indexed-checkpoint-playtest.ts prepare|run trajectory-e2-NN|confirmation-e2-NN");
  await runStepEfficiencyPlaytest(await prepareIndexedCheckpointVariant(trialId));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
