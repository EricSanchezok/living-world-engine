import { expect, it } from "vitest";
import { decodeObservationTuples, encodeObservationTuples } from "./observation-output-tuples";
import { scoreObservationPrefix } from "./observation-prefix-probe";

const output = { slots: [{ slot: 0, result: { summary: "门口传来声音", introductions: [
  { localEntity: { proposalKey: "gate", name: "门", description: "石门", status: "observed" }, canonicalEntityRef: "ref:entity:gate" },
], apparentClaims: [
  { subjectRef: { proposalKey: "gate" }, predicate: "heard", value: { kind: "text", value: "Footsteps" }, description: "声音不证明任何人已抵达" },
  { subjectRef: "ref:local_entity:viewer::self", predicate: "near", value: { kind: "local_entity", entityRef: { proposalKey: "gate" } }, description: "身旁" },
], sourceEventRefs: ["ref:event:footsteps"] } }] };
const bindings = [{ slot: 0, observerRef: "ref:agent:viewer", localRefs: ["ref:local_entity:viewer::self"], entityRefs: ["ref:entity:gate"], eventRefs: ["ref:event:footsteps"] }];

it("preserves full typed values, unicode, evidence, introductions and slot identity in both directions", () => {
  const wire = encodeObservationTuples(output);
  expect(decodeObservationTuples(wire)).toEqual(output);
  expect(encodeObservationTuples(decodeObservationTuples(wire))).toEqual(wire);
  expect(scoreObservationPrefix(JSON.stringify(decodeObservationTuples(wire)), bindings).schemaCoverageReferences).toBe(true);
});

it("rejects missing or extra positions and fields rather than supplying default evidence", () => {
  const mutations: Array<(result: unknown[]) => void> = [
    (result) => { result.pop(); },
    (result) => { result.push([]); },
    (result) => { (result[2] as unknown[][])[0]!.pop(); },
    (result) => { (result[2] as unknown[][])[0]!.push("extra"); },
    (result) => { ((result[2] as unknown[][])[0]![2] as Record<string, unknown>).invented = true; },
  ];
  for (const mutate of mutations) {
    const wire = structuredClone(encodeObservationTuples(output));mutate(wire.slots[0]!.result);
    expect(() => decodeObservationTuples(wire)).toThrow();
  }
  const wire = encodeObservationTuples(output);
  expect(() => decodeObservationTuples({ slots: [{ ...wire.slots[0], extra: true }] })).toThrow();
});

it("leaves unavailable evidence invalid after structural expansion", () => {
  const invalid = structuredClone(output);invalid.slots[0]!.result.sourceEventRefs = ["ref:event:invented"];
  const wire = encodeObservationTuples(invalid);
  expect(scoreObservationPrefix(JSON.stringify(decodeObservationTuples(wire)), bindings).schemaCoverageReferences).toBe(false);
});
