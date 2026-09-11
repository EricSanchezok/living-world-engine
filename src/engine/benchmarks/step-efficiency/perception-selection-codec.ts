import { z } from "zod";
import type { OnsetPerceptionInput } from "../../algorithms/roles";
import { modelFactValueSchema } from "../../contracts/llm-schemas";
import type { ModelReference, ModelReferenceCandidate, ModelReferenceCatalog, ModelReferenceKind, ModelReferenceUse } from "../../contracts/model-context";
import { createTruthReferenceResolver } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";
import { perceptionAssessmentSchema, validatePerceptionAssessment, type PerceptionAssessmentDraft } from "./perception-assessment";

type Json = Record<string, unknown>;
type Schema = Record<string, unknown> | boolean;
type FactValue = PerceptionAssessmentDraft["assessments"][number]["evidence"][number] & { kind: "fact" };
interface WireAssessment {
  evidenceKeys: string[];
  verdict: PerceptionAssessmentDraft["assessments"][number]["verdict"];
  checkKeys: string[];
}
interface WireCheck {
  proposalKey: string;
  perceivedEntityKey: string | null;
  ratingKey: string | null;
  difficulty: { kind: "environment"; band: string; sourceKey: string } |
    { kind: "opposed"; targetKey: string; ratingKey: string };
  mode: string;
  visibility: string;
  basisKeys: string[];
}
interface WireOutput { assessments: Record<string, WireAssessment>; requests: WireCheck[] }
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selection codec requires an object");
  return value as Json;
};
const strict = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const array = (items: Schema, minItems = 0): Schema => ({ type: "array", items, minItems });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const evidenceKinds: ModelReferenceKind[] = ["fact", "law", "entity", "placement", "condition", "rating", "event", "action"];
const sourceKinds: ModelReferenceKind[] = ["action", "entity", "fact", "condition", "rating", "law", "placement"];

/** A lossless output symbol table over the actual complete assessment request. */
export class PerceptionSelectionCodec {
  readonly request: StructuredModelRequest<unknown>;
  readonly bindingHash: string;
  readonly schema: z.ZodType;
  readonly taskPairs: ReadonlyMap<string, { observerRef: string; sourceActionRef: string }>;
  private readonly entries = new Map<string, ModelReferenceCandidate>();
  private readonly keys = new Map<string, string>();
  private readonly factSnapshots = new Map<string, FactValue["value"]>();
  private readonly inputHash: string;
  private readonly requestHash: string;
  private readonly physicalRequestHash: string;

