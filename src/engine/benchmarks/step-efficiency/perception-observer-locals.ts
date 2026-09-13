import { z } from "zod";
import { proposalKeySchema } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { PERCEPTION_TEMPORAL_ROUTES, perceptionTemporalRoutesSchema } from "./perception-temporal-routes";

const notice = loadPromptAsset("shared/perception-observer-locals.md");
export const PERCEPTION_OBSERVER_LOCALS = `perception-observer-locals-v1@${contentHash(notice).slice(0, 16)}`;
const proposal = z.strictObject({ proposalKey: proposalKeySchema });
const localReference = z.union([z.strictObject({ observerLocalIndex: z.number().int().nonnegative() }), proposal]);
const sourceShape = z.looseObject({
  task: z.looseObject({ assignment: z.looseObject({ perceptionTargets: z.array(z.looseObject({
    targetIndex: z.number().int().nonnegative(), observerRef: z.string(),
  })) }) }),
  referenceCatalog: z.looseObject({ candidates: z.array(z.looseObject({ handle: z.string(), kind: z.string(), allowedUses: z.array(z.string()) })) }),
  state: z.looseObject({ actors: z.array(z.looseObject({ entityRef: z.string(), availableLocalEntityRefs: z.array(z.string()),
    localEntityBindings: z.array(z.looseObject({ localEntityRef: z.string(), canonicalEntityRefs: z.array(z.string()) })),
  })) }),
});
type Node = Record<string, unknown>;
const object = (value: unknown): Node => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelOutputError("observer symbol contract expects an object");
  return value as Node;
};
const objects = (value: unknown): Node[] => {
  if (!Array.isArray(value)) throw new ModelOutputError("observer symbol contract expects an array");
  return value.map(object);
};

/** Compile explicit local symbol selections; never infer or repair a referent. */
export function perceptionObserverLocalsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_temporal_routes" ||
    !request.preprocessOutput || !request.promptVersion.includes(PERCEPTION_TEMPORAL_ROUTES) ||
    request.promptVersion.includes(PERCEPTION_OBSERVER_LOCALS) || request.jsonExamplePolicy !== "omit" || !request.wireJsonSchema ||
    contentHash(request.wireJsonSchema) !== contentHash(z.toJSONSchema(perceptionTemporalRoutesSchema, { target: "draft-07" }))) {
    throw new ModelConfigurationError("observer symbols require the exact temporal route request");
  }
  const sourceHash = contentHash(request.context), source = sourceShape.parse(request.context);
  const catalog = new Map(source.referenceCatalog.candidates.map(row => [row.handle, row]));
  const actors = new Map(source.state.actors.map(actor => [actor.entityRef, actor]));
  if (catalog.size !== source.referenceCatalog.candidates.length || actors.size !== source.state.actors.length) {
    throw new ModelConfigurationError("observer symbols have duplicate catalog or actor identities");
  }
  const tables = source.task.assignment.perceptionTargets.map(target => {
    const actor = actors.get(target.observerRef);
    if (!actor) throw new ModelConfigurationError("observer symbols have no assigned actor");
    const bindings = new Map(actor.localEntityBindings.map(binding => [binding.localEntityRef, binding]));
    if (bindings.size !== actor.localEntityBindings.length || new Set(actor.availableLocalEntityRefs).size !== actor.availableLocalEntityRefs.length ||
      bindings.size !== actor.availableLocalEntityRefs.length || actor.availableLocalEntityRefs.some(ref => !bindings.has(ref))) {
      throw new ModelConfigurationError("observer symbols have an incomplete or duplicate inventory");
    }
    return { targetIndex: target.targetIndex, observerRef: target.observerRef, entries: actor.availableLocalEntityRefs.map((ref, observerLocalIndex) => {
      const entry = catalog.get(ref);
      if (entry?.kind !== "local_entity" || !entry.allowedUses.includes("target")) throw new ModelConfigurationError("observer symbol is not a permitted local identity");
      return { observerLocalIndex, localEntityRef: ref, catalog: entry, binding: bindings.get(ref)! };
    }) };
  });
  const byTarget = new Map(tables.map(table => [table.targetIndex, table]));
  if (byTarget.size !== tables.length) throw new ModelConfigurationError("observer symbols have duplicate target indices");
  const wire: Node = structuredClone(request.wireJsonSchema!);
  const terminal = objects(wire.oneOf).find(option => object(object(option.properties).kind).const === "done")!;
  const reports = objects(object(object(object(terminal.properties).reports).items).oneOf);
  const referenceWire = z.toJSONSchema(localReference, { target: "draft-07" });
  const scopedReference = (count: number) => ({ anyOf: [count ? {
    type: "object", properties: { observerLocalIndex: { type: "integer", minimum: 0, maximum: count - 1 } },
    required: ["observerLocalIndex"], additionalProperties: false,
  } : { not: {} }, z.toJSONSchema(proposal, { target: "draft-07" })] });
  for (const report of reports) {
    const fields = object(report.properties);
    if (!fields.stimulus) continue;
    const claims = object(object(object(object(fields.stimulus).properties).apparentClaims).items);
    const claimFields = object(claims.properties);
    claimFields.subjectRef = referenceWire;
    const valueOptions = objects(object(claimFields.value).oneOf);
    object(valueOptions.find(value => object(object(value.properties).kind).const === "local_entity")!.properties).entityRef = referenceWire;
    report.allOf = [{ anyOf: tables.length ? tables.map(table => ({ properties: {
      targetIndex: { const: table.targetIndex }, stimulus: { properties: { apparentClaims: { items: { properties: {
        subjectRef: scopedReference(table.entries.length),
        value: { if: { properties: { kind: { const: "local_entity" } }, required: ["kind"] },
          then: { properties: { entityRef: scopedReference(table.entries.length) } } },
      } } } } },
    } })) : [{ not: {} }] }];
  }
  return { ...request, schemaName: "truth_perception_temporal_observer_locals", wireJsonSchema: wire,
    promptVersion: `${request.promptVersion}/${PERCEPTION_OBSERVER_LOCALS}`,
    jsonObjectPostlude: `${request.jsonObjectPostlude ?? ""}\n\n${notice}\n${JSON.stringify({ sourceContextHash: sourceHash, tables })}`,
    preprocessOutput: value => {
      if (contentHash(request.context) !== sourceHash) throw new ModelConfigurationError("observer symbol source changed");
      const decoded = structuredClone(value), root = object(decoded);
      if (root.kind === "done") for (const report of objects(root.reports)) {
        const table = byTarget.get(z.number().int().nonnegative().parse(report.targetIndex));
        if (!table) throw new ModelOutputError("observer symbol target is not assigned", undefined, { rawValue: value });
        if (!Object.hasOwn(report, "stimulus")) continue;
        const resolve = (reference: unknown) => {
          const selected = localReference.parse(reference);
          if (!("observerLocalIndex" in selected)) return selected;
          const entry = table.entries[selected.observerLocalIndex];
          if (!entry) throw new ModelOutputError("observer local index is out of range", undefined, { rawValue: value });
          return entry.localEntityRef;
        };
        for (const claim of objects(object(report.stimulus).apparentClaims)) {
          claim.subjectRef = resolve(claim.subjectRef);
          const claimValue = object(claim.value);
          if (claimValue.kind === "local_entity") claimValue.entityRef = resolve(claimValue.entityRef);
        }
      }
      return request.preprocessOutput!(decoded);
    } };
}
