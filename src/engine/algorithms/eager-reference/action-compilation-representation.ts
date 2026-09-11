import { z } from "zod";
import { actionCompilationBatchSchema, actionCompilationRequestSchema, type ActionCompilationBatchDraft } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { actionCompilationCandidateKeyForHandle, referenceHandleFor } from "../../contracts/model-context";
import type { ModelSymbolRepairAudit, SimulationState } from "../../contracts/model";
import { SYMBOL_REPAIR_POLICY_VERSION } from "../../contracts/symbol-repair";

export type ActionCompilationRepresentation = "B1" | "A" | "T" | "AT";
export const ACTION_COMPILATION_REPRESENTATION_VERSION = "ac-fp1-codec-v5";
const canonicalPattern = "^candidate_[0-9a-f]{12}$";
const aliasPattern = "^r[0-9]{3,}$";
const canonicalKey = new RegExp(canonicalPattern, "u");
type RecordValue = Record<string, unknown>;
type Schema = Record<string, unknown>;

function aliasOrdinal(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^r[0-9]+$/u.test(value)) return undefined;
  return value.slice(1).replace(/^0+(?=[0-9])/u, "");
}

/** Traverse the actual wire shape without selecting, removing or repairing a
 * union branch. Literal discriminants protect opaque values in other branches. */
function mapWireAliases(value: unknown, schema: Schema, map: (value: string, path: Array<string | number>) => string,
  path: Array<string | number> = []): unknown {
  const aliasLeaf = schema.pattern === aliasPattern || aliasOrdinal(schema.const) !== undefined ||
    (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(item => aliasOrdinal(item) !== undefined));
  if (aliasLeaf && typeof value === "string") return map(value, path);
  let mapped = value;
  for (const union of [schema.oneOf, schema.anyOf, schema.allOf]) {
    if (!Array.isArray(union)) continue;
    for (const branch of union) {
      const fields = record(record(branch)?.properties);
      const object = record(mapped);
      if (fields && Object.entries(fields).some(([key, field]) => {
        const constant = record(field)?.const;
        return constant !== undefined && aliasOrdinal(constant) === undefined && object?.[key] !== constant;
      })) continue;
      if (record(branch)) mapped = mapWireAliases(mapped, branch, map, path);
    }
  }
  if (Array.isArray(mapped) && record(schema.items)) {
    return mapped.map((item, index) => mapWireAliases(item, schema.items as Schema, map, [...path, index]));
  }
  const object = record(mapped), fields = record(schema.properties);
  if (!object || !fields) return mapped;
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key,
    record(fields[key]) ? mapWireAliases(item, fields[key] as Schema, map, [...path, key]) : item,
  ]));
}

export const TEMPORAL_CONTRACT_SELECTORS: Readonly<Record<string, string>> = {
  fixed: "completeEntireActionAfterFixedDurationProfile",
  goal: "reviewProgressUntilOriginalObjectiveSatisfiedProfile",
  conditional: "continueOnlyWhileSourceConditionsHoldProfile",
  ongoing: "continueWithoutDefinedEndProfile",
  rate: "advanceExplicitQuantityAtProfileRate",
  staged: "completeEntireActionThroughAuthoredStagesProfile",
};

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function valueAtPath(value: unknown, path: unknown[]): unknown {
  for (const key of path) {
    if ((typeof key !== "string" && typeof key !== "number") || value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

const canonicalSchema = z.toJSONSchema(actionCompilationBatchSchema, { target: "draft-07" }) as Schema;

/** Walk only reference positions declared by the canonical output schema.
 * In particular, random_result.expected is opaque JSON, not a reference tree. */
function mapOutputReferences(value: unknown, schema: Schema, map: (key: string) => string): unknown {
  if (schema.pattern === canonicalPattern && typeof value === "string") return map(value);
  if (Array.isArray(value) && record(schema.items)) {
    return value.map((entry) => mapOutputReferences(entry, schema.items as Schema, map));
  }
  const branches = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(branches)) {
    const object = record(value);
    const branch = branches.find((entry: Schema) => {
      const properties = record(entry.properties);
      const discriminants = properties && Object.entries(properties)
        .filter(([, property]) => record(property)?.const !== undefined);
      if (discriminants?.length) return discriminants.every(([key, property]) => object?.[key] === (property as Schema).const);
      return (entry.type === "string" && typeof value === "string") || (entry.type === "null" && value === null);
    });
    return branch ? mapOutputReferences(value, branch, map) : structuredClone(value);
  }
  const object = record(value);
  const properties = record(schema.properties);
  if (!object || !properties) return structuredClone(value);
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [
    key, record(properties[key]) ? mapOutputReferences(child, properties[key] as Schema, map) : structuredClone(child),
  ]));
}