  constructor(private readonly original: StructuredModelRequest<PerceptionAssessmentDraft>, private readonly input: Readonly<OnsetPerceptionInput>) {
    if (original.schemaName !== "truth_perception_assessment_probe") throw new Error("selection codec requires the actual assessment request");
    this.inputHash = contentHash(input);
    this.requestHash = contentHash({ system: original.system, userPrompt: original.userPrompt, context: original.context });
    const context = structuredClone(object(original.context));
    if (Object.hasOwn(context, "selectionProtocol")) throw new Error("selection metadata already exists");
    const catalog = object(context.referenceCatalog) as unknown as ModelReferenceCatalog;
    if (!Array.isArray(catalog.candidates)) throw new Error("selection codec requires the actual reference catalog");
    for (const [index, candidate] of catalog.candidates.entries()) {
      const key = `${candidate.kind}_${index.toString(36)}`;
      if (Object.hasOwn(candidate, "selectionKey") || this.keys.has(candidate.handle)) throw new Error("duplicate or already encoded selection catalog");
      this.entries.set(key, candidate);
      this.keys.set(candidate.handle, key);
    }
    const facts = object(object(object(context.state).canonicalTruth).facts);
    const resolver = createTruthReferenceResolver({ state: input.state, definition: input.definition, actions: input.actions, checkRequests: [] });
    for (const [key, candidate] of this.entries) {
      if (candidate.kind !== "fact") continue;
      if (!Object.hasOwn(facts, candidate.handle)) throw new Error(`fact snapshot absent from request: ${candidate.handle}`);
      const row = object(facts[candidate.handle]);
      if (Object.hasOwn(row, "snapshotKey")) throw new Error("fact snapshot annotation collision");
      const value = modelFactValueSchema.parse(row.value), resolved = resolver.resolve(candidate.handle);
      if (resolved.kind !== "fact") throw new Error("fact snapshot identity type mismatch");
      const actual = input.state.truth.facts[resolved.engineId];
      if (!actual) throw new Error("fact snapshot has no source fact");
      const expected = actual.value.kind === "entity" ? { kind: "entity", entityRef: resolver.handleFor("entity", actual.value.entityId) } : actual.value;
      if (contentHash(value) !== contentHash(expected)) throw new Error("fact snapshot value differs from source state");
      this.factSnapshots.set(key, value);
      row.snapshotKey = key;
    }
    const items = context.perceptionWorkItems;
    if (!Array.isArray(items)) throw new Error("selection codec requires assigned work items");
    const pairs = items.map((item, index) => {
      const row = object(item);
      if (Object.hasOwn(row, "taskKey")) throw new Error("work item already has a task key");
      return [`q${index.toString(36)}`, { observerRef: String(row.observerRef), sourceActionRef: String(row.sourceActionRef) }] as const;
    });
    if (new Set(pairs.map(([, pair]) => contentHash(pair))).size !== pairs.length) throw new Error("duplicate task identities");
    this.taskPairs = new Map(pairs);
    this.bindingHash = contentHash({ version: 2, inputHash: this.inputHash, requestHash: this.requestHash, pairs,
      entries: [...this.entries].map(([key, candidate]) => ({ key, ...candidate })), factSnapshots: [...this.factSnapshots] });
    context.referenceCatalog = { ...catalog, candidates: catalog.candidates.map(candidate => ({ ...candidate, selectionKey: this.keyFor(candidate.handle) })) };
    context.perceptionWorkItems = items.map((item, index) => {
      const row = object(item);
      const hints = { taskKey: pairs[index]![0], observerKey: this.keyFor(String(row.observerRef)),
        sourceActorKey: this.keyFor(String(row.sourceActorRef)) };
      for (const key of Object.keys(hints)) if (Object.hasOwn(row, key)) throw new Error("selection work-item annotation collision");
      return { ...row, ...hints, observerRatings: (row.observerRatings as Json[]).map(rating => {
        if (Object.hasOwn(rating, "selectionKey")) throw new Error("selection Rating annotation collision");
        return { ...rating, selectionKey: this.keyFor(String(rating.ratingRef)) };
      }) };
    });
    context.selectionProtocol = { version: 2, bindingHash: this.bindingHash, sourceStateHash: contentHash(input.state),
      instructions: "assessments is an object keyed by each perceptionWorkItems.taskKey. Choose referenceCatalog.candidates.selectionKey for output references; never spell a handle. A fact_* key explicitly selects the complete current Fact snapshot shown at state.canonicalTruth.facts[handle], including its typed value; that row has the identical snapshotKey. Apply that value and the authored rule, not the key's name or mere existence. evidenceKeys selects existing evidence; no separate value or kind is supplied. The engine restores only the selected snapshot, never chooses evidence or infers visibility. basisKeys accepts only fact_* or law_* entries, never a rating_* or entity_* key. Environmental difficulty uses sourceKey. All original context fields remain available." };
    const jsonSchema = this.buildSchema();
    this.schema = z.fromJSONSchema(jsonSchema);
    const system = original.system + "\nThe selectionProtocol defines this request's output representation and supersedes the instruction to copy a selected Fact value: select its explicit immutable snapshotKey in evidenceKeys instead. That key chooses the Fact together with its complete displayed typed value at this bound state. Use task keys and type-prefixed selection keys in the provided schema. Perception meaning and all decision rules remain unchanged. Never supply separate values, reference kind labels or handles where the schema asks for a key.";
    const userPrompt = original.userPrompt + " Use the bound task-key object and catalog selection keys.";
    this.request = { ...original, system, userPrompt, promptVersion: contentHash({ system, userPrompt }), context,
      schema: this.schema, wireJsonSchema: jsonSchema, jsonExamplePolicy: "omit", schemaName: "truth_perception_selection_probe" };
    this.physicalRequestHash = contentHash({ system, userPrompt, context, wireJsonSchema: jsonSchema });
    if (contentHash(this.restoreContext()) !== contentHash(original.context)) throw new Error("selection context did not round trip");
  }

