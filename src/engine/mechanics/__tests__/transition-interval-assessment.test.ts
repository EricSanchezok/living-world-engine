import { expect, it } from "vitest";
import { loadPromptAsset } from "../../prompts";
import { contentHash } from "../../models/model-audit";
import { decodeTransitionIntervalAssessments, transitionIntervalWireSchema, transitionSourceTextSegments, transitionPendingSourceText, verifyTransitionIntervalAssessment } from "../transition-interval-assessment";

const source = { action: { rawText: "After the ceremony, meet the keeper and deliver two bags." },
  sourceTextSegments: transitionSourceTextSegments("After the ceremony, meet the keeper and deliver two bags."),
  inputFacts: { "ref:fact:ceremony/~": { value: { kind: "text", value: "in-progress" } }, readings: [2, 3] },
  participantEntities: { keeper: { placementRef: "ref:placement:hall" } }, temporalBoundary: { toElapsedSeconds: 10 },
  slotContext: { state: { canonicalTruth: { weather: { active: "storm" } } } } };
const assessment = () => ({ currentWork: "Waiting for the ceremony; both bags remain here.", pendingSourceRanges: [{ first: 0, last: 1 }],
  gates: [{ sourceSegmentIndices: [0], requirement: "The ceremony must end first", state: "pending",
    evidencePointers: ["/inputFacts/ref:fact:ceremony~1~0/value"] }] });

it("binds source text and existing structured, scalar and escaped-pointer evidence", () => {
  const value = assessment(), before = contentHash(source);
  expect(verifyTransitionIntervalAssessment(value, source)).toBe(true);
  expect(verifyTransitionIntervalAssessment({ ...value, gates: [] }, source)).toBe(true);
  const gate = value.gates[0]!;
  expect(verifyTransitionIntervalAssessment({ ...value, gates: [{ ...gate, state: "unknown", evidencePointers: [
    "/temporalBoundary/toElapsedSeconds", "/participantEntities/keeper/placementRef",
    "/inputFacts/readings/0", "/slotContext/state/canonicalTruth/weather/active",
  ] }] }, source)).toBe(true);
  expect(contentHash(source)).toBe(before);
});

it("rejects foreign facts, copied values, malformed escapes and missing evidence", () => {
  const value = assessment(), gate = value.gates[0]!;
  for (const change of [
    { sourceSegmentIndices: [100] }, { sourceSegmentIndices: [] }, { sourceSegmentIndices: [0, 0] }, { sourceSegmentIndices: [1, 0] },
    { sourceText: "The ceremony is over" }, { evidencePointers: [] },
    { evidence: [{ pointer: "/inputFacts/readings/0", observed: 2 }] },
    ...["/inputFacts/foreign/value", "/inputFacts/ref:fact:ceremony~2/value", "/action/rawText",
      "/inputFacts/toString", "/inputFacts/readings/length", "/inputFacts/readings/00", "/slotContext/anotherSlot/state"]
      .map(pointer => ({ evidencePointers: [pointer] })),
  ]) expect(verifyTransitionIntervalAssessment({ ...value, gates: [{ ...gate, ...change }] }, source)).toBe(false);
  expect(verifyTransitionIntervalAssessment({ gates: [] }, source)).toBe(false);
  expect(verifyTransitionIntervalAssessment({ ...value, pendingWork: ["invented new action"] }, source)).toBe(false);
  const rawText = "first;second;third", extended = { ...source, action: { rawText }, sourceTextSegments: transitionSourceTextSegments(rawText) };
  expect(verifyTransitionIntervalAssessment({ ...value, gates: [{ ...gate, sourceSegmentIndices: [0, 1, 2] }] }, extended)).toBe(true);
  expect(verifyTransitionIntervalAssessment({ ...value, gates: [{ ...gate, sourceSegmentIndices: [0, 2] }] }, extended)).toBe(false);
});

it("restores only model-authored currentWork, retains effects and keeps invalid assessments visible for rejection", () => {
  const original = { outcomes: [{ actionIndex: 0, intervalAssessment: assessment(), status: "continuing" }],
    operations: [{ kind: "original-operation", payload: { unchanged: true } }] };
  const before = contentHash(original), decoded = decodeTransitionIntervalAssessments(original, [source]);
  expect(decoded).toEqual({ ...original, outcomes: [{ actionIndex: 0, summary: assessment().currentWork, status: "continuing" }] });
  expect(contentHash(original)).toBe(before);
  for (const row of [
    { actionIndex: 0, summary: "Legacy summary without assessment" },
    { actionIndex: 0, intervalAssessment: assessment(), summary: "conflicting summary" },
    { actionIndex: 0, intervalAssessment: { ...assessment(), gates: [{ ...assessment().gates[0], sourceSegmentIndices: [999] }] } },
  ]) {
    const result = decodeTransitionIntervalAssessments({ outcomes: [row] }, [source]) as { outcomes: object[] };
    expect(result.outcomes[0]).toHaveProperty("intervalAssessment");
  }
});