/** Context references have named fields; natural-language strings and literal
 * values are never searched/replaced. These names are owned by the projector. */
const referenceField = /^(?:ref|refs|candidateKey|candidateKeys|allowedHandles|.*(?:Ref|Refs|CandidateKey|CandidateKeys))$/u;
function mapContextReferences(value: unknown, map: (key: string) => string, field = ""): unknown {
  if (typeof value === "string") return referenceField.test(field) ? map(value) : value;
  if (Array.isArray(value)) return value.map((entry) => mapContextReferences(entry, map, field));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key,
    object.kind === "random_result" && key === "expected" ? structuredClone(child)
      : mapContextReferences(child, map, key),
  ]));
}

export function actionCompilationProfileKinds(state: Readonly<SimulationState>): ReadonlyMap<string, string> {
  return new Map(Object.values(state.truth.mechanics.temporalProfiles).map((profile) => [
    actionCompilationCandidateKeyForHandle(referenceHandleFor("temporal_profile", profile.id)), profile.kind,
  ]));
}

function profiles(context: unknown, trustedKinds?: ReadonlyMap<string, string>): Array<{ key: string; kind: string; conditional: boolean }> {
  const candidates = record(record(context)?.referenceCatalog)?.candidates;
  if (!Array.isArray(candidates)) throw new Error("representation requires a reference catalog");
  return candidates.filter((candidate) => candidate.kind === "temporal_profile").map((candidate) => {
    const kind = trustedKinds?.get(candidate.candidateKey) ?? record(candidate.details)?.kind;
    if (typeof kind !== "string") throw new Error(`missing script-owned temporal semantics for ${candidate.candidateKey}`);
    return { key: candidate.candidateKey as string, kind, conditional: kind === "conditional" };
  });
}

function mapPlans(value: unknown, transform: (plan: RecordValue) => RecordValue): unknown {
  const object = record(value);
  if (!object || !Array.isArray(object.slots)) return structuredClone(value);
  return { ...object, slots: object.slots.map((slot) => {
    const item = record(slot);
    const plan = record(item?.temporalPlan);
    return item && plan ? { ...item, temporalPlan: transform(plan) } : structuredClone(slot);
  }) };
}

/** One namespace per root physical batch. Initial visible keys own the first
 * sorted ordinals. A private, sorted full-root tail reserves stable names for
 * future retrieval results without widening any model-visible shortlist. */
export class ActionCompilationCodec {
  readonly aliases: ReadonlyMap<string, string>;
  readonly inverseAliases: ReadonlyMap<string, string>;
  readonly dictionaryHash: string;
  readonly usesAliases: boolean;
  readonly usesTemporalIR: boolean;
  readonly rootVisibleKeyCount: number;
  private readonly conditional: ReadonlySet<string>;
  private readonly selectors: ReadonlyMap<string, string>;
  private readonly aliasesByOrdinal: ReadonlyMap<string, string>;

