import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { planningSourceContexts } from "./planning-source-contexts";

type Value = Record<string, unknown>;
type TextField = "rawText" | "goal" | "means";
interface TextCopy { text: string; sources: Array<{ field: TextField; start: number; end: number }> }
interface ActionCopies { actionIndex: number; actionRef: string; slot: number; copies: TextCopy[] }
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`means text copies: ${message}`); };
const record = (value: unknown): Value => object(value) ? value : fail("missing source record");
const rows = (value: unknown): Value[] => Array.isArray(value) && value.every(object) ? value : fail("missing source rows");
const instruction = loadPromptAsset("shared/means-text-copies.md");
export const MEANS_TEXT_COPIES = `means-text-copies-v1@${contentHash(instruction).slice(0, 16)}`;

/** UTF-16 offsets address exact source substrings; punctuation implies no semantic boundary. */
export function actionTextCopies(action: Value): TextCopy[] {
  const copies: TextCopy[] = [];
  for (const field of ["rawText", "goal", "means"] as const) {
    const text = action[field];
    if (field === "means" && (text === null || text === undefined)) continue;
    if (typeof text !== "string" || !text.trim()) fail(`invalid ${field} text`);
    const source = text as string;
    const add = (start: number, end: number): void => {
      const value = source.slice(start, end);
      const existing = copies.find(copy => copy.text === value);
      const origin = { field, start, end };
      if (existing) {
        if (!existing.sources.some(row => row.field === field && row.start === start && row.end === end)) existing.sources.push(origin);
      } else copies.push({ text: value, sources: [origin] });
    };
    add(0, source.length);
    const passages = [...source.matchAll(/[^。！？!?;；\n]+[。！？!?;；\n]*|[。！？!?;；\n]+/gu)];
    if (passages.map(match => match[0]).join("") !== source) fail("passage coverage changed source");
    for (const match of passages) if (match[0].trim()) add(match.index, match.index + match[0].length);
  }
  return copies;
}

export class MeansTextCopyCodec {
  readonly actions: ActionCopies[];
  readonly context: Value;
  private readonly sourceHash: string;
  private readonly bindingHash: string;

  constructor(private readonly source: unknown) {
    this.sourceHash = contentHash(source);
    const task = record(record(source).task), worklist = record(task.planningWorklist);
    if (Object.hasOwn(task, "meansTextCopies")) fail("already projected");
    const contexts = planningSourceContexts(source);
    this.actions = rows(worklist.actions).map((row, actionIndex) => {
      if (row.actionIndex !== actionIndex || !Number.isSafeInteger(row.slot) || !contexts[row.slot as number]) fail("invalid action assignment");
      const action = record(row.action), assigned = rows(record(record(contexts[row.slot as number]!.state).actionSet).assigned);
      const matches = assigned.filter(entry => entry.actionRef === action.actionRef);
      if (typeof action.actionRef !== "string" || matches.length !== 1 || ["actorRef", "rawText", "goal", "means"].some(key => contentHash(matches[0]![key] ?? null) !== contentHash(action[key] ?? null))) fail("action source mismatch");
      return { actionIndex, actionRef: action.actionRef as string, slot: row.slot as number, copies: actionTextCopies(action) };
    });
    if (worklist.actionCount !== this.actions.length) fail("incomplete action coverage");
    this.context = structuredClone(record(source));
    record(this.context.task).meansTextCopies = { contract: MEANS_TEXT_COPIES, sourceContextHash: this.sourceHash, actions: structuredClone(this.actions) };
    this.bindingHash = contentHash({ context: this.context, actions: this.actions });
  }

  private assertBinding(): void {
    if (contentHash(this.source) !== this.sourceHash || contentHash({ context: this.context, actions: this.actions }) !== this.bindingHash) fail("source or text projection changed");
  }

  private transform(raw: unknown, encode: boolean): unknown {
    this.assertBinding();
    const result = structuredClone(raw);
    if (!object(result) || result.kind !== "commit_plans" || !Array.isArray(result.plans)) return result;
    for (const plan of result.plans) {
      if (!object(plan) || !Number.isSafeInteger(plan.actionIndex) || !Array.isArray(plan.means)) continue;
      const action = this.actions[plan.actionIndex as number];
      if (!action) continue;
      for (const mean of plan.means) {
        if (!object(mean)) continue;
        if (encode && typeof mean.description === "string") {
          const index = action.copies.findIndex(copy => copy.text === mean.description);
          if (index >= 0) mean.description = { copy: index };
        } else if (!encode && object(mean.description) && Object.keys(mean.description).length === 1 && Number.isSafeInteger(mean.description.copy)) {
          const selected = action.copies[mean.description.copy as number];
          if (selected) mean.description = selected.text;
        }
      }
    }
    return result;
  }

  encode(raw: unknown): unknown { return this.transform(raw, true); }
  decode(raw: unknown): unknown { return this.transform(raw, false); }

  schema(source: Value): Value {
    this.assertBinding();
    const result = structuredClone(source), count = Math.max(0, ...this.actions.map(action => action.copies.length));
    let changed = 0;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!object(node)) return;
      const fields = node.properties;
      if (object(fields) && Object.hasOwn(fields, "actionIndex") && object(fields.means)) {
        const items = record(fields.means.items), means = record(items.properties), original = record(means.description);
        if (original.type !== "string" || !Array.isArray(items.required) || !items.required.includes("description")) fail("unexpected means description schema");
        means.description = { anyOf: [original, { type: "object", properties: { copy: count ? { type: "integer", minimum: 0, maximum: count - 1 } : { not: {} } }, required: ["copy"], additionalProperties: false }],
          description: "Exact free text or an explicit index into this actionIndex's meansTextCopies inventory. A copy is an intention, not a completed event." };
        changed++;
      }
      Object.values(node).forEach(visit);
    };
    visit(result);
    if (!changed) fail("missing physical means schema");
    return result;
  }
}

export function meansTextCopiesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(MEANS_TEXT_COPIES)) fail("already applied");
  if (!request.wireJsonSchema || !request.jsonObjectPostlude) fail("missing physical request contract");
  const codec = new MeansTextCopyCodec(request.context), wireJsonSchema = codec.schema(request.wireJsonSchema!);
  const sourceSchemaHash = contentHash(request.wireJsonSchema), schemaHash = contentHash(wireJsonSchema);
  const system = `${request.system}\n\n${instruction}`, jsonObjectPostlude = `${request.jsonObjectPostlude}\n\n${instruction}`;
  const candidate: StructuredModelRequest<T> = { ...request, context: codec.context, wireJsonSchema, system, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${MEANS_TEXT_COPIES}@${contentHash({ context: codec.context, wireJsonSchema, system, jsonObjectPostlude }).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (contentHash(request.wireJsonSchema) !== sourceSchemaHash || contentHash(candidate.wireJsonSchema) !== schemaHash) fail("wire schema changed");
      if (candidate.context !== codec.context || candidate.system !== system || candidate.jsonObjectPostlude !== jsonObjectPostlude) fail("bound request changed");
      const value = codec.decode(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
  return candidate;
}