it.each(["before，after；then。", "When ready, go!\nKeep 3.5 kg; don't drop it.", "no punctuation", "🙂 é\n\"quoted, value\""])("preserves every source character and ordered citation identity: %s", rawText => {
  const segments = transitionSourceTextSegments(rawText);
  expect(segments.map(segment => segment.text).join("")).toBe(rawText);
  expect(segments.map(segment => segment.segmentIndex)).toEqual(segments.map((_, index) => index));
  const forged = { ...source, sourceTextSegments: [{ segmentIndex: 0, text: "forged" }] };
  expect(verifyTransitionIntervalAssessment(assessment(), forged)).toBe(false);
});

it("replaces only the wire summary schema and keeps all other constraints including references", () => {
  const schema = { properties: { outcomes: { type: "array", minItems: 43, items: { type: "object", additionalProperties: false,
    properties: { actionIndex: { type: "integer" }, summary: { type: "string" }, firstAssertion: { $ref: "#/definitions/causalAssertion" } },
    required: ["actionIndex", "summary", "firstAssertion"] } }, operations: { type: "array" } }, definitions: { causalAssertion: { type: "object" } } };
  const before = contentHash(schema), adapted = transitionIntervalWireSchema(schema) as typeof schema;
  expect(adapted.properties.outcomes.items.properties).not.toHaveProperty("summary");
  expect(adapted.properties.outcomes.items.properties).toHaveProperty("intervalAssessment");
  expect(adapted.properties.outcomes.items.required).toEqual(["actionIndex", "intervalAssessment", "firstAssertion"]);
  expect(adapted.definitions).toEqual(schema.definitions);
  expect(adapted.properties.operations).toEqual(schema.properties.operations);
  expect(contentHash(schema)).toBe(before);
  expect(() => transitionIntervalWireSchema(adapted)).toThrow();
});

it("expands pending ranges without changing conditions, negation, quantity or order", () => {
  const rawText = "Until dawn, do not attack; send one boat, then decide whether to ask for help.";
  expect(transitionPendingSourceText([{ first: 0, last: 1 }, { first: 2, last: 3 }], rawText)).toEqual([
    "Until dawn, do not attack;", " send one boat, then decide whether to ask for help.",
  ]);
  for (const ranges of [[{ first: 2, last: 1 }], [{ first: 0, last: 99 }], [{ first: -1, last: 0 }],
    [{ first: 1, last: 2 }, { first: 2, last: 3 }], [{ first: 2, last: 3 }, { first: 0, last: 1 }]]) {
    expect(transitionPendingSourceText(ranges, rawText)).toBeNull();
    expect(verifyTransitionIntervalAssessment({ ...assessment(), pendingSourceRanges: ranges }, source)).toBe(false);
  }
  expect(transitionPendingSourceText([], rawText)).toEqual([]);
  const nullable = { ...source, inputFacts: { known: null } };
  expect(verifyTransitionIntervalAssessment({ ...assessment(), gates: [{ ...assessment().gates[0], evidencePointers: ["/inputFacts/known"] }] }, nullable)).toBe(true);
});

it("keeps the actual prompt demonstrations source-bound and complete without defaulting all work to waiting", () => {
  const examples = [...loadPromptAsset("shared/transition-current-interval.md").matchAll(/```json\n([\s\S]*?)\n```/gu)]
    .map(match => JSON.parse(match[1]!) as { source: typeof source; intervalAssessment: ReturnType<typeof assessment> });
  expect(examples).toHaveLength(3);
  for (const example of examples) {
    expect(example.source.sourceTextSegments).toEqual(transitionSourceTextSegments(example.source.action.rawText));
    expect(verifyTransitionIntervalAssessment(example.intervalAssessment, example.source)).toBe(true);
    expect(transitionPendingSourceText(example.intervalAssessment.pendingSourceRanges, example.source.action.rawText)?.join("")).toBe(example.source.action.rawText);
  }
  expect(examples[0]!.intervalAssessment.gates.every(gate => gate.state === "pending")).toBe(true);
  expect(examples[2]!.intervalAssessment.gates).toEqual([]);
});
