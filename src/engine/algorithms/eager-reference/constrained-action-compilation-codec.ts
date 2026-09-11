import { z } from "zod";
import { actionCompilationBatchSchema } from "../../contracts/llm-schemas";
import { referenceHandleFor, type ActionCompilationReferenceCandidate, type ActionCompilationReferenceResolver, type ModelReferenceUse } from "../../contracts/model-context";
import type { SimulationState } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import { actionCompilationProfileKinds } from "./action-compilation-representation";

type Json = Record<string, unknown>;
type Schema = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const keyPattern = "^candidate_[0-9a-f]{12}$";
const canonicalSchema = z.toJSONSchema(actionCompilationBatchSchema, { target: "draft-07" }) as Schema;
export const CONSTRAINED_COMPILATION_CODEC_VERSION = "ac-fp2-cf-v1";

function referenceUse(path: readonly string[]): ModelReferenceUse {
  if (path.includes("continuationAssertions")) return "assertion";
  if (path.includes("causes")) return "cause";
  if (path.includes("profileRef")) return "profile";
  if (path.includes("audienceAgentCandidateKeys")) return "audience";
  if (path.includes("stateDependencies") || path.includes("sharedResourceClaims")) return "conflict";
  throw new Error(`unregistered canonical reference field: ${path.join(".")}`);
}

/** Per-request representation only. It neither ranks candidates nor judges intent. */
export class ConstrainedActionCompilationCodec {
  readonly slotIndices: readonly number[];
  readonly allowed: ReadonlyMap<number, ReadonlyMap<ModelReferenceUse, readonly string[]>>;
  readonly allowedHash: string;
  readonly schema: z.ZodType;
  readonly jsonSchema: Schema;
  readonly snapshots = new Map<string, unknown>();
  readonly snapshotEvidence: Array<{ slot: number; factKey: string; stateHash: string; valueHash: string }> = [];
  private readonly stateHash: string;

  constructor(readonly options: { capabilities: boolean; snapshots: boolean; context: unknown;
    resolver: ActionCompilationReferenceResolver; state: Readonly<SimulationState>; selectedKeysBySlot?: ReadonlyMap<number, readonly string[]> }) {
    const context = object(options.context);
    const slots = object(context?.task)?.slots;
    const candidates = object(context?.referenceCatalog)?.candidates as ActionCompilationReferenceCandidate[] | undefined;
    if (!Array.isArray(slots) || !Array.isArray(candidates)) throw new Error("C/F requires the actual projected compilation request");
    this.slotIndices = slots.map((slot) => Number(object(slot)?.slot));
    if (this.slotIndices.some((slot) => !Number.isSafeInteger(slot) || slot < 0) || new Set(this.slotIndices).size !== slots.length) {
      throw new Error("C/F request has invalid slot identities");
    }
    this.stateHash = contentHash(options.state);
    const uses: ModelReferenceUse[] = ["assertion", "cause", "profile", "audience", "conflict"];
    this.allowed = new Map(this.slotIndices.map((slot) => {
      const selected = options.selectedKeysBySlot?.get(slot);
      if (options.selectedKeysBySlot && !selected) throw new Error("C/F lacks this slot's actual shortlist");
      const visible = candidates.filter((candidate) => (candidate.scope.kind === "shared" || candidate.scope.slot === slot) &&
        (!selected || selected.includes(candidate.candidateKey)));
      const resolver = options.resolver.scopedToSlot(slot);
      const visibleKeys = new Set(visible.map((candidate) => candidate.candidateKey));
      // Use the resolver's permission enumeration, not its diagnostic exception
      // path (which rebuilds a full allowed-handle list on every invalid use).
      const allowed = new Map(uses.map((use) => [use, resolver.candidatesFor(use)
        .map((candidate) => candidate.candidateKey).filter((key) => visibleKeys.has(key)).sort()]));
      if (options.snapshots) for (const candidate of visible.filter((entry) => entry.kind === "fact" && allowed.get("assertion")!.includes(entry.candidateKey))) {
        const resolved = resolver.resolve(candidate.candidateKey, "assertion");
        const fact = options.state.truth.facts[resolved.engineId];
        if (!fact) continue;
        let value: unknown = structuredClone(fact.value);
        if (fact.value.kind === "entity") {
          try {
            const entityRef = resolver.candidateKeyForHandle(referenceHandleFor("entity", fact.value.entityId));
            if (!allowed.get("assertion")!.includes(entityRef)) continue;
            value = { kind: "entity", entityRef };
          } catch { continue; }
        }
        // A snapshot is available only for the exact typed value already visible.
        if (contentHash(object(candidate.details)?.value ?? null) === contentHash(value)) this.snapshots.set(`${slot}:${candidate.candidateKey}`, value);
      }
      return [slot, allowed];
    }));
    this.allowedHash = contentHash([...this.allowed].map(([slot, uses]) => [slot, [...uses]]));
    this.jsonSchema = this.buildSchema();
    this.schema = z.fromJSONSchema(this.jsonSchema);
  }

