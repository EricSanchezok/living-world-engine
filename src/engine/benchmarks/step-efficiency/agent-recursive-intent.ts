import { z } from "zod";
import { existingReferenceHandleSchema } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { agentIntentProgramSchema, decodeAgentIntentProgram, inspectAgentIntentProgram, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";

export type RecursiveIntent =
  | { kind: "attempt"; text: string; targetHandles: string[] }
  | { kind: "sequence" | "parallel"; children: RecursiveIntent[] }
  | { kind: "if"; condition: string; targetHandles: string[]; thenNode: RecursiveIntent; elseNode: RecursiveIntent | null }
  | { kind: "while"; condition: string; targetHandles: string[]; body: RecursiveIntent }
  | { kind: "await"; condition: string; targetHandles: string[] };
const text = z.string().min(1).regex(/\S/u), targetHandles = z.array(existingReferenceHandleSchema);
export const recursiveIntentSchema: z.ZodType<RecursiveIntent> = z.lazy(() => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("attempt"), text, targetHandles }),
  z.strictObject({ kind: z.literal("sequence"), children: z.array(recursiveIntentSchema).min(1) }),
  z.strictObject({ kind: z.literal("parallel"), children: z.array(recursiveIntentSchema).min(2) }),
  z.strictObject({ kind: z.literal("if"), condition: text, targetHandles, thenNode: recursiveIntentSchema, elseNode: recursiveIntentSchema.nullable() }),
  z.strictObject({ kind: z.literal("while"), condition: text, targetHandles, body: recursiveIntentSchema }),
  z.strictObject({ kind: z.literal("await"), condition: text, targetHandles }),
]));
const actionSchema = z.strictObject({ program: recursiveIntentSchema });
const envelopeSchema = z.object({ slots: z.array(z.object({ nextActionIntent: actionSchema }).passthrough()) }).passthrough();
const instruction = loadPromptAsset("shared/agent-recursive-intent.md");
export const AGENT_RECURSIVE_INTENT = `agent-recursive-intent-v1@${contentHash({ instruction,
  schema: z.toJSONSchema(actionSchema, { target: "draft-07" }), lowering: "preorder-first-target-occurrence-v1", embedding: INTENT_PROGRAM_PREFIX }).slice(0, 16)}`;
type Program = z.infer<typeof agentIntentProgramSchema>;

/** Preserve the complete tree; indices are not execution decisions. Rationale: decision 0210. */
export function lowerRecursiveIntent(tree: RecursiveIntent) {
  const nodes: Program["nodes"] = [], handles: string[] = [];
  let nextNodeId = 0;
  const indices = (refs: string[]) => refs.map(ref => { let index = handles.indexOf(ref); if (index < 0) { index = handles.length; handles.push(ref); } return index; });
  const visit = (node: RecursiveIntent): number => {
    const nodeId = nextNodeId++;
    if (node.kind === "attempt") nodes[nodeId] = { nodeId, kind: node.kind, text: node.text, targetIndices: indices(node.targetHandles) };
    else if (node.kind === "sequence" || node.kind === "parallel") nodes[nodeId] = { nodeId, kind: node.kind, children: node.children.map(visit) };
    else if (node.kind === "await") nodes[nodeId] = { nodeId, kind: node.kind, condition: node.condition, targetIndices: indices(node.targetHandles) };
    else if (node.kind === "if") nodes[nodeId] = { nodeId, kind: node.kind, condition: node.condition, targetIndices: indices(node.targetHandles), thenNode: visit(node.thenNode), elseNode: node.elseNode === null ? null : visit(node.elseNode) };
    else if (node.kind === "while") nodes[nodeId] = { nodeId, kind: node.kind, condition: node.condition, targetIndices: indices(node.targetHandles), body: visit(node.body) };
    return nodeId;
  };
  const program = { root: visit(tree), nodes };
  inspectAgentIntentProgram(program, handles.length);
  return { program, targetHandles: handles };
}

