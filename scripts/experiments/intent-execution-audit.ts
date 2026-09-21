import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentActionProposal, SimulationState } from "../../src/engine/contracts/model";
import { contentHash } from "../../src/engine/models/model-audit";
import { agentIntentProgramSchema, inspectAgentIntentProgram, INTENT_PROGRAM_PREFIX } from "../../src/engine/benchmarks/step-efficiency/agent-intent-program";
import { IntentExecutionCursor } from "../../src/engine/benchmarks/step-efficiency/intent-execution-cursor";

/** Structural qualification of an explicitly selected historical 49-subject
 * source. This does not dispatch actions, call models, or measure gameplay. */
export function auditIntentExecutionSource(sourcePath: string) {
  const bytes = readFileSync(sourcePath);
  const envelope = JSON.parse(bytes.toString("utf8")) as {
    sourceHash: string;
    source: { state: SimulationState; actions: AgentActionProposal[]; definition: { contentHash: string } };
  };
  const { state, actions, definition } = envelope.source;
  assert.equal(contentHash(envelope.source), envelope.sourceHash, "frozen source hash changed");
  assert.equal(state.worldHash, definition.contentHash, "world source differs");
  assert.equal(actions.length, 49, "the complete source must retain 49 actions");
  assert.equal(new Set(actions.map(action => action.actorId)).size, 49, "source repeats an actor");
  const ordinaryActions: AgentActionProposal[] = [];
  const snapshots: ReturnType<IntentExecutionCursor["snapshot"]>[] = [];
  const nodeKinds: Record<string, number> = {}, frontierKinds: Record<string, number> = {};
  const programs = actions.flatMap(action => {
    assert.ok(state.agents[action.actorId], "action owner is absent");
    assert.equal(action.baseRevision, state.revision, "action revision differs");
    if (!action.rawText.startsWith(INTENT_PROGRAM_PREFIX)) {
      ordinaryActions.push(structuredClone(action));
      return [];
    }
    const program = agentIntentProgramSchema.parse(JSON.parse(action.rawText.slice(INTENT_PROGRAM_PREFIX.length)));
    const execution = new IntentExecutionCursor({ worldHash: state.worldHash, action: { ...action, means: null }, program });
    assert.equal(action.means, null, "program source means changed");
    const before = execution.snapshot(), restored = IntentExecutionCursor.restore(JSON.parse(JSON.stringify(before)));
    assert.deepEqual(restored.snapshot(), before, "serialized cursor changed");
    assert.deepEqual(before.source.action, action, "cursor dropped source action data");
    const frontier = restored.frontier();
    assert.deepEqual(frontier.map(work => work.nodeId).sort((a, b) => a - b),
      inspectAgentIntentProgram(program, action.targetIds.length).frontier.map(work => work.nodeId).sort((a, b) => a - b));
    for (const node of program.nodes) nodeKinds[node.kind] = (nodeKinds[node.kind] ?? 0) + 1;
    for (const work of frontier) {
      const node = program.nodes.find(node => node.nodeId === work.nodeId)!;
      assert.ok("targetIndices" in node);
      assert.deepEqual(work.targetIds, node.targetIndices.map(index => action.targetIds[index]));
      assert.ok(work.targetIds.every(id => state.agents[action.actorId]!.belief.localEntities[id]), "target is not in the owner's local perspective");
      assert.equal(work.issuedAction, null, "structural audit dispatched an action");
      frontierKinds[work.kind] = (frontierKinds[work.kind] ?? 0) + 1;
    }
    snapshots.push(before);
    return [{ actorId: action.actorId, sourceActionId: action.id, nodeCount: program.nodes.length, frontier }];
  });
  assert.equal(programs.length, 48, "the complete source must retain 48 NPC programs");
  assert.equal(ordinaryActions.length, 1, "the external player's action must remain ordinary prose");
  assert.notEqual(ordinaryActions[0]!.actorId, "player", "external human must be distinct from the original NPC named player");
  assert.equal(contentHash(envelope.source), envelope.sourceHash, "audit mutated the source");
  const report = {
    version: 1, kind: "intent-execution-structural-audit", sourceHash: envelope.sourceHash,
    sourceFileSha256: createHash("sha256").update(bytes).digest("hex"), worldHash: state.worldHash, revision: state.revision,
    scope: { subjects: actions.length, npcPrograms: programs.length, ordinaryPlayerActions: ordinaryActions.length },
    nodeKinds, frontierKinds, maxFrontierPerNpc: Math.max(...programs.map(row => row.frontier.length)),
    actualNewModelHttp: 0, worldCommits: 0, gameplayLatencyMs: null, programs, ordinaryActions,
    limits: "Structural source and restore qualification only. Pending nodes remain in snapshots. Frontier counts do not establish causal independence, semantic correctness, cost savings or player completion.",
  };
  return { report, snapshots };
}

const [sourcePath, outputDirectory, ...extra] = process.argv.slice(2);
if (!sourcePath || !outputDirectory || extra.length) throw new Error("usage: tsx scripts/experiments/intent-execution-audit.ts <frozen-source.json> <new-output-directory>");
const result = auditIntentExecutionSource(sourcePath);
mkdirSync(outputDirectory);
writeFileSync(path.join(outputDirectory, "report.json"), JSON.stringify(result.report, null, 2) + "\n", { flag: "wx" });
writeFileSync(path.join(outputDirectory, "snapshots.json"), JSON.stringify(result.snapshots, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...result.report, programs: undefined, ordinaryActions: undefined }, null, 2));