  keyFor(handle: string | ModelReference): string {
    if (typeof handle !== "string") throw new Error("selection codec requires an existing handle");
    const key = this.keys.get(handle);
    if (!key) throw new Error(`unknown selection handle ${handle}`);
    return key;
  }

  private assertBinding(expectedBinding: string): void {
    if (expectedBinding !== this.bindingHash || contentHash(this.input) !== this.inputHash ||
      contentHash({ system: this.original.system, userPrompt: this.original.userPrompt, context: this.original.context }) !== this.requestHash ||
      contentHash({ system: this.request.system, userPrompt: this.request.userPrompt, context: this.request.context,
        wireJsonSchema: this.request.wireJsonSchema }) !== this.physicalRequestHash) {
      throw new Error("selection codec source/request binding changed");
    }
  }

  restoreContext(): unknown {
    const context = structuredClone(object(this.request.context));
    delete context.selectionProtocol;
    const catalog = object(context.referenceCatalog);
    catalog.candidates = (catalog.candidates as Json[]).map(candidate => {
      const copy = { ...candidate }; delete copy.selectionKey; return copy;
    });
    const facts = object(object(object(context.state).canonicalTruth).facts);
    for (const key of this.factSnapshots.keys()) delete object(facts[this.entries.get(key)!.handle]).snapshotKey;
    context.perceptionWorkItems = (context.perceptionWorkItems as Json[]).map(item => {
      const copy = { ...item }; delete copy.taskKey; delete copy.observerKey; delete copy.sourceActorKey;
      copy.observerRatings = (copy.observerRatings as Json[]).map(rating => { const row = { ...rating }; delete row.selectionKey; return row; });
      return copy;
    });
    return context;
  }

  private buildSchema(): Record<string, unknown> {
    const definitions: Record<string, Schema> = {};
    const selector = (name: string, kinds: readonly ModelReferenceKind[], use?: ModelReferenceUse): Schema => {
      const keys = [...this.entries].filter(([, candidate]) => kinds.includes(candidate.kind) && (!use || candidate.allowedUses.includes(use))).map(([key]) => key);
      definitions[name] = keys.length ? { type: "string", enum: keys } : false;
      return { $ref: `#/definitions/${name}` };
    };
    const entity = selector("entityKey", ["entity"]), rating = selector("ratingKey", ["rating"], "modifier");
    const evidence = selector("evidenceKey", evidenceKinds);
    const basis = selector("worldBasisKey", ["fact", "law"], "cause"), source = selector("environmentSourceKey", sourceKinds, "source");
    const proposal = { type: "string", minLength: 1, maxLength: 128 };
    definitions.assessment = strict({ evidenceKeys: array(evidence, 1), verdict: { type: "string", enum: ["visible", "no_route", "check_required", "insufficient_evidence"] }, checkKeys: array(proposal) });
    const checkFields = perceptionAssessmentSchema.shape.requests.element.shape;
    const jsonField = (field: z.ZodType): Schema => z.toJSONSchema(field, { target: "draft-07" });
    const wireCheck = strict({ proposalKey: proposal, perceivedEntityKey: nullable(entity), ratingKey: nullable(rating),
      difficulty: { anyOf: [strict({ kind: { const: "environment" }, band: jsonField(checkFields.difficulty.options[0].shape.band), sourceKey: source }),
        strict({ kind: { const: "opposed" }, targetKey: entity, ratingKey: rating })] },
      mode: jsonField(checkFields.mode), visibility: jsonField(checkFields.visibility), basisKeys: array(basis, 1) });
    return { $schema: "http://json-schema.org/draft-07/schema#", ...object(strict({ assessments: strict(Object.fromEntries([...this.taskPairs.keys()].map(key => [key, { $ref: "#/definitions/assessment" }]))), requests: array(wireCheck) })), definitions };
  }

