import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { OnsetPerceptionInput } from "../../algorithms/roles";
import { contentHash } from "../../models/model-audit";
import { ScriptedModelProvider, type ScriptedModelHandler } from "../../testing/model-provider";
import { TruthEngine } from "../truth-engine";
import { selectTemporalBoundary } from "../temporal";

function check(proposalKey: string, stakes = "Whether the keeper sees the raised hand behind the translucent screen.") {
  return { proposalKey, actorRef: "ref:entity:keeper", targetRef: "ref:entity:player", ratingRef: "ref:rating:resolve:keeper",
    difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:onset-channel" } },
    mode: "normal", visibility: "full", stakes,
    causes: [{ kind: "action", ref: "ref:action:raise-hand" }, { kind: "law", ref: "ref:law:onset-channel" }] };
}

function done(context: unknown) {
  const state = (context as { state: { committedCheckRequests: Array<{ checkRef: string }> } }).state;
  return { kind: "done", reports: [{ targetIndex: 0, kind: "no_stimulus", reason: "A required perception check failed.",
    evidence: [{ kind: "law", ref: "ref:law:onset-channel" }], checkRefs: state.committedCheckRequests.map(check => check.checkRef) }] };
}

function fixture(handler: ScriptedModelHandler, repairAttempts = 0) {
  const provider = new ScriptedModelProvider(handler, undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 0, modelCatalog: provider.catalog });
  definition.laws.push({ id: "onset-channel", severity: "hard", text: "Perceiving the raised hand behind this screen requires a normal easy check with the keeper's resolve. A failed check reveals no hand. The same uncertainty is never rerolled." });
  definition.initialState.lawIds.push("onset-channel");
  const input: OnsetPerceptionInput = { definition, state: structuredClone(definition.initialState), identityOwner: "onset", groundings: [],
    actions: [{ id: "raise-hand", actorId: "player", baseRevision: 0, rawText: "I raise a hand behind the screen.", goal: "Raise my hand", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "raise-hand" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  return { provider, input, run: () => new TruthEngine(provider, { repairAttempts }).perceiveOnset(input, { workloadId: "recommit", batchId: "onset",
    runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } }) };
}

it.each(["renamed", "visibility-and-cause-order"])("rejects a committed check repeated as %s before another draw, then repairs using the fixed failure", async mode => {
  let calls = 0;
  const f = fixture(({ context }) => {
    calls++;
    if (calls > 2) return done(context);
    const request = check(calls === 1 ? "original" : "renamed");
    if (calls === 2 && mode !== "renamed") { request.visibility = "result_only"; request.causes.reverse(); }
    return { kind: "request_checks", requests: [request] };
  }, 1);
  const before = contentHash(f.input), result = await f.run();
  expect(result.requests).toHaveLength(1);
  expect(result.checks).toMatchObject([{ dice: [4], total: 7, succeeded: false }]);
  expect(result.rng.draws).toBe(1); expect(result.commitmentRounds).toHaveLength(1);
  expect(result.receipts[0]).toMatchObject({ kind: "no_stimulus", checkIds: [result.requests[0]!.id] });
  expect(f.provider.requests[2]!.context).toMatchObject({ repair: { issues: [{ code: "perception.repeated_check" }] },
    state: { committedCheckRequests: [expect.anything()], checkResults: [{ succeeded: false }] } });
  expect(contentHash(f.input)).toBe(before);
});

it("rejects two differently named copies in the same batch without committing either", async () => {
  const f = fixture(() => ({ kind: "request_checks", requests: [check("a"), check("b")] })), before = contentHash(f.input);
  await expect(f.run()).rejects.toThrow("repeats");
  expect(f.provider.requests).toHaveLength(1);
  expect(contentHash(f.input)).toBe(before);
});

it("preserves distinct uncertainty descriptions within one observer/source pair", async () => {
  let calls = 0;
  const f = fixture(({ context }) => ++calls === 1 ? { kind: "request_checks", requests: [
    check("hand", "Whether the keeper sees the hand behind the screen."),
    check("ring", "Whether the keeper sees the ring on that hand through the screen."),
  ] } : done(context));
  const result = await f.run();
  expect(result.requests).toHaveLength(2); expect(result.rng.draws).toBe(2);
  expect(result.requests.map(request => request.stakes)).toEqual([
    "Whether the keeper sees the hand behind the screen.", "Whether the keeper sees the ring on that hand through the screen.",
  ]);
});
