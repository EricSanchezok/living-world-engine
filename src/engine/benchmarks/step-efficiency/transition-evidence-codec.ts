import { z } from "zod";
import { modelCausalAssertionSchema, type ModelCausalAssertion } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { loadPromptAsset } from "../../prompts";
import type { StructuredModelRequest } from "../../models/model-provider";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const groups = { operations: "before", mechanicInvocations: "before", events: "after", outcomes: "after" } as const;
interface InputFact { key: string; assertion: ModelCausalAssertion; sourcePath: string }

/** Semantic expansion only: the model selects an existing input fact or an
 * explicitly proposed operation. Raw selector choices remain in HTTP evidence.
 * No action, effect, cause, status or state value is repaired or invented. */
export class TransitionEvidenceCodec {
  readonly contextHash: string;
  readonly inputFacts: readonly InputFact[];

  constructor(context: unknown) {
    if (!object(context) || !object(context.state) || !object(context.state.canonicalTruth) || !object(context.referenceCatalog) || !Array.isArray(context.referenceCatalog.candidates)) throw new Error("transition evidence context missing");
    const truth = context.state.canonicalTruth;
    const allowed = new Set(context.referenceCatalog.candidates.filter((candidate) => object(candidate) && Array.isArray(candidate.allowedUses) && candidate.allowedUses.includes("assertion"))
      .map((candidate) => (candidate as ObjectValue).handle));
    const facts: InputFact[] = [];
    const add = (assertion: unknown, sourcePath: string) => {
      facts.push({ key: `input_${facts.length.toString(36)}`, assertion: modelCausalAssertionSchema.parse(assertion), sourcePath });
    };
    add({ kind: "elapsed_seconds_compare", operator: "eq", value: truth.elapsedSeconds }, "/state/canonicalTruth/elapsedSeconds");
    if (!object(truth.entities) || !object(truth.facts)) throw new Error("typed input truth missing");
    for (const [ref, entity] of Object.entries(truth.entities)) {
      if (!allowed.has(ref) || !object(entity)) continue;
      add({ kind: "entity_lifecycle", entityRef: ref, expected: entity.lifecycle }, `/state/canonicalTruth/entities/${ref}/lifecycle`);
      if (entity.placementRef === null || allowed.has(entity.placementRef)) {
        add({ kind: "placement_equals", entityRef: ref, placementRef: entity.placementRef }, `/state/canonicalTruth/entities/${ref}/placementRef`);
      }
    }
    for (const [ref, fact] of Object.entries(truth.facts)) {
      if (allowed.has(ref) && object(fact)) add({ kind: "fact_matches", factRef: ref, expected: fact.value }, `/state/canonicalTruth/facts/${ref}/value`);
    }
    this.contextHash = contentHash(context);this.inputFacts = facts;
  }

  private assertBinding(context: unknown) {
    if (contentHash(context) !== this.contextHash) throw new Error("transition evidence snapshot mismatch");
  }

  context(context: unknown): ObjectValue {
    this.assertBinding(context);
    const clone = structuredClone(context) as ObjectValue, state = clone.state as ObjectValue;
    if (Object.hasOwn(state, "inputStateFacts")) throw new Error("input fact table collision");
    state.inputStateFacts = { contextHash: this.contextHash, entries: this.inputFacts };
    return clone;
  }

  schema(schema: unknown): ObjectValue {
    const clone = structuredClone(schema);
    if (!object(clone) || !object(clone.properties)) throw new Error("transition root schema missing");
    const inputFact = z.toJSONSchema(z.strictObject({ kind: z.literal("input_state_fact"), key: z.enum(this.inputFacts.map((fact) => fact.key) as [string, ...string[]]) }), { target: "draft-07" });
    const effect = z.toJSONSchema(z.strictObject({ kind: z.literal("operation_effect"), operationIndex: z.number().int().nonnegative() }), { target: "draft-07" });
    const changeItem = (node: unknown, added: unknown): void => {
      if (!object(node)) throw new Error("transition item schema missing");
      const alternatives = node.oneOf ?? node.anyOf;
      if (Array.isArray(alternatives)) { alternatives.forEach((item) => changeItem(item, added));return; }
      if (!object(node.properties) || !object(node.properties.assertions) || !object(node.properties.assertions.items)) throw new Error("typed causal assertion schema missing");
      node.properties.assertions.items = { anyOf: [added, node.properties.assertions.items] };
    };
    for (const [group, timing] of Object.entries(groups)) {
      const array = clone.properties[group];
      if (!object(array) || array.type !== "array") throw new Error("transition group schema missing");
      changeItem(array.items, timing === "before" ? inputFact : effect);
    }
    return clone;
  }

  output(value: unknown, context: unknown): unknown {
    this.assertBinding(context);
    const clone = structuredClone(value);
    if (!object(clone) || !Array.isArray(clone.operations)) throw new Error("explicit transition operations missing");
    const operations = clone.operations;
    for (const [group, timing] of Object.entries(groups)) {
      const rows = clone[group];
      if (!Array.isArray(rows)) throw new Error("transition group missing");
      for (const row of rows) {
        if (!object(row) || !Array.isArray(row.assertions)) throw new Error("transition assertions missing");
        row.assertions = row.assertions.map((assertion) => {
          if (!object(assertion)) throw new Error("typed transition assertion missing");
          if (assertion.kind === "input_state_fact") {
            if (timing !== "before" || Object.keys(assertion).sort().join(",") !== "key,kind") throw new Error("input-state selector outside preconditions");
            const fact = this.inputFacts.find((entry) => entry.key === assertion.key);
            if (!fact) throw new Error("unknown input-state fact");
            return structuredClone(fact.assertion);
          }
          if (assertion.kind === "operation_effect") {
            if (timing !== "after" || Object.keys(assertion).sort().join(",") !== "kind,operationIndex" || !Number.isSafeInteger(assertion.operationIndex) || (assertion.operationIndex as number) < 0) throw new Error("effect witness outside final assertions");
            const operation = operations[assertion.operationIndex as number];
            if (!object(operation)) throw new Error("effect witness refers to a missing operation");
            if (operation.kind === "place_entity") return modelCausalAssertionSchema.parse({ kind: "placement_equals", entityRef: operation.entityRef, placementRef: operation.placementRef });
            if (operation.kind === "retire_entity") return modelCausalAssertionSchema.parse({ kind: "entity_lifecycle", entityRef: operation.entityRef, expected: "retired" });
            throw new Error("effect witness requires an explicit place_entity or retire_entity operation");
          }
          return assertion;
        });
      }
    }
    return clone;
  }
}

export function transitionEvidenceRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  const codec = new TransitionEvidenceCodec(request.context);
  const system = request.system + "\n\n" + loadPromptAsset("shared/transition-evidence-selectors.md");
  const wireJsonSchema = codec.schema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  return { ...request, system, context: codec.context(request.context), wireJsonSchema,
    promptVersion: `${request.promptVersion}/input-effect-evidence-v1@${contentHash({ system, wireJsonSchema }).slice(0, 16)}`,
    preprocessOutput: (raw) => {
      const expanded = codec.output(raw, request.context);
      return request.preprocessOutput?.(expanded) ?? { value: expanded, symbolRepairs: [] };
    } };
}