  constructor(readonly representation: ActionCompilationRepresentation, rootContext: unknown, fullRootContext: unknown = rootContext,
    private readonly profileKinds?: ReadonlyMap<string, string>, readonly namedTemporalContracts = false) {
    this.usesAliases = representation === "A" || representation === "AT";
    this.usesTemporalIR = representation === "T" || representation === "AT";
    if (namedTemporalContracts && !this.usesTemporalIR) throw new Error("named temporal contracts require a temporal representation");
    const keys = new Set<string>();
    mapContextReferences(rootContext, (key) => { if (canonicalKey.test(key)) keys.add(key); return key; });
    const ordered = [...keys].sort();
    const width = Math.max(3, String(Math.max(0, ordered.length - 1)).length);
    this.rootVisibleKeyCount = ordered.length;
    const reserved = new Set<string>();
    mapContextReferences(fullRootContext, (key) => { if (canonicalKey.test(key) && !keys.has(key)) reserved.add(key); return key; });
    this.aliases = new Map([...ordered, ...[...reserved].sort()].map((key, index) => [key, `r${String(index).padStart(width, "0")}`]));
    this.inverseAliases = new Map([...this.aliases].map(([key, alias]) => [alias, key]));
    this.aliasesByOrdinal = new Map([...this.inverseAliases.keys()].map(alias => [aliasOrdinal(alias)!, alias]));
    this.dictionaryHash = contentHash([...this.aliases]);
    this.conditional = new Set(this.usesTemporalIR ? profiles(fullRootContext, profileKinds).filter((profile) => profile.conditional).map((profile) => profile.key) : []);
    this.selectors = new Map(namedTemporalContracts ? profiles(fullRootContext, profileKinds).map((profile) => {
      const selector = TEMPORAL_CONTRACT_SELECTORS[profile.kind];
      if (!selector) throw new Error(`unsupported temporal contract kind ${profile.kind}`);
      return [profile.key, selector];
    }) : []);
  }

  private encodeKey = (key: string): string => {
    if (!this.usesAliases || !canonicalKey.test(key)) return key;
    const alias = this.aliases.get(key);
    if (!alias) throw new Error(`root alias namespace does not include repair candidate ${key}`);
    return alias;
  };

  private decodeKey = (key: string): string => {
    if (!this.usesAliases) return key;
    const canonical = this.inverseAliases.get(key);
    // Never accept canonical keys in an alias-only response or approximate an
    // unknown alias. Preserve invalid strings for the canonical validator.
    return canonical ?? `invalid-alias:${key}`;
  };

  aliasPreprocessor(schema: z.ZodType): (raw: unknown) => { value: unknown; symbolRepairs: ModelSymbolRepairAudit[] } {
    const wire = z.toJSONSchema(schema, { target: "draft-07" }) as Schema;
    return raw => {
      const symbolRepairs: ModelSymbolRepairAudit[] = [];
      const original = structuredClone(raw);
      if (!this.usesAliases) return { value: original, symbolRepairs };
      const value = mapWireAliases(original, wire, (key, path) => {
        const ordinal = aliasOrdinal(key);
        const padded = ordinal === undefined ? undefined : this.aliasesByOrdinal.get(ordinal);
        if (!padded || padded === key) return key;
        symbolRepairs.push({
          status: "normalized", originalValue: key, normalizedValue: padded, correctedValue: padded,
          bestDistance: null, secondBestDistance: null, margin: null, candidates: [], method: "exact",
          policyVersion: SYMBOL_REPAIR_POLICY_VERSION, domain: "opaque-id", path,
          catalogHash: this.dictionaryHash, candidateCount: this.inverseAliases.size,
          reason: "Exact decimal ordinal in the pinned alias dictionary; only zero padding changed.",
        });
        return padded;
      });
      return { value, symbolRepairs };
    };
  }

