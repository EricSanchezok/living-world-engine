import { describe, expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { expandSharedRepairHandles, factorSharedRepairHandles } from "../shared-repair-handles";

const handles = Array.from({ length: 1719 }, (_, index) => `candidate_${index.toString(16).padStart(12, "0")}`);
function fixture() {
  return { execution: { revision: 12 }, referenceCatalog: { candidates: [{ candidateKey: handles[0] }] },
    task: { slots: Array.from({ length: 12 }, (_, slot) => ({ slot, action: { rawText: `Action ${slot}` },
      issues: [{ code: "reference.disallowed_use", path: ["dependencies", slot], allowedHandles: [...handles], reason: "Use the existing conflict candidates." }],
      previousAttempt: { value: null, unknown: [true, false, null] } })) } };
}

describe("shared repair handle evidence", () => {
  it("round trips the twelve-slot repair context without changing any slot or candidate", () => {
    const input = fixture(), before = contentHash(input);
    const encoded = factorSharedRepairHandles(input);
    expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(input).length / 5);
    expect(expandSharedRepairHandles(encoded)).toEqual(input);
    expect(contentHash(input)).toBe(before);
    expect(factorSharedRepairHandles(structuredClone(input))).toEqual(encoded);
  });

  it("shares repeated hints across multiple issues inside a singleton repair", () => {
    const input = fixture();
    input.task.slots = input.task.slots.slice(0, 1);
    const slot = input.task.slots[0]!;
    slot.issues.push({ ...structuredClone(slot.issues[0]!), path: ["assertions", 1] });
    const encoded = factorSharedRepairHandles(input);
    expect(encoded.repairHandleSets).toBeDefined();
    expect(expandSharedRepairHandles(encoded)).toEqual(input);
  });

  it("preserves distinct handle order, absent and null fields, and unrelated nested lists", () => {
    const input = fixture();
    input.task.slots[0]!.issues[0]!.allowedHandles.reverse();
    const mixed = { ...input, untouched: { allowedHandles: handles, optional: null } };
    const encoded = factorSharedRepairHandles(mixed);
    expect(expandSharedRepairHandles(encoded)).toEqual(mixed);
    expect(encoded.untouched).toEqual(mixed.untouched);
  });

  it("leaves initial, unique and small repair contexts in their original wire representation", () => {
    const input = fixture();
    input.task.slots = input.task.slots.slice(0, 1);
    expect(factorSharedRepairHandles(input)).toEqual(input);
    const initial = { task: { slots: [{ slot: 0, action: { rawText: "Wait." } }] } };
    expect(factorSharedRepairHandles(initial)).toEqual(initial);
    const small = { task: { slots: [{ issues: [{ allowedHandles: ["x"] }] }, { issues: [{ allowedHandles: ["x"] }] }] } };
    expect(factorSharedRepairHandles(small)).toEqual(small);
  });

  it("rejects dictionary and state binding corruption", () => {
    const encoded = factorSharedRepairHandles(fixture());
    const missing = JSON.parse(JSON.stringify(encoded));
    missing.repairHandleSets.sets = {};
    expect(() => expandSharedRepairHandles(missing)).toThrow("reference mismatch");
    const altered = JSON.parse(JSON.stringify(encoded));
    altered.task.slots[0].issues[0].path = ["different-slot"];
    expect(() => expandSharedRepairHandles(altered)).toThrow("binding changed");
    expect(() => factorSharedRepairHandles(encoded)).toThrow("already exists");
  });
});
