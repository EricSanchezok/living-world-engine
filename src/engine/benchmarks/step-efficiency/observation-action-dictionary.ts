import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { expandSharedBatchContexts, isSharedBatchContext, type SharedBatchContext } from "../../mechanics/shared-batch-context";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason: string): never => { throw new ModelConfigurationError(`observation action dictionary: ${reason}`); };
const instruction = loadPromptAsset("shared/observation-action-dictionary.md");
export const OBSERVATION_ACTION_DICTIONARY = `exact-action-sequences-v1@${contentHash(instruction).slice(0, 16)}`;
export const ACTION_DICTIONARY_CODEC = "shared-json-action-sequences-v1";
const actionKeys = ["assigned", "available", "initial"] as const;

/** Visit only the established action-set arrays, never similarly named world prose. */
function mapActionSets(batch: Value, map: (value: unknown) => unknown) {
  if (!object(batch.shared) || !Array.isArray(batch.slots)) return fail("missing shared envelope");
  const envelopes = [batch.shared, ...batch.slots.map(slot => object(slot) ? slot.delta : undefined)];
  for (const envelope of envelopes) {
    if (!object(envelope)) return fail("missing slot delta");
    const state = envelope.state;
    if (!object(state) || !Object.hasOwn(state, "actionSet")) continue;
    if (!object(state.actionSet)) return fail("invalid action set");
    for (const key of actionKeys) if (Object.hasOwn(state.actionSet, key)) state.actionSet[key] = map(state.actionSet[key]);
  }
}

/** Intern exact whole records and ordered sequences; actionRef is not a deduplication key. */
export function compactObservationActions(source: unknown): Value {
  if (!isSharedBatchContext(source) || Object.hasOwn(source, "actionDictionary") || Object.hasOwn(source, "sourceCodec")) return fail("invalid source codec");
  expandSharedBatchContexts(source);
  const batch = structuredClone(source) as unknown as Value;
  const records: Value[] = [], sequences: number[][] = [];
  const recordIds = new Map<string, number>(), sequenceIds = new Map<string, number>();
  mapActionSets(batch, value => {
    if (!Array.isArray(value) || value.some(record => !object(record))) return fail("expected complete action records");
    const sequence = value.map(record => {
      const key = contentHash(record);
      let id = recordIds.get(key);
      if (id === undefined) { id = records.length; records.push(record); recordIds.set(key, id); }
      return id;
    });
    const key = contentHash(sequence);
    let id = sequenceIds.get(key);
    if (id === undefined) { id = sequences.length; sequences.push(sequence); sequenceIds.set(key, id); }
    return { actionSequence: id };
  });
  return { ...batch, codec: ACTION_DICTIONARY_CODEC, sourceCodec: source.codec, actionDictionary: { records, sequences } };
}

/** Restore every occurrence before the original per-slot source and permission checks. */
export function expandObservationActions(value: unknown): SharedBatchContext {
  if (!object(value) || value.codec !== ACTION_DICTIONARY_CODEC || !isSharedBatchContext({ codec: value.sourceCodec }) ||
    !object(value.actionDictionary) || Object.keys(value.actionDictionary).sort().join(",") !== "records,sequences") return fail("invalid dictionary envelope");
  const { records, sequences } = value.actionDictionary;
  if (!Array.isArray(records) || records.some(record => !object(record)) || !Array.isArray(sequences) ||
    sequences.some(sequence => !Array.isArray(sequence) || sequence.some(id => !Number.isSafeInteger(id) || id < 0 || id >= records.length))) return fail("invalid record or sequence index");
  const restored = structuredClone(value);
  restored.codec = restored.sourceCodec;
  delete restored.sourceCodec;
  delete restored.actionDictionary;
  mapActionSets(restored, pointer => {
    if (!object(pointer) || Object.keys(pointer).join(",") !== "actionSequence" || !Number.isSafeInteger(pointer.actionSequence) ||
      (pointer.actionSequence as number) < 0 || (pointer.actionSequence as number) >= sequences.length) return fail("invalid sequence reference");
    return (sequences[pointer.actionSequence as number] as number[]).map(id => structuredClone(records[id]));
  });
  const batch = restored as unknown as SharedBatchContext;
  expandSharedBatchContexts(batch);
  if (contentHash(compactObservationActions(batch)) !== contentHash(value)) return fail("dictionary coverage or source binding changed");
  return batch;
}

/** Apply below observation batching and evidence layout; original output closures remain authoritative. */
export function observationActionDictionaryRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "observation-renderer" || request.schemaName !== "observation_projection_batch") return request;
  if (request.promptVersion.includes(OBSERVATION_ACTION_DICTIONARY) || request.contextLayout !== undefined) return fail("already applied or unsupported layout");
  if (!object(request.context)) return fail("missing context");
  const state = compactObservationActions(request.context.state);
  if (contentHash(expandObservationActions(state)) !== contentHash(request.context.state)) return fail("source changed");
  const system = [request.system, instruction].join("\n\n");
  return { ...request, context: { ...request.context, state }, system,
    promptVersion: `${request.promptVersion}/${OBSERVATION_ACTION_DICTIONARY}` };
}
