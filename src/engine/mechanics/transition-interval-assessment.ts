import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError } from "../models/model-provider";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const sourceRangeSchema = z.strictObject({ first: z.number().int().nonnegative().safe(), last: z.number().int().nonnegative().safe() });
const assessmentSchema = z.strictObject({
  currentWork: z.string().min(1),
  gates: z.array(z.strictObject({ sourceSegmentIndices: z.array(z.number().int().nonnegative().safe()).min(1), requirement: z.string().min(1),
    state: z.enum(["satisfied", "pending", "unknown"]), evidencePointers: z.array(z.string().min(1)).min(1) })),
  pendingSourceRanges: z.array(sourceRangeSchema),
});

/** Punctuation only determines citation boundaries; every original character stays in order. */
export function transitionSourceTextSegments(rawText: string) {
  const segments = rawText.split(/(?<=[，。；！？,;!?\n])/u).filter(text => text.length > 0)
    .map((text, segmentIndex) => ({ segmentIndex, text }));
  if (segments.map(segment => segment.text).join("") !== rawText) throw new ModelConfigurationError("transition source segmentation changed text");
  return segments;
}

/** Resolve exact source passages without deciding whether they are complete or relevant. */
export function transitionPendingSourceText(value: unknown, rawText: string): string[] | null {
  const parsed = z.array(sourceRangeSchema).safeParse(value);
  if (!parsed.success) return null;
  const segments = transitionSourceTextSegments(rawText);
  if (parsed.data.some((range, index) => range.first > range.last || !segments[range.last] ||
    (index > 0 && range.first <= parsed.data[index - 1]!.last))) return null;
  return parsed.data.map(range => segments.slice(range.first, range.last + 1).map(segment => segment.text).join(""));
}

/** Pointer resolution checks source fidelity only, never the entailment of a semantic claim. */
export function verifyTransitionIntervalAssessment(value: unknown, source: ObjectValue): boolean {
  const parsed = assessmentSchema.safeParse(value);
  if (!parsed.success || !object(source.action) || typeof source.action.rawText !== "string") return false;
  const segments = transitionSourceTextSegments(source.action.rawText);
  if (contentHash(source.sourceTextSegments) !== contentHash(segments) || !transitionPendingSourceText(parsed.data.pendingSourceRanges, source.action.rawText)) return false;
  for (const gate of parsed.data.gates) {
    if (gate.sourceSegmentIndices.some((index, position) => !segments[index] || (position > 0 && index !== gate.sourceSegmentIndices[position - 1]! + 1))) return false;
    for (const pointer of gate.evidencePointers) {
      if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return false;
      const keys = pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
      if (!["inputFacts", "participantEntities", "placementAncestors", "temporalBoundary", "slotContext"].includes(keys[0]!)) return false;
      let observed: unknown = source;
      for (const key of keys) {
        if (Array.isArray(observed) && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= observed.length)) return false;
        if ((!object(observed) && !Array.isArray(observed)) || !Object.hasOwn(observed, key)) return false;
        observed = (observed as ObjectValue)[key];
      }
    }
  }
  return true;
}

export function transitionIntervalWireSchema(schema: unknown): ObjectValue {
  if (!object(schema) || !object(schema.properties) || !object(schema.properties.outcomes) || !object(schema.properties.outcomes.items)) {
    throw new ModelConfigurationError("transition interval schema is missing indexed outcomes");
  }
  const result = structuredClone(schema), item = ((result.properties as ObjectValue).outcomes as ObjectValue).items as ObjectValue;
  if (!object(item.properties) || !object(item.properties.summary) || item.properties.summary.type !== "string" ||
    Object.hasOwn(item.properties, "intervalAssessment") || !Array.isArray(item.required) || !item.required.includes("summary")) {
    throw new ModelConfigurationError("transition interval summary contract changed");
  }
  delete item.properties.summary;
  const text = { type: "string", minLength: 1 };
  const assessment = { type: "object", additionalProperties: false, required: ["gates", "currentWork", "pendingSourceRanges"], properties: {
    gates: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["sourceSegmentIndices", "requirement", "state", "evidencePointers"], properties: {
        sourceSegmentIndices: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 0 } }, requirement: text,
        state: { type: "string", enum: ["satisfied", "pending", "unknown"] },
        evidencePointers: { type: "array", minItems: 1, items: text } } } },
    currentWork: text, pendingSourceRanges: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["first", "last"], properties: { first: { type: "integer", minimum: 0 }, last: { type: "integer", minimum: 0 } } } },
  } };
  item.properties = { actionIndex: item.properties.actionIndex, intervalAssessment: assessment, ...item.properties };
  item.required = (item.required as string[]).map(key => key === "summary" ? "intervalAssessment" : key);
  return result;
}

/** Keep invalid rows intact so the canonical parser rejects only their original slot. */
export function decodeTransitionIntervalAssessments(value: unknown, sources: ObjectValue[]): unknown {
  if (!object(value) || !Array.isArray(value.outcomes)) return value;
  return { ...value, outcomes: value.outcomes.map(row => {
    if (!object(row) || !Number.isSafeInteger(row.actionIndex) || typeof row.actionIndex !== "number" ||
      row.actionIndex < 0 || !sources[row.actionIndex] || Object.hasOwn(row, "summary") ||
      !verifyTransitionIntervalAssessment(row.intervalAssessment, sources[row.actionIndex]!)) {
      // A legacy summary alone must not bypass the required assessment. This
      // null sentinel is an invalid wire field, never an admitted semantic value.
      return object(row) ? { ...row, intervalAssessment: row.intervalAssessment ?? null } : row;
    }
    const { intervalAssessment, ...canonical } = row;
    return { ...canonical, summary: (intervalAssessment as { currentWork: string }).currentWork };
  }) };
}
