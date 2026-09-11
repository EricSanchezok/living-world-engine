import { expect, it } from "vitest";
import { z } from "zod";
import { factorSharedBatchContexts, expandSharedBatchContexts, type SharedBatchContext } from "../../mechanics/shared-batch-context";
import type { StructuredModelRequest } from "../../models/model-provider";
import { contentHash } from "../../models/model-audit";
import { compactObservationActions, expandObservationActions, observationActionDictionaryRequest } from "./observation-action-dictionary";

function source(codec: SharedBatchContext["codec"] = "shared-json-v2") {
  return factorSharedBatchContexts([0, 1, 2].map(slot => {
    const shared = { actionRef: "ref:action:common", actorRef: "ref:entity:a", rawText: "Ask for information", targetRefs: [] };
    const local = { actionRef: "ref:action:same", actorRef: "ref:entity:b", rawText: "Discuss only after consent", targetRefs: [`ref:local:${slot}`], means: null };
    const assigned = slot === 1 ? [local, shared, local] : [shared, local, shared];
    return { task: { observer: slot }, state: { prose: { actionSet: { assigned: "Literal world data" } },
      actionSet: { assigned, available: assigned, initial: [], otherField: [slot] } },
    referenceCatalog: { candidates: [{ handle: "ref:shared", allowedUses: slot ? ["read"] : ["read", "cause"] }, { handle: `ref:local:${slot}` }] } };
  }), codec);
}

it("restores all slots, ordering, repeated occurrences, local differences and permissions exactly", () => {
  for (const codec of ["shared-json-v2", "shared-json-v3"] as const) {
    const original = source(codec), before = contentHash(original), compact = compactObservationActions(original);
    expect(compact.actionDictionary).toMatchObject({ records: expect.any(Array), sequences: expect.any(Array) });
    const dictionary = compact.actionDictionary as { records: unknown[] };
    expect(dictionary.records).toHaveLength(4);
    const restored = expandObservationActions(compact);
    expect(restored).toEqual(original);
    expect(expandSharedBatchContexts(restored)).toEqual(expandSharedBatchContexts(original));
    expect(contentHash(original)).toBe(before);
    // Copies across slots and repeated record occurrences remain independently owned.
    const contexts = expandSharedBatchContexts(restored) as Array<{ state: { actionSet: { assigned: Array<{ rawText: string }> } } }>;
    contexts[0]!.state.actionSet.assigned[0]!.rawText = "Changed";
    expect(contexts[0]!.state.actionSet.assigned[2]!.rawText).toBe("Ask for information");
    expect(contexts[1]!.state.actionSet.assigned[1]!.rawText).toBe("Ask for information");
  }
});

it("rejects altered record meanings, order, scope, invalid indices and unused dictionary entries", () => {
  type Dictionary = { records: Array<Record<string, unknown>>; sequences: number[][] };
  const original = compactObservationActions(source());
  for (const mutate of [
    (d: Dictionary) => { d.records[0]!.rawText = "Invented action"; },
    (d: Dictionary) => { d.records[1]!.targetRefs = ["ref:local:foreign"]; },
    (d: Dictionary) => { d.sequences[1]!.reverse(); d.sequences[1]!.push(0); },
    (d: Dictionary) => { d.sequences[1]![0] = -1; },
    (d: Dictionary) => { d.sequences[1]![0] = 0.5; },
    (d: Dictionary) => { d.sequences[1]![0] = d.records.length; },
    (d: Dictionary) => { d.records.push({ unused: true }); },
    (d: Dictionary) => { d.sequences.push([]); },
  ]) {
    const changed = structuredClone(original); mutate(changed.actionDictionary as Dictionary);
    expect(() => expandObservationActions(changed)).toThrow();
  }
  expect(() => compactObservationActions(original)).toThrow();
});

it("preserves output decoding and rejection while changing only the batch input representation", () => {
  const schema = z.object({ value: z.string() }).strict();
  const preprocessOutput = (raw: unknown) => ({ value: raw, symbolRepairs: [] });
  const request = { role: "observation-renderer", schemaName: "observation_projection_batch", profileId: "test", subjectId: "test", workloadId: "test", batchId: "test",
    system: "Source evidence contract", userPrompt: "Render", promptVersion: "test-v1", context: { state: source() }, schema,
    preprocessOutput, wireJsonSchema: z.toJSONSchema(schema), jsonObjectPostlude: "Retained evidence" } as StructuredModelRequest<z.infer<typeof schema>>;
  const candidate = observationActionDictionaryRequest(request);
  expect(candidate.schema).toBe(schema);
  expect(candidate.preprocessOutput).toBe(preprocessOutput);
  expect(candidate.wireJsonSchema).toBe(request.wireJsonSchema);
  expect(candidate.jsonObjectPostlude).toBe(request.jsonObjectPostlude);
  expect(candidate.schema.parse(candidate.preprocessOutput!({ value: "Evidence" }).value)).toEqual({ value: "Evidence" });
  expect(() => candidate.schema.parse({ value: "Evidence", invented: true })).toThrow();
  expect(() => observationActionDictionaryRequest(candidate)).toThrow();
  expect(observationActionDictionaryRequest({ ...request, schemaName: "observation_render" }).context).toBe(request.context);
});
