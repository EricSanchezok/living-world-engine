import { z } from "zod";
import { truthTransitionBatchSchema } from "../contracts/llm-schemas";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { FlatBatchArrayCodec } from "./flat-batch-arrays";
import { planSlotBinding } from "./flat-resolution-plan-batch";
import { expandSharedBatchContexts, type SharedBatchContext } from "./shared-batch-context";
import { bindTruthBatchCardinality, SHARED_SLOT_RESULT_INSTRUCTION } from "./truth-batch-provider";
import { compactTransitionAssertionSchema } from "./transition-schema-references";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): never => { throw new z.ZodError([{ code: "custom", path: [], message: `indexed transition: ${message}` }]); };
export const SOURCE_INDEXED_TRANSITION = "source-indexed-transition-v4";
const instruction = loadPromptAsset("shared/source-indexed-transition.md");

/** Identity selection and array regrouping only. All semantic fields remain explicit. */
export class SourceIndexedTransitionCodec {
  readonly base: FlatBatchArrayCodec;
  readonly sourceHash: string;
  readonly actions: Array<{ actionIndex: number; slot: number; action: ObjectValue }>;
  readonly wireSchema: ObjectValue;

  constructor(context: unknown) {
    const binding = planSlotBinding(context);
    const contexts = expandSharedBatchContexts((context as { state: SharedBatchContext }).state);
    this.sourceHash = contentHash(context);
    this.actions = contexts.flatMap((entry, slot) => {
      const actions = (entry.state as { actionSet: { assigned: ObjectValue[] } }).actionSet.assigned;
      if (contentHash(actions.map(action => action.actionRef)) !== contentHash(binding[slot])) throw new ModelConfigurationError("transition action binding mismatch");
      return actions.map(action => ({ actionIndex: 0, slot, action: structuredClone(action) }));
    }).map((entry, actionIndex) => ({ ...entry, actionIndex }));
    this.base = new FlatBatchArrayCodec(truthTransitionBatchSchema, contexts.length);
    this.wireSchema = structuredClone(this.base.wireSchema);
    const properties = this.wireSchema.properties as ObjectValue;
    const outcomes = properties.outcomes as ObjectValue, item = outcomes.items as ObjectValue;
    if (!object(item.properties) || !Array.isArray(item.required) || !Object.hasOwn(item.properties, "actionRef") || !Object.hasOwn(item.properties, "slot")) throw new ModelConfigurationError("transition outcome schema drift");
    delete item.properties.slot; delete item.properties.actionRef;
    item.properties = { actionIndex: { type: "integer", minimum: 0, maximum: this.actions.length - 1 }, ...item.properties };
    item.required = ["actionIndex", ...item.required.filter(key => key !== "slot" && key !== "actionRef")];
    const outcomeProperties = item.properties as ObjectValue;
    const assertions = outcomeProperties.assertions;
    if (!object(assertions) || assertions.type !== "array" || assertions.minItems !== 1 || !object(assertions.items)) throw new ModelConfigurationError("transition nonempty assertion schema drift");
    delete outcomeProperties.assertions;
    outcomeProperties.firstAssertion = structuredClone(assertions.items);
    outcomeProperties.additionalAssertions = { type: "array", items: structuredClone(assertions.items) };
    item.required = [...(item.required as string[]).filter(key => key !== "assertions"), "firstAssertion", "additionalAssertions"];
    outcomes.minItems = this.actions.length; outcomes.maxItems = this.actions.length;
    this.wireSchema = compactTransitionAssertionSchema(this.wireSchema);
  }

  context(source: unknown): ObjectValue {
    if (contentHash(source) !== this.sourceHash) throw new ModelConfigurationError("transition source snapshot changed");
    const copy = structuredClone(source) as ObjectValue, task = copy.task as ObjectValue;
    if (Object.hasOwn(task, "transitionWorklist")) throw new ModelConfigurationError("repeated transition worklist");
    task.transitionWorklist = { contract: SOURCE_INDEXED_TRANSITION, sourceContextHash: this.sourceHash,
      actionCount: this.actions.length, actions: structuredClone(this.actions) };
    return copy;
  }

