import { describe, expect, it } from "vitest";
import { JEV_QUALIFICATION_PROTOCOL, assertQualificationClock, semanticWorldHash } from "./jev-qualification-protocol";
import { E3_TASKS } from "./step-e3-tasks";

describe("frozen Jev qualification protocol", () => {
  it("keeps all E3 inputs, balanced three-arm canaries and independent confirmation seeds", () => {
    expect(JEV_QUALIFICATION_PROTOCOL.tasks).toEqual(E3_TASKS);
    expect(JEV_QUALIFICATION_PROTOCOL.trials).toHaveLength(33);
    expect(new Set(JEV_QUALIFICATION_PROTOCOL.trials.map(value => value.seed)).size).toBe(33);
    expect(JEV_QUALIFICATION_PROTOCOL.trials.slice(0, 3).map(value => value.order[0])).toEqual(["A", "B", "C"]);
    for (const trial of JEV_QUALIFICATION_PROTOCOL.trials) expect([...trial.order].sort()).toEqual(["A", "B", "C"]);
    expect(JEV_QUALIFICATION_PROTOCOL.tasks.reduce((sum, task) => sum + task.inputs.length, 0)).toBe(18);
  });
  it("permits producer schema bindings but detects changed world semantics", () => {
    const world = { schema_version: 14, model_profiles: { perception: "truth" }, rules: [{ id: "core-resolution", version: "2.0.0" }],
      actor: { modelProfiles: { mind: "agent" }, goal: "obtain evidence", quantity: 2 } };
    expect(semanticWorldHash(world)).toBe(semanticWorldHash({ ...world, schema_version: 15, model_profiles: { decision: "jev" },
      rules: [{ id: "core-resolution", version: "3.0.0" }], actor: { ...world.actor, modelProfiles: { creation: "deepseek" } } }));
    expect(semanticWorldHash(world)).not.toBe(semanticWorldHash({ ...world, actor: { ...world.actor, quantity: 3 } }));
  });
  it("accepts same-time control and positive physical commits, rejecting gaps and fabricated time", () => {
    const before = { revision: 1, step: 1, elapsedSeconds: 5 };
    expect(() => assertQualificationClock(before, { ...before, revision: 2 }, [])).not.toThrow();
    expect(() => assertQualificationClock(before, { revision: 2, step: 2, elapsedSeconds: 7 }, [2])).not.toThrow();
    expect(() => assertQualificationClock(before, { ...before, revision: 3 }, [])).toThrow("noncontiguous");
    expect(() => assertQualificationClock(before, { revision: 2, step: 2, elapsedSeconds: 7 }, [])).toThrow("control");
    expect(() => assertQualificationClock(before, { ...before, revision: 2 }, [0])).toThrow("physical");
  });
});
