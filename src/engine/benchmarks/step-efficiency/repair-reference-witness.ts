import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

const instruction = loadPromptAsset("shared/repair-reference-witness.md");
export const REPAIR_REFERENCE_WITNESS = `repair-reference-witness-v1@${contentHash(instruction).slice(0, 16)}`;
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): Row => object(value) ? value : {};

/** Repeat exact source records beside the rejected candidate's references, without selecting a repair. */
export function repairReferenceWitnessRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair"].includes(request.schemaName)) return request;
  const context = record(request.context), repair = record(context.repair), state = record(context.state);
  if (context.repair === null || context.repair === undefined) return request;
  if (request.promptVersion.includes(REPAIR_REFERENCE_WITNESS) || request.jsonObjectPostlude !== undefined) {
    throw new ModelConfigurationError("repair reference witness requires an unoccupied singleton postlude");
  }
  const truth = record(state.canonicalTruth);
  if (!object(truth.entities) || !object(truth.meters) || !object(truth.ratings) || !object(repair.previousOutput)) {
    throw new ModelConfigurationError("repair reference witness requires complete canonical source and candidate");
  }
  const entities = truth.entities, meters = truth.meters, ratings = truth.ratings;
  const mentioned = new Map<string, Array<Array<string | number>>>();
  const walk = (value: unknown, path: Array<string | number>): void => {
    if (typeof value === "string" && /^ref:(entity|meter|rating):/.test(value)) {
      const paths = mentioned.get(value) ?? []; paths.push(path); mentioned.set(value, paths);
    } else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, index]));
    else if (object(value)) for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
  };
  walk(repair.previousOutput, ["repair", "previousOutput"]);
  const entityRefs = new Set<string>();
  const references = [...mentioned].map(([ref, candidatePaths]) => {
    const collection = ref.startsWith("ref:entity:") ? entities : ref.startsWith("ref:meter:") ? meters : ratings;
    const present = Object.hasOwn(collection, ref);
    if (present && ref.startsWith("ref:entity:")) entityRefs.add(ref);
    const owner = record(collection[ref]).entityRef;
    if (present && typeof owner === "string" && Object.hasOwn(entities, owner)) entityRefs.add(owner);
    return { ref, candidatePaths, present, ...(present ? { record: structuredClone(collection[ref]) } : {}) };
  });
  const rows = [...entityRefs].map(entityRef => ({ entityRef, record: structuredClone(entities[entityRef]),
    meters: Object.entries(meters).filter(([, value]) => record(value).entityRef === entityRef)
      .map(([meterRef, value]) => ({ meterRef, record: structuredClone(value) })),
    ratings: Object.entries(ratings).filter(([, value]) => record(value).entityRef === entityRef)
      .map(([ratingRef, value]) => ({ ratingRef, record: structuredClone(value) })),
  }));
  const witness = { contract: REPAIR_REFERENCE_WITNESS, sourceContextHash: contentHash(context),
    candidateHash: contentHash(repair.previousOutput), issues: structuredClone(repair.issues), references, entities: rows };
  const jsonObjectPostlude = [instruction, JSON.stringify(witness)].join("\n\n");
  return { ...request, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${REPAIR_REFERENCE_WITNESS}@${contentHash(witness).slice(0, 16)}` };
}
