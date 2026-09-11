import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { ObservationRenderer } from "../../src/engine/cognition/observation-renderer";
import type { ObservationRenderingInput } from "../../src/engine/algorithms/roles";
import type { CommittedStep, SimulationState } from "../../src/engine/contracts/model";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import { loadWorldScript } from "../../src/script/world-loader";
import { stepEfficiencyAlgorithmRef } from "../operations/step-efficiency-playtest";
import { registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { WorldExecutionAlgorithmRegistry } from "../../src/engine/runtime/execution";

export async function preparePendingObservationPreflight() {
  const root = path.resolve(STEP_E2_PROTOCOL.root);
  const sourceBytes = readFileSync(path.join(root, "runs/trajectory-e2-19/step-1-evidence.json"));
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceHash !== "1ea02611a79bc26f76a198ffc6262fbcc01248587c42bb9ecd46075112e0a358") throw new Error("historical source evidence changed");
  const evidence = JSON.parse(sourceBytes.toString()) as { source: SimulationState; checkpoint: SimulationState; committed: CommittedStep };
  const worldRoot = path.join(root, "variants/short-action-checkpoints-01");
  const catalog = loadModelCatalog(path.join(worldRoot, "model-catalog.json"));
  const definition = loadWorldScript(path.join(worldRoot, "worlds/blackmarsh/world"), { seed: STEP_E2_PROTOCOL.seed, modelCatalog: catalog });
  if (definition.initialState.worldHash !== evidence.source.worldHash) throw new Error("world snapshot mismatch");
  const step = evidence.committed;
  const input: ObservationRenderingInput = { definition, state: evidence.source, actions: step.actions,
    observerIds: step.observations.filter(packet => packet.kind === "outcome").map(packet => packet.observerId),
    identityOwner: "offline-pending-observation", temporalState: step.temporalState,
    proposal: { baseRevision: step.baseRevision, operations: step.operations, outcomes: step.outcomes,
      mechanicInvocations: step.mechanicInvocations, events: step.events, observations: [], decisionRequests: step.decisionRequests },
  };
  const inputHash = contentHash(input);
  const provider = new ScriptedModelProvider(() => ({ summary: "离线占位：此观察仍需要模型处理。", introductions: [], apparentClaims: [], sourceEventRefs: [] }), catalog, false);
  const rendered = await new ObservationRenderer(provider, 2, true).render(input, { workloadId: "offline-pending-world", batchId: "offline-pending-step",
    runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } });
  if (contentHash(input) !== inputHash) throw new Error("projection mutated source input");
  const modelObservers = new Set(provider.requests.map(request => (request.context as {
    state: { observationSlots: Array<{ observer: { agentRef: string } }> };
  }).state.observationSlots[0]!.observer.agentRef.replace(/^ref:agent:/u, "")));
  const projected = rendered.packets.filter(packet => !modelObservers.has(packet.observerId));
  for (const packet of projected) {
    const action = input.actions.find(action => action.actorId === packet.observerId);
    if (!action || !packet.summary.endsWith(JSON.stringify(action.rawText)) || packet.apparentClaims.length || packet.introductions.length || packet.sourceEventIds.length) {
      throw new Error("direct packet escaped source-bound progress contract");
    }
  }
  const candidate = stepEfficiencyAlgorithmRef({ sourceBoundObservations: true });
  if (!registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).has(candidate)) throw new Error("candidate is not registered");
  return { packets: projected, report: {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHash, inputHash,
    worldHash: input.state.worldHash, sourceStateHash: contentHash(input.state), referenceCompositionManifestHash: candidate.manifestHash,
    actualHttp: 0, totalObservers: input.observerIds.length, projectedObservers: projected.map(packet => packet.observerId),
    modelObservers: [...modelObservers], syntheticModelRequests: provider.requests.length, placeholderPacketsDiscarded: rendered.packets.length - projected.length,
    sourceUnchanged: true, originalIntentPreserved: true,
    interpretation: "Reconstructed recorded state/transition through the real renderer, not the exact historical planning invocation or a new committed game step. Only direct packets are retained; required model slots used synthetic placeholders. No HTTP usage, semantic clearance of upstream resolution, latency or actual cost reduction is established.",
  } };
}

async function main() {
  if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== "prepare") throw new Error("usage: step-pending-observation-preflight.ts [prepare]");
  const result = await preparePendingObservationPreflight();
  if (!process.argv[2]) {
    if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked code before freezing evidence");
    const directory = path.resolve(STEP_E2_PROTOCOL.root, "evidence/pending-observation-v1", result.report.commit);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "packets.json.gz"), gzipSync(JSON.stringify(result.packets)), { flag: "wx" });
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(result.report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify(result.report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