  decodeOutput(value: unknown, expectedBinding: string): PerceptionAssessmentDraft {
    this.assertBinding(expectedBinding);
    const wire = this.schema.parse(value) as WireOutput;
    const taskOrder = Object.keys(object(object(value).assessments));
    const entry = (key: string) => {
      const candidate = this.entries.get(key);
      if (!candidate) throw new Error(`unknown selection key ${key}`);
      return candidate;
    };
    const ref = (key: string) => entry(key).handle;
    const source = (key: string) => ({ kind: entry(key).kind, ref: ref(key) });
    const assessments = taskOrder.map(task => {
      const row = wire.assessments[task]!;
      return { ...this.taskPairs.get(task), verdict: row.verdict, checkKeys: row.checkKeys,
        evidence: row.evidenceKeys.map(key => ({ ...source(key),
          ...(entry(key).kind === "fact" ? { value: structuredClone(this.factSnapshots.get(key)) } : {}) })) };
    });
    const requests = wire.requests.map(check => ({ proposalKey: check.proposalKey,
      perceivedEntityRef: check.perceivedEntityKey === null ? null : ref(check.perceivedEntityKey), ratingRef: check.ratingKey === null ? null : ref(check.ratingKey),
      difficulty: check.difficulty.kind === "environment" ? { kind: "environment", band: check.difficulty.band, source: source(check.difficulty.sourceKey) }
        : { kind: "opposed", targetRef: ref(check.difficulty.targetKey), ratingRef: ref(check.difficulty.ratingKey) },
      mode: check.mode, visibility: check.visibility, basisRefs: check.basisKeys.map(source) }));
    return validatePerceptionAssessment(this.input, { assessments, requests }, contentHash(this.input.state)).draft;
  }

  encodeOutput(value: PerceptionAssessmentDraft): unknown {
    this.assertBinding(this.bindingHash);
    const canonical = validatePerceptionAssessment(this.input, value, contentHash(this.input.state)).draft;
    const pairKeys = new Map([...this.taskPairs].map(([key, pair]) => [contentHash(pair), key]));
    const encoded = { assessments: Object.fromEntries(canonical.assessments.map(row => {
      const { observerRef, sourceActionRef, evidence, ...assessment } = row;
      const task = pairKeys.get(contentHash({ observerRef, sourceActionRef }));
      if (!task) throw new Error("unassigned selection task");
      return [task, { ...assessment, evidenceKeys: evidence.map(item => this.keyFor(item.ref)) }];
    })), requests: canonical.requests.map(check => ({ proposalKey: check.proposalKey,
      perceivedEntityKey: check.perceivedEntityRef === null ? null : this.keyFor(check.perceivedEntityRef), ratingKey: check.ratingRef === null ? null : this.keyFor(check.ratingRef),
      difficulty: check.difficulty.kind === "environment" ? { kind: "environment", band: check.difficulty.band, sourceKey: this.keyFor(String(check.difficulty.source.ref)) }
        : { kind: "opposed", targetKey: this.keyFor(String(check.difficulty.targetRef)), ratingKey: this.keyFor(String(check.difficulty.ratingRef)) },
      mode: check.mode, visibility: check.visibility, basisKeys: check.basisRefs.map(basis => this.keyFor(basis.ref)) })) };
    this.schema.parse(encoded);
    return encoded;
  }
}