  /** Canonical validation runs after regrouping so rejected slots retain valid neighbors. */
  decode(value: unknown): unknown {
    if (!object(value) || !Array.isArray(value.outcomes)) return invalid("explicit outcomes array required");
    const copy = structuredClone(value), seen = new Set<number>();
    copy.outcomes = value.outcomes.map(row => {
      if (!object(row) || typeof row.actionIndex !== "number" || !Number.isSafeInteger(row.actionIndex) || row.actionIndex < 0 ||
        !this.actions[row.actionIndex] || seen.has(row.actionIndex) || Object.hasOwn(row, "slot") || Object.hasOwn(row, "actionRef")) return invalid("unknown, duplicate or conflicting outcome identity");
      seen.add(row.actionIndex);
      const { actionIndex, ...fields } = row, source = this.actions[actionIndex as number]!;
      if (Object.hasOwn(fields, "assertions")) return invalid("conflicting canonical assertion list in indexed outcome");
      // Leave incomplete wire fields explicit for slot-local canonical rejection.
      if (!Object.hasOwn(fields, "firstAssertion") || !Array.isArray(fields.additionalAssertions)) {
        return { ...fields, slot: source.slot, actionRef: source.action.actionRef };
      }
      const { firstAssertion, additionalAssertions, ...canonical } = fields;
      return { ...canonical, slot: source.slot, actionRef: source.action.actionRef,
        assertions: [firstAssertion, ...additionalAssertions] };
    });
    if (seen.size !== this.actions.length) return invalid(`missing action indices: ${this.actions.filter(row => !seen.has(row.actionIndex)).map(row => row.actionIndex).join(", ")}`);
    try { return this.base.regroup(copy); } catch (error) {
      if (error instanceof z.ZodError) throw error;
      return invalid(error instanceof Error ? error.message : String(error));
    }
  }

  encode(value: unknown): ObjectValue {
    const wire = this.base.encode(value);
    wire.outcomes = (wire.outcomes as ObjectValue[]).map(row => {
      const source = this.actions.find(entry => entry.slot === row.slot && entry.action.actionRef === row.actionRef);
      if (!source) return invalid("canonical outcome has foreign action ownership");
      const fields = { ...row }; delete fields.slot; delete fields.actionRef; delete fields.assertions;
      const assertions = row.assertions as unknown[];
      return { actionIndex: source.actionIndex, ...fields, firstAssertion: assertions[0], additionalAssertions: assertions.slice(1) };
    });
    if (contentHash(this.decode(wire)) !== contentHash(value)) return invalid("canonical source coverage or round trip changed");
    return wire;
  }
}

export function indexedTransitionRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-transition" || request.schemaName !== "truth_transition_batch") return request;
  if (request.promptVersion.includes(`/${SOURCE_INDEXED_TRANSITION}@`) || request.wireJsonSchema ||
    request.userPrompt.split(SHARED_SLOT_RESULT_INSTRUCTION).length !== 2) throw new ModelConfigurationError("indexed transition request contract drift");
  const codec = new SourceIndexedTransitionCodec(request.context);
  const schemaHash = contentHash(z.toJSONSchema(request.schema, { target: "draft-07" }));
  if (![truthTransitionBatchSchema, bindTruthBatchCardinality(truthTransitionBatchSchema, codec.base.count)]
    .some(schema => contentHash(z.toJSONSchema(schema, { target: "draft-07" })) === schemaHash)) throw new ModelConfigurationError("indexed transition canonical schema drift");
  return { ...request, context: codec.context(request.context), wireJsonSchema: codec.wireSchema, jsonExamplePolicy: "omit",
    userPrompt: request.userPrompt.replace(SHARED_SLOT_RESULT_INSTRUCTION, instruction),
    promptVersion: `${request.promptVersion}/${SOURCE_INDEXED_TRANSITION}@${contentHash({ instruction, source: codec.sourceHash, schema: codec.wireSchema }).slice(0, 16)}`,
    preprocessOutput: raw => {
      const value = codec.decode(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    },
  };
}

export function indexedTransitionProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(indexedTransitionRequest(request)),
  };
}