  encodeContext(context: unknown): unknown {
    const mapped = mapContextReferences(context, this.encodeKey);
    const task = record(record(mapped)?.task);
    if (task && Array.isArray(task.slots)) {
      // previousAttempt is canonical compiler output, not an arbitrary context
      // object. Use the output schema and the same temporal codec for repair.
      const original = record(record(context)?.task)?.slots as unknown[];
      task.slots = task.slots.map((slot, index) => {
        const item = record(slot);
        const previous = record(original[index])?.previousAttempt;
        if (!item || !previous) return slot;
        const encoded = this.encodeOutput({ slots: [previous] }) as { slots: unknown[] };
        const sourceIssues = record(original[index])?.issues;
        const mappedIssues = item.issues;
        const references = mapOutputReferences({ slots: [previous] }, canonicalSchema, this.encodeKey) as { slots: unknown[] };
        const previousPlan = record(record(previous)?.temporalPlan);
        const wireIssues = Array.isArray(sourceIssues) ? sourceIssues.map((value, issueIndex) => {
          const issue = record(value), projected = Array.isArray(mappedIssues) ? mappedIssues[issueIndex] : value;
          if (!issue || !Array.isArray(issue.path)) return projected;
          const wireIssue = { ...record(projected) };
          // Convert only a schema-owned reference matching the actual candidate.
          // Literal strings and mismatched evidence retain their original value.
          if (this.usesAliases && typeof issue.originalValue === "string" && valueAtPath(previous, issue.path) === issue.originalValue) {
            const wireValue = valueAtPath(references.slots[0], issue.path);
            if (typeof wireValue === "string" && wireValue !== issue.originalValue) wireIssue.originalValue = wireValue;
          }
          const wirePath = [...issue.path];
          if (this.usesTemporalIR && this.conditional.has(String(previousPlan?.profileRef)) &&
            Array.isArray(previousPlan?.continuationAssertions) && previousPlan.continuationAssertions.length > 0 &&
            wirePath[0] === "temporalPlan" && wirePath[1] === "continuationAssertions" &&
            Number.isSafeInteger(wirePath[2]) && Number(wirePath[2]) >= 0) {
            const position = Number(wirePath[2]);
            wirePath.splice(2, 1, ...(position === 0 ? ["first"] : ["rest", position - 1]));
          }
          if (this.namedTemporalContracts && wirePath.length === 2 && wirePath[0] === "temporalPlan" && wirePath[1] === "profileRef") {
            const selector = this.selectors.get(String(previousPlan?.profileRef));
            if (selector) wirePath.push(selector);
          }
          return { ...wireIssue, path: wirePath };
        }) : mappedIssues;
        return { ...item, previousAttempt: encoded.slots[0], ...(wireIssues === undefined ? {} : { issues: wireIssues }) };
      });
    }
    return mapped;
  }

  encodeOutput(value: unknown): unknown {
    let mapped = mapOutputReferences(value, canonicalSchema, this.encodeKey);
    if (this.usesTemporalIR) mapped = mapPlans(mapped, (plan) => {
      const canonical = this.usesAliases ? this.inverseAliases.get(String(plan.profileRef)) : plan.profileRef;
      if (!this.conditional.has(String(canonical))) return plan;
      const assertions = plan.continuationAssertions;
      // Keep malformed prior output inspectable in a repair context. Validation
      // remains the wire schema's job; never fabricate the missing assertion.
      if (!Array.isArray(assertions) || assertions.length === 0) return plan;
      return { ...plan, continuationAssertions: { first: assertions[0], rest: assertions.slice(1) } };
    });
    if (this.namedTemporalContracts) mapped = mapPlans(mapped, (plan) => {
      const canonical = this.usesAliases ? this.inverseAliases.get(String(plan.profileRef)) : String(plan.profileRef);
      const selector = canonical && this.selectors.get(canonical);
      if (!selector) return plan;
      return { ...plan, profileRef: { [selector]: plan.profileRef } };
    });
    return mapped;
  }

  decodeOutput(value: unknown): unknown {
    let mapped = structuredClone(value);
    if (this.namedTemporalContracts) mapped = mapPlans(mapped, (plan) => {
      const selection = record(plan.profileRef);
      // A contradictory operator is semantic evidence, not a wrapper to drop.
      // Keep malformed fields so canonical validation cannot localize them as a success.
      if (!selection) return { ...plan, profileRef: "invalid-temporal-selector" };
      const fields = Object.keys(selection);
      if (fields.length !== 1) return plan;
      const field = fields[0]!, value = selection[field];
      const canonical = this.usesAliases ? this.inverseAliases.get(String(value)) : String(value);
      if (!canonical || this.selectors.get(canonical) !== field) return plan;
      return { ...plan, profileRef: value };
    });
    if (this.usesTemporalIR) mapped = mapPlans(mapped, (plan) => {
      const assertions = record(plan.continuationAssertions);
      return assertions && Object.hasOwn(assertions, "first") && Array.isArray(assertions.rest)
        ? { ...plan, continuationAssertions: [assertions.first, ...assertions.rest] } : plan;
    });
    return mapOutputReferences(mapped, canonicalSchema, this.decodeKey);
  }

  decodeValidated(value: unknown): ActionCompilationBatchDraft {
    return actionCompilationBatchSchema.parse(this.decodeOutput(value));
  }

