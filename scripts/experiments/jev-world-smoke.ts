import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createJevLiveRuntime } from "../../src/engine/benchmarks/jev/live-runtime";
import { loadWorldScript } from "../../src/script/world-loader";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { privateProgramEntityIds, privateProgramResources } from "../../src/engine/programs/private-resources";
import { ProgramInterpreter } from "../../src/engine/programs/interpreter";
import { DecisionRuntime } from "../../src/engine/programs/decision-runtime";
import { issueProgramAttempt } from "../../src/engine/events/attempt";
import { compileWorldProgram } from "../../src/engine/events/compiler";
import { adjudicateWorldPrograms, worldProgramDuration } from "../../src/engine/events/adjudication";
import { commitWorldEvent, createWorldEventCandidate } from "../../src/engine/events/kernel";
import { worldProgramSources, worldResources } from "../../src/engine/events/resources";
import { contentHash } from "../../src/engine/models/model-audit";
import { admitWorldProgram } from "../../src/engine/events/world-program";
import type { WorldCompilation } from "../../src/engine/events/compiler";

async function main() {
  const input = process.argv[2]; if (!input) throw new Error("usage: jev-world-smoke.ts <successful-program-probe.json>");
  const prior = JSON.parse(readFileSync(input, "utf8"));
  if (prior.result?.status !== "ready") throw new Error("the prior program must have passed admission");
  const runtime = createJevLiveRuntime(); const evidence: Record<string, unknown> = { phase: "world-kernel-development", sourceProgram: path.basename(input) };
  try {
    const world = loadWorldScript(path.resolve("worlds/blackmarsh/world"), { modelCatalog: loadModelCatalog(), seed: 1 });
    if (prior.worldHash !== world.contentHash) throw new Error("program probe is bound to a different world");
    const state = world.initialState, view = projectAgentPerspective(state, state.agents[prior.ownerId]!);
    const previous = prior.observations.findLast((row: { snapshot?: unknown }) => row.snapshot)?.snapshot;
    const interpreter = ProgramInterpreter.restore(previous, prior.result.program, new Set(privateProgramEntityIds(view)), new Map());
    const privateResources = privateProgramResources(view), resources = worldResources(state, world);
    const work = interpreter.work(privateResources.resources, 0).find(work => work.kind === "attempt");
    if (!work || work.kind === "predicate") throw new Error("no executable frontier in prior probe");
    const attempt = issueProgramAttempt(state, interpreter, work, privateResources.resources), registry = await runtime.registry.capture();
    const scope = { workloadId: "world-smoke", batchId: `world-smoke-${prior.ownerId}`, modelRegistrySnapshotHash: registry.hash,
      runtimeIdentity: { worldHash: world.contentHash, revision: state.revision } };
    evidence.attempt = attempt;
    const reuse = process.argv[3];
    const compiled: WorldCompilation = reuse ? JSON.parse(readFileSync(reuse, "utf8")).compilation
      : await compileWorldProgram(runtime.gateway, { ...scope, profileId: "creation-deepseek", invocationBase: 1,
        definition: world, state, resources, attempt, reason: "initial-coverage" }); evidence.compilation = compiled;
    if (compiled.status !== "ready") throw new Error(compiled.reason);
    if (contentHash(compiled.bound.attempt) !== contentHash(attempt) ||
      admitWorldProgram(compiled.bound.program.definition, worldProgramSources(world, state)).hash !== compiled.bound.program.hash) throw new Error("cached world compilation does not match current sources and attempt");
    evidence.reusedCompilation = Boolean(reuse);
    let ordinal = 1;
    const adjudication = await adjudicateWorldPrograms(new DecisionRuntime(runtime.gateway), [compiled.bound], resources, worldProgramSources(world, state), {
      ...scope, profileId: "decision-jev", fallbackProfileId: "decision-deepseek", nextInvocation: () => ordinal++,
    }); evidence.adjudication = adjudication;
    const atSeconds = worldProgramDuration(compiled.bound, resources);
    const candidate = createWorldEventCandidate(state, world, resources, [compiled.bound], adjudication, atSeconds); evidence.candidate = candidate;
    const committed = commitWorldEvent(state, world, resources, candidate, { earliestPendingSeconds: atSeconds, receipts: new Map() });
    evidence.receipt = committed.receipt; evidence.state = committed.state;
    for (const receipt of committed.receipt.programReceipts) interpreter.settle(receipt.id, new Map([[receipt.id, receipt]]), privateResources.resources);
    evidence.program = interpreter.snapshot(); evidence.completion = interpreter.completion;
    console.log(JSON.stringify({ status: "committed", owner: prior.ownerId, events: committed.receipt.eventIds.length,
      deliveries: candidate.deliveries, writes: committed.receipt.writes, atSeconds, completion: interpreter.completion }));
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error); console.error(evidence.failure); process.exitCode = 1;
  } finally {
    const file = path.join(runtime.root, `world-smoke-${prior.ownerId}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ ...evidence, budget: runtime.budget.summary }, null, 2));
    console.log(JSON.stringify({ evidence: file, cumulativeImplementationCalls: runtime.budget.summary.phases.trajectory.httpRequests,
      implementationCny: runtime.budget.summary.estimatedPeakNanoCny / 1e9 })); runtime.close("world-smoke");
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
