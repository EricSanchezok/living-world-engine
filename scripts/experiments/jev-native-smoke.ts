import { writeFileSync } from "node:fs";
import path from "node:path";
import { createJevLiveRuntime } from "../../src/engine/benchmarks/jev/live-runtime";
import { contentHash } from "../../src/engine/models/model-audit";
import type { DecisionBatch } from "../../src/engine/models/decision";

async function main() {
  const runtime = createJevLiveRuntime();
  try {
    const state = { agent: "courier", goal: "Deliver the sealed letter personally to the gate guard.",
      observations: ["The letter remains in my bag.", "I am in the inn.", "A companion offers to take it; I have not replied."] };
    const batch: DecisionBatch = { version: 1, view: { kind: "agent", agentId: "courier", projectionHash: contentHash(state) },
      programHash: contentHash("native-gateway-smoke-v1"), state, dependencies: { "courier:observations": 0 },
      questions: { next: { version: "1", instructions: "Which next action best advances the courier's explicit goal, given the observed state?",
        criteria: { go: "Carry the letter to the gate personally.", done: "Record the letter as delivered.", proxy: "Give the letter to the companion." },
        sources: ["goal:personal-delivery"] } } };
    const registry = await runtime.registry.capture();
    const results = [];
    for (const [index, profileId] of ["decision-jev", "decision-deepseek"].entries()) {
      const started = performance.now();
      const result = await runtime.gateway.decide({ workloadId: "native-smoke", batchId: `native-smoke-${profileId}`,
        profileId, subjectId: "courier", batch, modelRegistrySnapshotHash: registry.hash,
        runtimeIdentity: { worldHash: `sha256:${contentHash(state)}`, revision: 0 }, modelInvocation: index + 1 });
      results.push({ profileId, milliseconds: performance.now() - started, result });
      console.log(JSON.stringify({ profileId, choice: result.answers.next!.choice, usage: result.audit.invocations[0]!.tokenUsage }));
    }
    writeFileSync(path.join(runtime.root, `native-smoke-${Date.now()}.json`), JSON.stringify({ results, budget: runtime.budget.summary }, null, 2));
    if (results.some(result => result.result.answers.next!.choice !== "go")) throw new Error("native smoke did not satisfy the declared decision");
  } finally { runtime.close("native-smoke"); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