/** Reconstruct the complete nested value for fixtures and semantic inspection. */
export function expandIndexedIntent(program: Program, handles: string[]): RecursiveIntent {
  inspectAgentIntentProgram(program, handles.length);
  const nodes = new Map(program.nodes.map(node => [node.nodeId, node]));
  const visit = (id: number): RecursiveIntent => {
    const node = nodes.get(id)!;
    if (node.kind === "sequence" || node.kind === "parallel") return { kind: node.kind, children: node.children.map(visit) };
    const refs = node.targetIndices.map(index => handles[index]!);
    if (node.kind === "attempt") return { kind: node.kind, text: node.text, targetHandles: refs };
    if (node.kind === "await") return { kind: node.kind, condition: node.condition, targetHandles: refs };
    if (node.kind === "while") return { kind: node.kind, condition: node.condition, targetHandles: refs, body: visit(node.body) };
    return { kind: node.kind, condition: node.condition, targetHandles: refs, thenNode: visit(node.thenNode), elseNode: node.elseNode === null ? null : visit(node.elseNode) };
  };
  return visit(program.root);
}

export function decodeRecursiveIntent(value: unknown) {
  const envelope = envelopeSchema.parse(value);
  try {
    return decodeAgentIntentProgram({ ...envelope, slots: envelope.slots.map(slot => ({ ...slot,
      nextActionIntent: lowerRecursiveIntent(slot.nextActionIntent.program) })) });
  } catch (error) {
    throw new ModelOutputError(error instanceof Error ? error.message : String(error), undefined, { cause: error, rawValue: value });
  }
}

type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("Recursive intention schema drift");
  return value as Value;
};

export function agentRecursiveIntentRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (!["agent-bootstrap", "agent-mind"].includes(request.role) || request.schemaName !== "agent_mind_batch_output") return request;
  if (request.promptVersion.includes("agent-recursive-intent-v1")) throw new ModelConfigurationError("Recursive intention already applied");
  const wireJsonSchema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  const fields = record(record(record(record(wireJsonSchema.properties).slots).items).properties);
  const action = record(fields.nextActionIntent), oldFields = record(action.properties);
  if (Object.keys(oldFields).sort().join(",") !== "goal,means,rawText,targetHandles" || !Array.isArray(action.required) ||
    [...action.required].sort().join(",") !== "goal,means,rawText,targetHandles") throw new ModelConfigurationError("Recursive intention requires the original action contract");
  const replacement = z.toJSONSchema(actionSchema, { target: "draft-07" }) as Value;
  const definitions = record(replacement.definitions), rootDefinitions = record(wireJsonSchema.definitions ?? {});
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      key === "$ref" && typeof child === "string" && child.startsWith("#/definitions/")
        ? child.replace("#/definitions/", "#/definitions/recursiveIntent_") : rewrite(child)]));
  };
  for (const [name, definition] of Object.entries(definitions)) {
    const key = `recursiveIntent_${name}`;
    if (key in rootDefinitions) throw new ModelConfigurationError("Recursive intention definition collision");
    const rewritten = record(rewrite(definition));
    if (!Array.isArray(rewritten.oneOf)) throw new ModelConfigurationError("Recursive intention union schema drift");
    for (const alternative of rewritten.oneOf as Value[]) {
      const properties = record(alternative.properties);
      if ("targetHandles" in properties) properties.targetHandles = structuredClone(oldFields.targetHandles);
    }
    rootDefinitions[key] = rewritten;
  }
  wireJsonSchema.definitions = rootDefinitions;
  delete replacement.$schema; delete replacement.definitions;
  fields.nextActionIntent = rewrite(replacement);
  const sourceHash = contentHash(request.context), schemaHash = contentHash(wireJsonSchema);
  return { ...request, wireJsonSchema, system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${AGENT_RECURSIVE_INTENT}`,
    preprocessOutput: raw => {
      if (contentHash(request.context) !== sourceHash || contentHash(wireJsonSchema) !== schemaHash) throw new ModelConfigurationError("Recursive intention source or schema changed");
      const value = decodeRecursiveIntent(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