  wireSchema(context: unknown, eligibleProfilesOnly = false, profileChoiceEvidence = false, sourceSchema?: z.ZodType): z.ZodType {
    if (profileChoiceEvidence && !this.usesTemporalIR) throw new Error("profile choice evidence requires a temporal representation");
    const slots = record(record(context)?.task)?.slots;
    if (!Array.isArray(slots)) throw new Error("compilation schema requires actual request slots");
    const requestSchema = sourceSchema ?? actionCompilationRequestSchema(slots.length);
    if (this.representation === "B1") return requestSchema;
    const schema = z.toJSONSchema(requestSchema, { target: "draft-07" }) as Schema;
    const replacePatterns = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(replacePatterns); return; }
      const object = record(value);
      if (!object) return;
      if (this.usesAliases && object.pattern === canonicalPattern) object.pattern = aliasPattern;
      Object.values(object).forEach(replacePatterns);
    };
    replacePatterns(schema);
    if (this.usesTemporalIR) {
      const slot = ((schema.properties as Schema).slots as Schema).items as Schema;
      const properties = slot.properties as Schema;
      const plan = properties.temporalPlan as Schema;
      let available = profiles(context, this.profileKinds);
      if (eligibleProfilesOnly) {
        const slots = record(record(context)?.task)?.slots;
        if (!Array.isArray(slots) || !slots.length) throw new Error("eligible profile schema requires actual request slots");
        const eligible = new Set<string>();
        for (const slot of slots) {
          const rows = record(slot)?.temporalProfileEligibility;
          if (!Array.isArray(rows) || !rows.length || rows.some((row) =>
            typeof record(row)?.profileRef !== "string" || typeof record(row)?.eligible !== "boolean")) {
            throw new Error("eligible profile schema requires trusted eligibility for every slot");
          }
          for (const row of rows) if (row.eligible) eligible.add(row.profileRef);
        }
        // An array item schema is shared by all slots. Use the UNION, never
        // their intersection: per-slot eligibility stays with the compiler.
        available = available.filter((profile) => eligible.has(profile.key));
        if (!available.length) throw new Error("eligible profile schema has no legal profile in this request");
      }
      const branches = [false, true].flatMap((conditional) => {
        const selectedProfiles = available.filter((profile) => profile.conditional === conditional);
        const keys = selectedProfiles.map((profile) => this.encodeKey(profile.key));
        if (!keys.length) return [];
        const branch = structuredClone(plan);
        const fields = branch.properties as Schema;
        fields.profileRef = { type: "string", enum: keys };
        if (profileChoiceEvidence) {
          const candidates = record(record(context)?.referenceCatalog)?.candidates as RecordValue[];
          fields.profileRef = { oneOf: keys.map((key) => {
            const candidate = candidates.find((candidate) => this.encodeKey(String(candidate.candidateKey)) === key);
            if (!candidate || candidate.kind !== "temporal_profile" || !record(candidate.details)) {
              throw new Error("profile choice evidence requires already visible profile details");
            }
            return { type: "string", const: key, description: JSON.stringify({ label: candidate.label, details: candidate.details }) };
          }) };
        }
        if (conditional) {
          const assertion = (fields.continuationAssertions as Schema).items;
          fields.continuationAssertions = { type: "object", properties: { first: assertion, rest: { type: "array", items: assertion } }, required: ["first", "rest"], additionalProperties: false };
        }
        if (this.namedTemporalContracts) {
          // Factor the large assertion schema once per existing conditional
          // shape; only the small profile selector varies by authored kind.
          const evidence = fields.profileRef as Schema;
          fields.profileRef = { oneOf: [...new Set(selectedProfiles.map((profile) => profile.kind))].map((kind) => {
            const selector = TEMPORAL_CONTRACT_SELECTORS[kind]!;
            const kindKeys = selectedProfiles.filter((profile) => profile.kind === kind).map((profile) => this.encodeKey(profile.key));
            const value = profileChoiceEvidence ? { oneOf: (evidence.oneOf as Schema[]).filter((choice) => kindKeys.includes(String(choice.const))) }
              : { type: "string", enum: kindKeys };
            return { type: "object", properties: { [selector]: value }, required: [selector], additionalProperties: false };
          }) };
        }
        return [branch];
      });
      properties.temporalPlan = { oneOf: branches };
    }
    return z.fromJSONSchema(schema);
  }
}
