import { expect, it } from "vitest";
import { probeBoundaryFrontier } from "./boundary-frontier-probe";

it.each([1, 10] as const)("measures the 49-Agent player frontier with a %i-second recurring action", async duration => {
  const result = await probeBoundaryFrontier(duration);
  expect(result).toMatchObject({ agents: 49, modelAgents: 48, externalPlayers: 1 });
  expect(result.rows).toHaveLength(duration === 1 ? 10 : 1);
  expect(result.rows[0].newActors).toHaveLength(49);
  expect(result.rows[0].adjudicatedActors).toHaveLength(49);
  expect(result.rows[0].plans).toBe(49);
  for (const row of result.rows) {
    expect(row.replayMatches).toBe(true);
    expect(row.checks).toBe(0);
    expect(row.backgroundSchedules).toHaveLength(47);
    for (const activity of row.backgroundSchedules) expect(activity).toMatchObject({
      status: "active", nextBoundaryAtSeconds: 100, completionAtSeconds: 100,
    });
    expect(row.player.completionAtSeconds).toBe(10);
    expect(row.player.status).toBe(row.time < 10 ? "active" : "completed");
  }
  if (duration === 1) {
    expect(result.rows.map(row => row.time)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const row of result.rows.slice(1, -1)) {
      expect(row.newActors).toEqual(["keeper"]);
      expect(row.adjudicatedActors).toEqual(["keeper"]);
      expect(row.plans).toBe(1);
      expect(row.player.nextBoundaryAtSeconds).toBe(10);
      expect(row.requests.find(request => request.role === "agent-mind")?.slots).toBe(1);
      expect(row.requests.some(request => request.schema === "causal_verification")).toBe(true);
    }
    const last = result.rows.at(-1)!;
    expect(last.newActors).toEqual(["keeper"]);
    expect(last.adjudicatedActors).toEqual(["keeper", "player"]);
    expect(last.plans).toBe(2);
  }
  expect(result.rows.at(-1)).toMatchObject({ time: 10, ongoing: 47, player: { status: "completed" } });
}, 60_000);

it("distinguishes one goal Activity's checkpoints from repeated new NPC actions", async () => {
  const result = await probeBoundaryFrontier(1, "checkpoint");
  expect(result.rows).toHaveLength(10);
  const original = result.rows[0].keeperActivities;
  expect(original).toHaveLength(1);
  expect(original[0].status).toBe("active");
  for (const row of result.rows) {
    expect(row.keeperActivities).toEqual(original);
    expect(row.replayMatches).toBe(true);
    expect(row.player.completionAtSeconds).toBe(10);
    expect(row.requests.some(request => request.role === "agent-mind")).toBe(false);
  }
  for (const row of result.rows.slice(1)) {
    expect(row.newActors).toEqual([]);
    expect(row.adjudicatedActors).toEqual(row.time < 10 ? ["keeper"] : ["keeper", "player"]);
    expect(row.requests.some(request => request.role === "action-compilation")).toBe(false);
    expect(row.requests.some(request => request.role === "action-grounding")).toBe(true);
  }
  expect(result.rows.at(-1)).toMatchObject({ time: 10, ongoing: 48, player: { status: "completed" } });
}, 60_000);
