import { z } from "zod";
import type { AgentCognitionBatchInput } from "../../algorithms/roles";
import type { SimulationState } from "../../contracts/model";
import { referenceHandleFor } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { AGENT_RECURSIVE_INTENT, agentRecursiveIntentRequest, recursiveIntentSchema, decodeRecursiveIntent, expandIndexedIntent } from "./agent-recursive-intent";
import { INTENT_CONTINUE_PREFIX, readIntentMemory } from "./incremental-intent-execution";
import { IntentExecutionCursor } from "./intent-execution-cursor";

const instruction = loadPromptAsset("shared/agent-intent-control.md");
const continueSchema = z.strictObject({ kind: z.literal("continue") });
const controlSchema = z.discriminatedUnion("kind", [
  continueSchema,
  z.strictObject({ kind: z.literal("replace"), program: recursiveIntentSchema }),
]);
const outputSchema = z.object({ slots: z.array(z.object({ slot: z.number().int().nonnegative(), nextActionIntent: controlSchema }).passthrough()) }).passthrough();
export const AGENT_INTENT_CONTROL = `agent-intent-control-v2@${contentHash({ instruction, program: AGENT_RECURSIVE_INTENT,
  schema: z.toJSONSchema(controlSchema), continuation: INTENT_CONTINUE_PREFIX }).slice(0, 16)}`;
export interface IntentCognitionScope { state: SimulationState; inputs: readonly AgentCognitionBatchInput[] }
type ObjectValue = Record<string, unknown>;
const record = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("intent control context or schema changed");
  return value as ObjectValue;
};

export function agentIntentControlRequest<T>(request: StructuredModelRequest<T>, scope: IntentCognitionScope, producerHash: string): StructuredModelRequest<T> {
  if (!["agent-bootstrap", "agent-mind"].includes(request.role) || request.schemaName !== "agent_mind_batch_output") return request;
  const base = agentRecursiveIntentRequest(request), memory = readIntentMemory(scope.state.executionState, producerHash);
  const context = structuredClone(record(request.context));
  const slots = z.array(z.unknown()).parse(context.slots).map(record);
  const owners = new Map(scope.inputs.map(input => [referenceHandleFor("agent", input.agent.id), input]));
  const controls = slots.map(slot => {
    const agentState = record(slot.agentState), agentRef = record(agentState.perspective).agentRef;
    const input = typeof agentRef === "string" ? owners.get(agentRef as ReturnType<typeof referenceHandleFor>) : undefined;
    if (!input) throw new Error("intent control slot has no owning cognition input");
    const snapshot = memory.active[input.agent.id];
    if (!snapshot) return null;
    const cursor = IntentExecutionCursor.restore(snapshot);
    const ownAction = input.currentResolution.action, outcome = input.currentResolution.outcome?.status;
    const activity = ownAction && Object.values(scope.state.truth.activities).find(activity => activity.sourceActionId === ownAction.id);
    const isIssued = ownAction && cursor.frontier().some(work => work.issuedAction?.id === ownAction.id);
    const preview = cursor.previewCompletion(isIssued && outcome === "succeeded" && activity?.status === "completed" ? [ownAction.id] : []);
    const interrupted = ownAction && !isIssued && cursor.frontier().some(work => work.issuedAction);
    const canContinue = preview.status === "running" && !interrupted && !["failed", "blocked", "partial"].includes(outcome ?? "");
    agentState.intention = { sourceActionId: snapshot.source.action.id,
      program: expandIndexedIntent(snapshot.source.program, snapshot.source.action.targetIds.map(id => referenceHandleFor("local_entity", id))),
      committedStatus: cursor.status, afterCurrentResolution: preview, canContinue };
    return { snapshot, canContinue };
  });
  context.slots = slots;
  const wire = structuredClone(base.wireJsonSchema!);
  const slotSchema = record(record(record(wire.properties).slots).items);
  const fields = record(slotSchema.properties), replacement = record(fields.nextActionIntent);
  // Retain the recursive producer's document-level definitions and target domains.
  record(replacement.properties).kind = { type: "string", const: "replace" };
  replacement.required = [...z.array(z.string()).parse(replacement.required), "kind"];
  const continuation = z.toJSONSchema(continueSchema, { target: "draft-07" }) as ObjectValue;
  delete continuation.$schema;
  fields.nextActionIntent = { oneOf: [continuation, replacement] };
  const inputHash = contentHash(context);
  return { ...request, wireJsonSchema: wire, context, system: [base.system, instruction].join("\n\n"),
    promptVersion: `${base.promptVersion}/${AGENT_INTENT_CONTROL}`,
    preprocessOutput: raw => {
      if (contentHash(context) !== inputHash) throw new Error("intent control context changed during generation");
      const output = outputSchema.parse(raw);
      const translated = { ...output, slots: output.slots.map(slot => {
        if (!slots.some(source => source.slot === slot.slot)) throw new ModelOutputError("intent control returned an unknown slot");
        if (slot.nextActionIntent.kind === "replace") {
          const { kind: _kind, ...nextActionIntent } = slot.nextActionIntent;
          void _kind;
          return decodeRecursiveIntent({ slots: [{ ...slot, nextActionIntent }] }).slots[0]!;
        }
        const control = controls[slots.findIndex(source => source.slot === slot.slot)];
        if (!control?.canContinue) throw new ModelOutputError("this intention cannot continue; choose a new complete intention from the current perspective");
        const rawText = INTENT_CONTINUE_PREFIX + JSON.stringify({ sourceActionId: control.snapshot.source.action.id });
        return { ...slot, nextActionIntent: { rawText, goal: rawText, means: null,
          targetHandles: control.snapshot.source.action.targetIds.map(id => referenceHandleFor("local_entity", id)) } };
      }) };
      return request.preprocessOutput?.(translated) ?? { value: translated, symbolRepairs: [] };
    } };
}
