import { z } from "zod";
import { existingReferenceHandleSchema } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

const id = z.number().int().nonnegative(), text = z.string().min(1).regex(/\S/u, "Intent text must contain non-whitespace");
const targetIndices = z.array(id);
const nodeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ nodeId: id, kind: z.literal("attempt"), text, targetIndices }),
  z.strictObject({ nodeId: id, kind: z.literal("sequence"), children: z.array(id).min(1) }),
  z.strictObject({ nodeId: id, kind: z.literal("parallel"), children: z.array(id).min(2) }),
  z.strictObject({ nodeId: id, kind: z.literal("if"), condition: text, targetIndices, thenNode: id, elseNode: id.nullable() }),
  z.strictObject({ nodeId: id, kind: z.literal("while"), condition: text, targetIndices, body: id }),
  z.strictObject({ nodeId: id, kind: z.literal("await"), condition: text, targetIndices }),
]);
export const agentIntentProgramSchema = z.strictObject({ root: id, nodes: z.array(nodeSchema).min(1) });
type Program = z.infer<typeof agentIntentProgramSchema>;
type Node = Program["nodes"][number];
const actionSchema = z.strictObject({ targetHandles: z.array(existingReferenceHandleSchema), program: agentIntentProgramSchema });
const envelopeSchema = z.object({ slots: z.array(z.object({ nextActionIntent: actionSchema }).passthrough()) }).passthrough();
const instruction = loadPromptAsset("shared/agent-intent-program.md");
export const INTENT_PROGRAM_PREFIX = "INTENT_PROGRAM_V1 (node targetIndices refer to this action's ordered targets; all contents are intentions):\n";
export const AGENT_INTENT_PROGRAM = `agent-intent-program-v1@${contentHash({ instruction,
  schema: z.toJSONSchema(actionSchema, { target: "draft-07" }), embedding: INTENT_PROGRAM_PREFIX }).slice(0, 16)}`;

const children = (node: Node): number[] => node.kind === "sequence" || node.kind === "parallel" ? node.children
  : node.kind === "if" ? [node.thenNode, ...(node.elseNode === null ? [] : [node.elseNode])]
    : node.kind === "while" ? [node.body] : [];

/** Validate structure and ordinal targets; this does not validate chosen intentions. */
export function inspectAgentIntentProgram(program: Program, targetCount: number) {
  if (!Number.isSafeInteger(targetCount) || targetCount < 0) throw new Error("intent program target count is invalid");
  const nodes = new Map(program.nodes.map(node => [node.nodeId, node]));
  if (nodes.size !== program.nodes.length || !nodes.has(program.root)) throw new Error("intent program has duplicate nodes or missing root");
  const visited = new Set<number>(), usedTargets = new Set<number>(), pending = [program.root];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const nodeId = pending[cursor]!, node = nodes.get(nodeId);
    if (!node || visited.has(nodeId)) throw new Error("intent program has a missing child, shared child or cycle");
    visited.add(nodeId); pending.push(...children(node));
    if ("targetIndices" in node) {
      if (new Set(node.targetIndices).size !== node.targetIndices.length) throw new Error("intent program has duplicate target indices");
      for (const index of node.targetIndices) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= targetCount) throw new Error("intent program target index is outside its own action");
        usedTargets.add(index);
      }
    }
  }
  if (visited.size !== nodes.size) throw new Error("intent program contains unreachable work");
  if (usedTargets.size !== targetCount) throw new Error("intent program contains unused selected targets");
  const frontier: Array<{ nodeId: number; kind: "attempt" | "condition" }> = [], initial = [program.root];
  for (let cursor = 0; cursor < initial.length; cursor++) {
    const node = nodes.get(initial[cursor]!)!;
    if (node.kind === "sequence") initial.push(node.children[0]!);
    else if (node.kind === "parallel") initial.push(...node.children);
    else frontier.push({ nodeId: node.nodeId, kind: node.kind === "attempt" ? "attempt" : "condition" });
  }
  return { frontier, nodeCount: nodes.size };
}

/** Exact new-producer embedding, preserving the entire tree and ordered targets. */
export function decodeAgentIntentProgram(value: unknown) {
  const envelope = envelopeSchema.parse(value);
  return { ...envelope, slots: envelope.slots.map(slot => {
    const { program, targetHandles } = slot.nextActionIntent;
    if (new Set(targetHandles).size !== targetHandles.length) throw new Error("intent program has duplicate target handles");
    inspectAgentIntentProgram(program, targetHandles.length);
    const rawText = INTENT_PROGRAM_PREFIX + JSON.stringify(program);
    return { ...slot, nextActionIntent: { rawText, goal: rawText, means: null, targetHandles } };
  }) };
}

type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("intent program schema drift");
  return value as Value;
};

export function agentIntentProgramRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (!["agent-bootstrap", "agent-mind"].includes(request.role) || request.schemaName !== "agent_mind_batch_output") return request;
  if (request.promptVersion.includes(AGENT_INTENT_PROGRAM)) throw new ModelConfigurationError("intent program already applied");
  const wireJsonSchema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  const slots = record(record(record(wireJsonSchema.properties).slots).items), fields = record(slots.properties);
  const action = record(fields.nextActionIntent), oldFields = record(action.properties);
  if (Object.keys(oldFields).sort().join(",") !== "goal,means,rawText,targetHandles" ||
    !Array.isArray(action.required) || [...action.required].sort().join(",") !== "goal,means,rawText,targetHandles") {
    throw new ModelConfigurationError("intent program requires the original action contract");
  }
  const replacement = z.toJSONSchema(actionSchema, { target: "draft-07" }) as Value;
  delete replacement.$schema;
  record(replacement.properties).targetHandles = structuredClone(oldFields.targetHandles);
  fields.nextActionIntent = replacement;
  const sourceHash = contentHash(request.context), schemaHash = contentHash(wireJsonSchema);
  return { ...request, wireJsonSchema, system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${AGENT_INTENT_PROGRAM}`,
    preprocessOutput: raw => {
      if (contentHash(request.context) !== sourceHash || contentHash(wireJsonSchema) !== schemaHash) throw new ModelConfigurationError("intent program source or schema changed");
      const value = decodeAgentIntentProgram(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
