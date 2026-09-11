import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../models/model-provider";
import { PHYSICAL_BATCH_REPAIR_NOTICE } from "../prompts/repair-layout";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const instruction = "For every outcome, explicitly emit boundaryClock: true. This selects the supplied final temporal boundary as a clock witness; the decoder emits elapsed_seconds_compare eq that action's temporalBoundary.toElapsedSeconds, and the usual causal validator checks it after the engine's final time advance. It does not assert completion, success, a realized event or satisfaction of other conditions. The boundary may equal or pass an Activity checkpoint while the action continues; a checkpoint is not a deadline or completion boundary. This witness replaces the outcome's required first clock/evidence item. Keep any additional causal assertions needed to support actual proposed consequences in the remaining assertion list, using the original schema. Never infer elapsed < nextBoundary from continuing status. Do not emit firstAssertion in indexed outcomes; canonical outcomes retain assertions as the additional list. All event, operation and mechanic assertion fields are unchanged. Preserve every action, source identity, status choice and realized effect.";
const indexedInstruction = "Every outcome requires boundaryClock: true and additionalAssertions (the explicit array of any further causal assertions). The decoder restores the selected clock witness followed by every additional assertion in order. Do not emit assertions or firstAssertion inside an outcome; other categories retain their original assertions arrays. Select supported predicates and exact values for additional evidence yourself.";
export const BOUNDARY_CLOCK_WITNESS = `source-boundary-clock-v1@${contentHash({ instruction, indexedInstruction }).slice(0, 16)}`;

/** An explicit reference to a trusted proposed clock; actual causal validation still decides truth. */
export function boundaryClockWitnessRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  const indexed = request.schemaName === "truth_transition_batch";
  if (request.role !== "truth-transition" || !indexed && request.schemaName !== "truth_transition") return request;
  if (!object(request.context) || !object(request.wireJsonSchema) || request.promptVersion.includes(BOUNDARY_CLOCK_WITNESS)) {
    throw new ModelConfigurationError("boundary witness requires one bound transition schema");
  }
  const task = request.context.task, worklist = object(task) && task.transitionWorklist;
  if (!object(worklist) || typeof worklist.sourceContextHash !== "string" || !Array.isArray(worklist.actions)) throw new ModelConfigurationError("boundary witness source missing");
  const sources = worklist.actions.map((row, index) => {
    const boundary = object(row) && row.temporalBoundary;
    if (!object(row) || !object(row.action) || typeof row.action.actionRef !== "string" ||
      !object(boundary) || !Number.isSafeInteger(boundary.fromElapsedSeconds) || !Number.isSafeInteger(boundary.toElapsedSeconds) ||
      !Number.isSafeInteger(boundary.deltaSeconds) || (boundary.deltaSeconds as number) <= 0 ||
      (boundary.fromElapsedSeconds as number) + (boundary.deltaSeconds as number) !== boundary.toElapsedSeconds ||
      indexed && (!Number.isSafeInteger(row.actionIndex) || (row.actionIndex as number) < 0)) throw new ModelConfigurationError("boundary witness clock binding invalid");
    return { actionRef: row.action.actionRef, actionIndex: indexed ? row.actionIndex as number : index, value: boundary.toElapsedSeconds as number };
  });
  if (new Set(sources.map(source => indexed ? source.actionIndex : source.actionRef)).size !== sources.length) throw new ModelConfigurationError("boundary witness ambiguous source");
  const schema = structuredClone(request.wireJsonSchema), outcomes = object(schema.properties) && schema.properties.outcomes;
  const item = object(outcomes) && outcomes.items;
  if (!object(item) || !object(item.properties) || !Array.isArray(item.required) || Object.hasOwn(item.properties, "boundaryClock")) throw new ModelConfigurationError("boundary witness outcome schema changed");
  if (indexed) {
    if (!object(item.properties.firstAssertion) || !item.required.includes("firstAssertion") || !object(item.properties.additionalAssertions)) throw new ModelConfigurationError("boundary witness indexed assertion schema changed");
    delete item.properties.firstAssertion;
    item.required = item.required.filter(field => field !== "firstAssertion");
  } else {
    const assertions = item.properties.assertions;
    if (!object(assertions) || assertions.type !== "array" || assertions.minItems !== 1 || !item.required.includes("assertions")) throw new ModelConfigurationError("boundary witness canonical assertion schema changed");
    assertions.minItems = 0;
  }
  item.properties.boundaryClock = { type: "boolean", const: true };
  (item.required as string[]).push("boundaryClock");
  let originalPrompt = request.userPrompt;
  if (indexed) {
    const originalClause = "Every outcome requires firstAssertion (one complete typed assertion object) and additionalAssertions (an explicit array of every remaining assertion, empty only when there are no more). These restore the canonical nonempty assertions list in exactly that order. Do not emit assertions inside an outcome or omit its firstAssertion; other categories retain their original assertions arrays. Select supported, relevant predicates and exact values yourself: the codec supplies no evidence.";
    if (originalPrompt.split(originalClause).length !== 2) throw new ModelConfigurationError("boundary witness indexed instruction changed");
    originalPrompt = originalPrompt.replace(originalClause, indexedInstruction);
  }
  const repairSuffix = "\n\n" + PHYSICAL_BATCH_REPAIR_NOTICE;
  const userPrompt = originalPrompt.endsWith(repairSuffix)
    ? originalPrompt.slice(0, -repairSuffix.length) + "\n\n" + instruction + repairSuffix
    : originalPrompt + "\n\n" + instruction;
  return { ...request, wireJsonSchema: schema, userPrompt,
    promptVersion: `${request.promptVersion}/${BOUNDARY_CLOCK_WITNESS}@${contentHash({ schema, sources, userPrompt }).slice(0, 16)}`,
    preprocessOutput: value => {
      let decoded = value;
      if (object(value) && Array.isArray(value.outcomes)) decoded = { ...value, outcomes: value.outcomes.map(row => {
        if (!object(row)) return row;
        const source = sources.find(source => indexed ? source.actionIndex === row.actionIndex : source.actionRef === row.actionRef);
        if (!source || row.boundaryClock !== true || indexed && Object.hasOwn(row, "firstAssertion") || !indexed && !Array.isArray(row.assertions)) {
          return { ...row, boundaryClockError: "an explicit source boundary witness is required" };
        }
        const copy = { ...row }; delete copy.boundaryClock;
        const assertion = { kind: "elapsed_seconds_compare", operator: "eq", value: source.value };
        return indexed ? { ...copy, firstAssertion: assertion } : { ...copy, assertions: [assertion, ...(row.assertions as unknown[])] };
      }) };
      return request.preprocessOutput?.(decoded) ?? { value: decoded, symbolRepairs: [] };
    },
  };
}
