import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../models/model-provider";

const label = "尚未确认：";
const instruction = `\n\nObservation claim encoding: select epistemicStatus before the other fields of every apparentClaims entry. Use asserted only for a supported appearance with its exact value. A Boolean false denies the proposition; none asserts absence. Neither means unknown. For an unresolved proposition choose unconfirmed, copy its subjectRef and predicate, and describe what is not established in description. The unconfirmed branch has no value field. The engine will preserve that complete description as both a text value and description, prefixed with ${JSON.stringify(label)}. Do not claim certainty beyond the evidence. All existing output fields, observer permissions and source rules still apply.`;
export const OBSERVATION_CLAIM_ENCODING = `explicit-unconfirmed-claims-v1@${contentHash({ label, instruction }).slice(0, 16)}`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`observation claim encoding: ${message}`); };
const invalid = (message: string, path: (string | number)[] = []): never => {
  throw new z.ZodError([{ code: "custom", path, message: `observation claim encoding: ${message}` }]);
};

function decodeDraft(value: unknown, path: (string | number)[]): unknown {
  if (!object(value) || !Array.isArray(value.apparentClaims)) return invalid("missing apparentClaims", path);
  return { ...value, apparentClaims: value.apparentClaims.map((entry, index) => {
    const at = [...path, "apparentClaims", index];
    if (!object(entry)) return invalid("invalid claim", at);
    const { epistemicStatus, ...claim } = entry;
    if (epistemicStatus === "asserted") {
      if (Object.keys(claim).sort().join(",") !== "description,predicate,subjectRef,value") return invalid("incomplete asserted claim", at);
      return structuredClone(claim);
    }
    if (epistemicStatus !== "unconfirmed" || Object.keys(claim).sort().join(",") !== "description,predicate,subjectRef" || typeof claim.description !== "string") return invalid("unconfirmed claim must have no value", at);
    if (!claim.description.trim()) return invalid("missing unresolved proposition", [...at, "description"]);
    const description = label + claim.description;
    return { ...structuredClone(claim), description, value: { kind: "text", value: description } };
  }) };
}

/** The declared wire branch determines materialization; no prose is classified. */
export function decodeObservationClaims(value: unknown, batch: boolean): unknown {
  if (!batch) return decodeDraft(value, []);
  if (!object(value) || !Array.isArray(value.slots)) return invalid("missing slots");
  return { ...value, slots: value.slots.map((slot, index) => {
    if (!object(slot)) return invalid("invalid slot", ["slots", index]);
    return { ...slot, result: decodeDraft(slot.result, ["slots", index, "result"]) };
  }) };
}

/** Preserve every canonical assertion, including intentionally negative values. */
export function encodeObservationClaims(value: unknown, batch: boolean): unknown {
  const encode = (draft: unknown): unknown => {
    if (!object(draft) || !Array.isArray(draft.apparentClaims)) return invalid("missing canonical claims");
    return { ...draft, apparentClaims: draft.apparentClaims.map(claim => {
      if (!object(claim) || Object.hasOwn(claim, "epistemicStatus")) return invalid("invalid canonical claim");
      return { epistemicStatus: "asserted", ...structuredClone(claim) };
    }) };
  };
  if (!batch) return encode(value);
  if (!object(value) || !Array.isArray(value.slots)) return invalid("missing canonical slots");
  return { ...value, slots: value.slots.map(slot => {
    if (!object(slot)) return invalid("invalid canonical slot");
    return { ...slot, result: encode(slot.result) };
  }) };
}

export function observationClaimEncodingRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "observation-renderer" || !["observation_render", "observation_projection_batch"].includes(request.schemaName)) return request;
  if (request.preprocessOutput || request.promptVersion.includes(OBSERVATION_CLAIM_ENCODING)) return fail("unexpected existing output codec");
  const batch = request.schemaName === "observation_projection_batch";
  const wire = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  let draft: Record<string, unknown> = wire;
  if (batch) {
    const slots = object(wire.properties) ? wire.properties.slots : undefined;
    const item = object(slots) ? slots.items : undefined;
    const result = object(item) && object(item.properties) ? item.properties.result : undefined;
    if (!object(result)) return fail("missing physical observation schema");
    draft = result;
  }
  const claims = object(draft.properties) ? draft.properties.apparentClaims : undefined;
  const claim = object(claims) ? claims.items : undefined;
  if (!object(claims) || !object(claim) || !object(claim.properties) || claim.additionalProperties !== false ||
    Object.keys(claim.properties).sort().join(",") !== "description,predicate,subjectRef,value" ||
    !Array.isArray(claim.required) || [...claim.required].sort().join(",") !== "description,predicate,subjectRef,value") return fail("unexpected claim schema");
  const known = structuredClone(claim), unknown = structuredClone(claim);
  known.properties = { epistemicStatus: { type: "string", const: "asserted" }, ...claim.properties };
  known.required = ["epistemicStatus", ...claim.required];
  unknown.properties = { epistemicStatus: { type: "string", const: "unconfirmed" },
    subjectRef: claim.properties.subjectRef, predicate: claim.properties.predicate,
    description: { ...(claim.properties.description as object), minLength: 1 } };
  unknown.required = ["epistemicStatus", "subjectRef", "predicate", "description"];
  claims.items = { anyOf: [known, unknown] };
  const jsonObjectPostlude = (request.jsonObjectPostlude ?? "") + instruction;
  return { ...request, wireJsonSchema: wire, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${OBSERVATION_CLAIM_ENCODING}@${contentHash(wire).slice(0, 16)}`,
    preprocessOutput: raw => ({ value: decodeObservationClaims(raw, batch), symbolRepairs: [] }) };
}
