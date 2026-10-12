import { writeFileSync } from "node:fs";
import path from "node:path";
import { createJevLiveRuntime } from "../../src/engine/benchmarks/jev/live-runtime";
import { loadWorldScript } from "../../src/script/world-loader";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { compileAgentProgram } from "../../src/engine/programs/compiler";
import { privateProgramEntityIds, privateProgramResources, privateProgramSources, resourceValues } from "../../src/engine/programs/private-resources";
import { ProgramInterpreter } from "../../src/engine/programs/interpreter";
import { DecisionRuntime, resolveProgramPredicates } from "../../src/engine/programs/decision-runtime";
import type { JsonValue } from "../../src/engine/runtime/json";

async function main() {
  const runtime = createJevLiveRuntime();
  try {
    const world = loadWorldScript(path.resolve("worlds/blackmarsh/world"), { modelCatalog: loadModelCatalog(), seed: 1 });
    const ownerId = process.argv[2] ?? "hamdir";
    const agent = world.initialState.agents[ownerId]; if (!agent) throw new Error("unknown diagnostic Agent");
    const perspective = projectAgentPerspective(world.initialState, agent);
    const goals = Object.values(perspective.character.goals).filter(goal => goal.status === "active").sort((a, b) => b.priority - a.priority);
    const goal = goals[0]; if (!goal) throw new Error("Agent has no active goal to compile");
    const resources = privateProgramResources(perspective), registry = await runtime.registry.capture();
    const scope = { workloadId: "program-smoke", batchId: `program-smoke-${ownerId}`, modelRegistrySnapshotHash: registry.hash,
      runtimeIdentity: { worldHash: world.contentHash, revision: 0 } };
    const result = await compileAgentProgram(runtime.gateway, { ...scope, profileId: "creation-deepseek", invocationBase: 1,
      ownerId, goalId: goal.id, intent: goal.description, reason: "initial-coverage", perspective: JSON.parse(JSON.stringify(perspective)) as JsonValue,
      resources: resourceValues(resources.resources), sources: privateProgramSources(perspective), goalIds: goals.map(goal => goal.id),
      entityIds: privateProgramEntityIds(perspective) });
    const observations: unknown[] = [];
    if (result.status === "ready") {
      const interpreter = new ProgramInterpreter(result.program, `diagnostic-${ownerId}`, result.parameters, new Set(privateProgramEntityIds(perspective)));
      const decisions = new DecisionRuntime(runtime.gateway); let ordinal = 1;
      for (let round = 0; round < 8; round++) {
        if (interpreter.work(resources.resources, 0).every(work => work.kind !== "predicate")) break;
        const resolution = await resolveProgramPredicates(decisions, interpreter, resources.resources, 0, {
          ...scope, profileId: "decision-jev", fallbackProfileId: "decision-deepseek", nextInvocation: () => ordinal++,
        });
        observations.push(resolution);
        if (!resolution.decisions.length && !resolution.mechanicalEvidence.length) break;
      }
      observations.push({ status: interpreter.status, completion: interpreter.completion,
        frontier: interpreter.work(resources.resources, 0), subscriptions: interpreter.subscriptions(resources.resources, 0), snapshot: interpreter.snapshot() });
    }
    const file = path.join(runtime.root, `program-smoke-${ownerId}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ worldHash: world.contentHash, ownerId, goalId: goal.id, result, observations, budget: runtime.budget.summary }, null, 2));
    console.log(JSON.stringify({ status: result.status, ownerId, goalId: goal.id, evidence: file,
      calls: runtime.budget.summary.phases.trajectory.httpRequests, estimatedCny: runtime.budget.summary.estimatedPeakNanoCny / 1e9 }));
    if (result.status === "failed") { console.error(result.reason); process.exitCode = 1; }
  } finally { runtime.close("program-smoke"); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
