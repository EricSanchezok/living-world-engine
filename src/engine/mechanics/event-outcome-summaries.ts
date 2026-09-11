import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../models/model-provider";
import { PHYSICAL_BATCH_REPAIR_NOTICE } from "../prompts/repair-layout";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
export const EVENT_OUTCOME_INSTRUCTION = "Outcome rows do not contain summary in this wire contract. Select status and all causal evidence explicitly. Put every proposed realized sub-action, including a communication or dispatch, in the existing events or state-operation channels with supported causes and assertions; intention or preparation alone is not realization. Event descriptions remain unrestricted natural language, subject to the original world, temporal, causal and knowledge rules. The engine derives each outcome summary from its status and same-slot event descriptions that directly cite its source action. It supplies no events, facts, success or missing effects. If only continuing work is supported, retain continuing without inventing an occurrence. Do not emit summary or replace required semantic event/state records with outcome prose. Preserve all original non-summary fields and every assigned action. This applies independently to every logical slot and repair.";
const assertionInstruction = "Choose causal assertion kinds and fields from the output contract below. The input temporalBoundary.reasons and Activity plan describe scheduling; they are not output assertion templates. In particular, activity_checkpoint is a scheduling reason, not a causal assertion kind, and reaching a checkpoint does not establish completion. Select status from the trusted lifecycle and receipt rules independently. For elapsed_seconds_compare on an outcome or event, evaluate the value after all operations at the supplied boundary; the Activity checkpoint timestamp is not that evaluation clock. Other supported assertions remain available, and realized effects still require their own causal evidence.";
export const EVENT_OUTCOME_SUMMARIES = `event-outcome-summaries-v2@${contentHash({ prose: EVENT_OUTCOME_INSTRUCTION, assertions: assertionInstruction }).slice(0, 16)}`;
const statusText: Record<string, string> = { succeeded: "行动成功。", partial: "行动部分成功。", failed: "行动失败。", blocked: "行动受阻。", continuing: "行动仍在继续。" };

interface SourceAction { slot: number; actionRef: string; actionIndex: number }

/** Reuses event prose; unlike a lossless codec, this contract has no independent outcome narration. */
export function eventOutcomeSummaryRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  const indexed = request.schemaName === "truth_transition_batch";
  if (request.role !== "truth-transition" || !indexed && request.schemaName !== "truth_transition") return request;
  if (request.promptVersion.includes(EVENT_OUTCOME_SUMMARIES) || !object(request.wireJsonSchema) || !object(request.context)) {
    throw new ModelConfigurationError("event outcome summaries require one bound transition wire contract");
  }
  const context = request.context, task = context.task;
  const worklist = object(task) && object(task.transitionWorklist) ? task.transitionWorklist : undefined;
  if (!worklist || !Array.isArray(worklist.actions)) throw new ModelConfigurationError("event outcome source actions are missing");
  const actions: SourceAction[] = worklist.actions.map((row, index) => {
    if (!object(row) || !object(row.action) || typeof row.action.actionRef !== "string" ||
      indexed && (!Number.isSafeInteger(row.slot) || !Number.isSafeInteger(row.actionIndex))) {
      throw new ModelConfigurationError("event outcome action ownership changed");
    }
    return { slot: indexed ? row.slot as number : 0, actionIndex: indexed ? row.actionIndex as number : index, actionRef: row.action.actionRef };
  });
  if (new Set(actions.map(action => indexed ? action.actionIndex : action.actionRef)).size !== actions.length) {
    throw new ModelConfigurationError("event outcome source actions are ambiguous");
  }
  const schema = structuredClone(request.wireJsonSchema);
  const outcomes = object(schema.properties) ? schema.properties.outcomes : undefined;
  const item = object(outcomes) ? outcomes.items : undefined;
  if (!object(item) || !object(item.properties) || !object(item.properties.summary) || item.properties.summary.type !== "string" ||
    !Array.isArray(item.required) || !item.required.includes("summary")) throw new ModelConfigurationError("event outcome schema drift");
  delete item.properties.summary;
  item.required = item.required.filter(field => field !== "summary");
  const assertionSchema = object(schema.definitions) ? schema.definitions.causalAssertion : undefined;
  if (!object(assertionSchema) || !Array.isArray(assertionSchema.oneOf)) throw new ModelConfigurationError("event outcome assertion vocabulary missing");
  const vocabulary = assertionSchema.oneOf.map(variant => {
    const properties = object(variant) && variant.properties;
    const kind = object(properties) && properties.kind;
    if (!object(variant) || !object(kind) || typeof kind.const !== "string" || !Array.isArray(variant.required)) {
      throw new ModelConfigurationError("event outcome assertion vocabulary changed");
    }
    return { kind: kind.const, requiredFields: variant.required.filter(field => field !== "kind") };
  });
  const instruction = EVENT_OUTCOME_INSTRUCTION + "\n\n" + assertionInstruction + "\nOutput assertion vocabulary (complete field types are in JSON Schema): " + JSON.stringify(vocabulary);
  const originalPrompt = request.userPrompt.replace("Keep proposalKey, status, summary and causes explicit.", "Keep proposalKey, status and causes explicit.");
  const repairSuffix = "\n\n" + PHYSICAL_BATCH_REPAIR_NOTICE;
  const userPrompt = originalPrompt.endsWith(repairSuffix)
    ? originalPrompt.slice(0, -repairSuffix.length) + "\n\n" + instruction + repairSuffix
    : originalPrompt + "\n\n" + instruction;
  return { ...request, wireJsonSchema: schema, userPrompt,
    promptVersion: `${request.promptVersion}/${EVENT_OUTCOME_SUMMARIES}@${contentHash({ schema, sources: actions }).slice(0, 16)}`,
    preprocessOutput: value => {
      let expanded = value;
      if (object(value) && Array.isArray(value.outcomes)) {
        const events = Array.isArray(value.events) ? value.events : [];
        expanded = { ...value, outcomes: value.outcomes.map(row => {
          if (!object(row)) return row;
          if (Object.hasOwn(row, "summary")) return { ...row, eventSummaryError: "independent summary is not permitted" };
          const source = actions.find(action => indexed ? action.actionIndex === row.actionIndex : action.actionRef === row.actionRef);
          if (!source || typeof row.status !== "string" || !Object.hasOwn(statusText, row.status)) return row;
          const descriptions = events.flatMap(event => object(event) && (indexed ? event.slot === source.slot : true) &&
            typeof event.description === "string" && Array.isArray(event.causes) && event.causes.some(cause =>
              object(cause) && cause.kind === "action" && cause.ref === source.actionRef) ? [event.description] : []);
          return { ...row, summary: statusText[row.status] + (descriptions.length ? "\n直接引用本行动的事件：\n" + descriptions.join("\n") : "") };
        }) };
      }
      return request.preprocessOutput ? request.preprocessOutput(expanded) : { value: expanded, symbolRepairs: [] };
    },
  };
}