  private buildSchema(): Schema {
    const schema = structuredClone(canonicalSchema);
    const definitions: Record<string, unknown> = { ...object(schema.definitions) };
    const definition = (keys: readonly string[]): Schema => {
      const id = `keys_${contentHash(keys).slice(0, 16)}`;
      definitions[id] = { type: "string", enum: [...keys] };
      return { $ref: `#/definitions/${id}` };
    };
    const transform = (node: unknown, slot: number, path: string[] = []): unknown => {
      if (Array.isArray(node)) return node.map((item) => transform(item, slot, path));
      const item = object(node);
      if (!item) return node;
      if (this.options.capabilities && item.pattern === keyPattern) return definition(this.allowed.get(slot)!.get(referenceUse(path))!);
      const mapped = Object.fromEntries(Object.entries(item).map(([key, value]) => [key, transform(value, slot,
        key === "properties" ? path : [...path, key])])) as Schema;
      const fields = object(mapped.properties);
      if (this.options.snapshots && object(fields?.kind)?.const === "fact_matches" && fields?.expected) {
        fields.expected = { anyOf: [fields.expected, { type: "object", properties: { mode: { type: "string", const: "snapshot" } }, required: ["mode"], additionalProperties: false }] };
      }
      return mapped;
    };
    const slotsSchema = (schema.properties as Json).slots as Schema;
    if (!this.options.capabilities) {
      slotsSchema.minItems = this.slotIndices.length;
      slotsSchema.maxItems = this.slotIndices.length;
      slotsSchema.items = transform(slotsSchema.items, this.slotIndices[0]!);
      return schema;
    }
    const kinds = actionCompilationProfileKinds(this.options.state);
    const properties = Object.fromEntries(this.slotIndices.map((slot) => {
      const item = transform(slotsSchema.items, slot) as Schema;
      const fields = item.properties as Json;
      delete fields.slot;
      item.required = (item.required as string[]).filter((key) => key !== "slot");
      const originalPlan = fields.temporalPlan as Schema;
      const profileKeys = this.allowed.get(slot)!.get("profile")!;
      if (!profileKeys.length) throw new Error("C cannot satisfy the required profile reference");
      fields.temporalPlan = { anyOf: [false, true].flatMap((conditional) => {
        const keys = profileKeys.filter((key) => {
          const kind = kinds.get(key);
          if (!kind) throw new Error("C lacks trusted temporal profile kind");
          return (kind === "conditional") === conditional;
        });
        if (!keys.length) return [];
        const plan = structuredClone(originalPlan);
        const planFields = plan.properties as Json;
        planFields.profileRef = definition(keys);
        if (conditional) (planFields.continuationAssertions as Schema).minItems = 1;
        return [plan];
      }) };
      return [String(slot), item];
    }));
    (schema.properties as Json).slots = { type: "object", properties, required: this.slotIndices.map(String), additionalProperties: false };
    schema.definitions = definitions;
    return schema;
  }

  encodeOutput(value: unknown): unknown {
    const root = object(structuredClone(value));
    if (!this.options.capabilities || !Array.isArray(root?.slots)) return structuredClone(value);
    const pairs = root.slots.map((value) => {
      const item = object(value);
      if (!item || !Number.isSafeInteger(item.slot)) throw new Error("cannot encode malformed canonical slot");
      const { slot, ...rest } = item;
      return [String(slot), rest] as const;
    });
    if (new Set(pairs.map(([slot]) => slot)).size !== pairs.length) throw new Error("cannot encode duplicate canonical slots");
    return { ...root, slots: Object.fromEntries(pairs) };
  }

  decodeOutput(value: unknown): unknown {
    const root = object(structuredClone(value));
    if (!root) return value;
    if (this.options.capabilities && Array.isArray(root.slots)) {
      // A canonical-shaped response is not a valid C wire response. Preserve
      // it as invalid instead of silently repairing the protocol's structure.
      root.slots = { invalidWireSlots: root.slots };
      return root;
    }
    if (this.options.capabilities && object(root.slots)) {
      const slots = root.slots as Json;
      // Preserve unexpected keys as malformed slot entries, never silently drop output.
      const keys = [...this.slotIndices.map(String).filter((key) => Object.hasOwn(slots, key)), ...Object.keys(slots).filter((key) => !this.slotIndices.map(String).includes(key))];
      root.slots = keys.map((key) => ({ ...object(slots[key]), slot: !Object.hasOwn(object(slots[key]) ?? {}, "slot") && /^(0|[1-9][0-9]*)$/u.test(key) ? Number(key) : -1 }));
    }
    if (this.options.snapshots && Array.isArray(root.slots)) for (const slot of root.slots) {
      const assertions = object(object(slot)?.temporalPlan)?.continuationAssertions;
      if (!Array.isArray(assertions)) continue;
      for (const assertion of assertions) {
        if (assertion?.kind !== "fact_matches" || object(assertion.expected)?.mode !== "snapshot" || Object.keys(assertion.expected).length !== 1) continue;
        const snapshot = this.snapshots.get(`${slot.slot}:${assertion.factRef}`);
        if (snapshot === undefined) continue; // Invalid branch remains invalid for canonical schema validation.
        assertion.expected = structuredClone(snapshot);
        this.snapshotEvidence.push({ slot: slot.slot, factKey: assertion.factRef, stateHash: this.stateHash, valueHash: contentHash(snapshot) });
      }
    }
    return root;
  }
}
