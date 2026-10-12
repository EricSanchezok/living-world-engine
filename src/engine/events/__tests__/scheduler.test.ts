import { describe, expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { EventScheduler, jointActionComponents, type ActionDependencies } from "../scheduler";

const hash = contentHash;
describe("local event scheduling", () => {
  it("keeps the earliest unresolved event as a barrier and restores without redispatching completed work", () => {
    const scheduler = new EventScheduler();
    const later = scheduler.schedule({ atSeconds: 10, subjectId: "b", kind: "world", inputHash: hash("b"), payload: { work: "b" } });
    const early = scheduler.schedule({ atSeconds: 3, subjectId: "a", kind: "world", inputHash: hash("a"), payload: { work: "a" } });
    expect(scheduler.frontier().map(event => event.id)).toEqual([early]);
    expect(() => scheduler.acknowledge([later], 10)).toThrow("canonical frontier");
    scheduler.acknowledge([early], 3);
    const restored = new EventScheduler(3, JSON.parse(JSON.stringify(scheduler.snapshot())));
    expect(restored.frontier().map(event => event.id)).toEqual([later]);
    expect(() => restored.acknowledge([early], 3)).toThrow();
    const tampered = scheduler.snapshot(); tampered.pending[0]!.payload = { changed: true };
    expect(() => new EventScheduler(3, tampered)).toThrow("checksum");
  });
  it("wakes only owners of changed dependencies and cancels superseded deadlines", () => {
    const scheduler = new EventScheduler(), initial = { reply: { version: 0, value: null }, clock: { version: 0, value: 0 } };
    scheduler.subscribe("a", initial, ["reply"], [hash("work")], 10);
    scheduler.subscribe("b", initial, ["reply"], [], null);
    expect(scheduler.notify("a", { ...initial, clock: { version: 1, value: 1 } })).toBeNull();
    const updated = { ...initial, reply: { version: 1, value: "No" } };
    const wake = scheduler.notify("a", updated)!;
    expect(scheduler.notify("a", updated)).toBe(wake);
    expect(scheduler.frontier().map(event => event.subjectId)).toEqual(["a"]);
    scheduler.acknowledge([wake], 0); scheduler.subscribe("a", updated, ["reply"], [hash("work")], 20);
    expect(scheduler.nextTime).toBe(20);
    expect(scheduler.receipt("b", hash("work"), hash("receipt"))).toBeNull();
    const receipt = scheduler.receipt("a", hash("work"), hash("receipt"))!;
    expect(scheduler.frontier().map(event => event.id)).toEqual([receipt]);
  });
  it("detects no-progress cycles across intervening frontier states and restart", () => {
    const scheduler = new EventScheduler();
    expect(scheduler.beginEvaluation("a", hash("input"), hash("A"), hash("progress-0"))).toBe(true);
    expect(scheduler.beginEvaluation("a", hash("input"), hash("B"), hash("progress-0"))).toBe(true);
    const restored = new EventScheduler(0, scheduler.snapshot());
    expect(restored.beginEvaluation("a", hash("input"), hash("A"), hash("progress-0"))).toBe(false);
    expect(restored.beginEvaluation("a", hash("input"), hash("A"), hash("progress-1"))).toBe(true);
    expect(restored.beginEvaluation("b", hash("input"), hash("A"), hash("progress-0"))).toBe(true);
  });
  it("joins transitive resource and dialogue dependencies while retaining independent work", () => {
    const action = (id: string, reads: string[], writes: string[], targets: string[] = []): ActionDependencies => ({ id, actorEntityId: id, targetEntityIds: targets, reads, writes });
    const actions = [action("a", [], ["quantity:shared"]), action("b", ["quantity:shared"], ["fact:agreement"]),
      action("c", ["fact:agreement"], []), action("d", ["fact:unrelated"], []), action("e", [], [], ["d"])];
    expect(jointActionComponents(actions).map(group => group.map(action => action.id))).toEqual([["a", "b", "c"], ["d", "e"]]);
    expect(jointActionComponents([action("a", ["facts"], []), action("b", [], ["fact:x"])]).map(group => group.length)).toEqual([2]);
  });
});
