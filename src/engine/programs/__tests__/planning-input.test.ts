import { describe, expect, it } from "vitest";
import type { VersionedResource } from "../definition";
import type { JsonValue } from "../../runtime/json";
import { privatePlanningInput } from "../planning-input";

function sample(): Record<string, VersionedResource> {
  return { clock: { version: 0, value: 0 }, mechanics: { version: 0, value: { batteries: 2 } },
    evidence: { version: 0, value: [{ id: "a", step: 1, kind: "testimony", description: "Two batteries for one seal", sourceId: "peer" }] },
    claims: { version: 0, value: [{ id: "claim-a", evidenceIds: ["a"], subjectId: "peer", predicate: "offers", value: 2, stance: "believed" }] },
    observations: { version: 0, value: [{ revision: 1, step: 1, ownAction: null, observations: [{ summary: "Two batteries for one seal" }] }] } };
}
describe("private planning retry input", () => {
  it("retains delivery provenance in state without treating a fresh observation ID as new testimony", () => {
    const before = sample(), after = structuredClone(before);
    before.evidence!.value = [{ id: "a", step: 1, kind: "testimony", description: "Peer says: two batteries for one seal", sourceId: `rt:observation:${"a".repeat(64)}` }];
    after.evidence!.value = [{ id: "b", step: 2, kind: "testimony", description: "Peer says: two batteries for one seal", sourceId: `rt:observation:${"b".repeat(64)}` }];
    expect(privatePlanningInput(after)).toBe(privatePlanningInput(before));
  });
  it("does not renew expansion merely for a new copy of the same evidence or receipt description", () => {
    const before = sample(), after = structuredClone(before), original = structuredClone(before);
    after.clock = { version: 2, value: 2 };
    after.evidence = { version: 1, value: [...before.evidence!.value as JsonValue[], { id: "b", step: 2, kind: "testimony", description: "Two batteries for one seal", sourceId: "peer" }] };
    after["evidence:b"] = { version: 0, value: (after.evidence.value as JsonValue[])[1]! };
    after.claims = { version: 1, value: [{ id: "claim-b", evidenceIds: ["a", "b"], subjectId: "peer", predicate: "offers", value: 2, stance: "believed" }] };
    after["claim:claim-b"] = { version: 0, value: (after.claims.value as JsonValue[])[0]! };
    after.observations = { version: 1, value: [...before.observations!.value as JsonValue[], { revision: 2, step: 2, ownAction: null, observations: [{ summary: "Two batteries for one seal" }] }] };
    expect(privatePlanningInput(after)).toBe(privatePlanningInput(before));
    expect(before).toEqual(original); expect((after.evidence.value as JsonValue[]).length).toBe(2);
  });
  it.each(["mechanics", "speaker", "terms", "stance"])("renews the budget for changed %s", field => {
    const before = sample(), after = structuredClone(before);
    if (field === "mechanics") after.mechanics!.value = { batteries: 3 };
    if (field === "speaker") after.evidence!.value = [{ id: "b", step: 2, kind: "testimony", description: "Two batteries for one seal", sourceId: "another-peer" }];
    if (field === "terms") after.evidence!.value = [{ id: "b", step: 2, kind: "testimony", description: "One battery for one seal", sourceId: "peer" }];
    if (field === "stance") after.claims!.value = [{ id: "claim-b", evidenceIds: ["a"], subjectId: "peer", predicate: "offers", value: 2, stance: "disbelieved" }];
    expect(privatePlanningInput(after)).not.toBe(privatePlanningInput(before));
  });
});
