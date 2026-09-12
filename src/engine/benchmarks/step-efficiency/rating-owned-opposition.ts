import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { planningSourceContexts } from "./planning-source-contexts";

type Value = Record<string, unknown>;
interface RatingOwner { ratingRef: string; entityRef: string; label: string; ownerLabel: string; value: number; slots: number[] }
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`rating-owned opposition: ${message}`); };
const record = (value: unknown): Value => object(value) ? value : fail("missing source record");
const rows = (value: unknown): Value[] => Array.isArray(value) && value.every(object) ? value : fail("missing source rows");
const original = loadPromptAsset("shared/resolution-dependent-fields.md").split("\n\n")[1]!;
const instruction = loadPromptAsset("shared/rating-owned-opposition.md");
export const RATING_OWNED_OPPOSITION = `rating-owned-opposition-v1@${contentHash({ original, instruction }).slice(0, 16)}`;

/** Project existing ownership only; the selected rating remains a model choice. */
export class RatingOwnedOppositionCodec {
  readonly owners: RatingOwner[] = [];
  readonly context: Value;
  private readonly actions: Map<number, number>;
  private readonly sourceHash: string;
  private readonly bindingHash: string;

  constructor(private readonly source: unknown) {
    this.sourceHash = contentHash(source);
    const task = record(record(source).task), worklist = record(task.planningWorklist);
    if (Object.hasOwn(task, "opposedRatingChoices")) fail("already projected");
    const contexts = planningSourceContexts(source), actions = rows(worklist.actions);
    this.actions = new Map(actions.map((row, index) => {
      if (row.actionIndex !== index || !Number.isSafeInteger(row.slot) || !contexts[row.slot as number]) return fail("invalid action assignment");
      const state = record(contexts[row.slot as number]!.state);
      const assigned = rows(record(state.actionSet).assigned);
      const action = record(row.action), matches = assigned.filter(entry => entry.actionRef === action.actionRef);
      if (matches.length !== 1 || ["actorRef", "rawText", "goal", "means"].some(key => contentHash(matches[0]![key] ?? null) !== contentHash(action[key] ?? null))) return fail("action source mismatch");
      return [index, row.slot as number];
    }));
    if (worklist.actionCount !== this.actions.size) fail("incomplete action coverage");
    contexts.forEach((context, slot) => {
      const truth = record(record(context.state).canonicalTruth), ratings = record(truth.ratings), entities = record(truth.entities);
      const candidates = rows(record(context.referenceCatalog).candidates), catalog = new Map(candidates.map(row => [row.handle, row]));
      if (catalog.size !== candidates.length) return fail("duplicate catalog handle");
      const permits = (row: Value | undefined, kind: string, use: string) => row?.kind === kind && Array.isArray(row.allowedUses) && row.allowedUses.includes(use);
      for (const row of candidates) {
        if (!permits(row, "rating", "source")) continue;
        const ratingRef = row.handle, rating = record(ratings[String(ratingRef)]), entityRef = rating.entityRef;
        if (typeof ratingRef !== "string" || typeof entityRef !== "string" || typeof rating.value !== "number" || !Number.isFinite(rating.value)) return fail("invalid displayed rating");
        const owner = catalog.get(entityRef);
        if (!permits(owner, "entity", "target")) continue;
        if (!object(entities[entityRef]) || typeof row.label !== "string" || typeof owner!.label !== "string") return fail("missing displayed owner");
        const entry = { ratingRef, entityRef, label: row.label, ownerLabel: owner!.label as string, value: rating.value };
        const known = this.owners.find(value => value.ratingRef === ratingRef);
        if (known) {
          const previous = Object.fromEntries(Object.entries(known).filter(([key]) => key !== "slots"));
          if (contentHash(previous) !== contentHash(entry)) return fail("inconsistent rating across slots");
          known.slots.push(slot);
        } else this.owners.push({ ...entry, slots: [slot] });
      }
    });
    this.context = structuredClone(record(source));
    record(this.context.task).opposedRatingChoices = { contract: RATING_OWNED_OPPOSITION, sourceContextHash: this.sourceHash, rows: structuredClone(this.owners) };
    this.bindingHash = contentHash({ context: this.context, owners: this.owners, actions: [...this.actions] });
  }

  private assertBinding(): void {
    if (contentHash(this.source) !== this.sourceHash || contentHash({ context: this.context, owners: this.owners, actions: [...this.actions] }) !== this.bindingHash) return fail("source or ownership projection changed");
  }

  private transform(raw: unknown, encode: boolean): unknown {
    this.assertBinding();
    const result = structuredClone(raw);
    if (!object(result) || result.kind !== "commit_plans" || !Array.isArray(result.plans)) return result;
    for (const plan of result.plans) {
      if (!object(plan) || !object(plan.difficulty) || plan.difficulty.kind !== "opposed") continue;
      const slot = this.actions.get(plan.actionIndex as number), difficulty = plan.difficulty;
      const owner = this.owners.find(row => row.ratingRef === difficulty.ratingRef && slot !== undefined && row.slots.includes(slot));
      if (!owner) continue;
      if (encode && difficulty.targetRef === owner.entityRef) difficulty.targetRef = null;
      else if (!encode && difficulty.targetRef === null) difficulty.targetRef = owner.entityRef;
    }
    return result;
  }

  encode(raw: unknown): unknown { return this.transform(raw, true); }
  decode(raw: unknown): unknown { return this.transform(raw, false); }

  schema(source: Value): Value {
    this.assertBinding();
    const result = structuredClone(source); let changed = 0;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!object(node)) return;
      const fields = node.properties;
      if (object(fields) && object(fields.kind) && fields.kind.const === "opposed" && Object.hasOwn(fields, "ratingRef")) {
        if (!object(fields.targetRef) || !Array.isArray(node.required) || !node.required.includes("targetRef") || !node.required.includes("ratingRef")) return fail("unsupported opposed schema");
        fields.targetRef = { anyOf: [fields.targetRef, { type: "null" }], description: "Null explicitly selects the displayed owner of ratingRef. Non-null targets retain their exact meaning." };
        fields.ratingRef = this.owners.length ? { ...record(fields.ratingRef), enum: this.owners.map(row => row.ratingRef) } : { not: {} };
        changed++;
        return;
      }
      Object.values(node).forEach(visit);
    };
    visit(result);
    if (!changed) return fail("missing opposed difficulty schema");
    return result;
  }
}

export function ratingOwnedOppositionRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(RATING_OWNED_OPPOSITION)) return fail("already applied");
  if (!request.wireJsonSchema || !request.jsonObjectPostlude || !original?.startsWith("For opposed difficulty,") || request.system.split(original).length !== 2) return fail("missing source representation contract");
  const codec = new RatingOwnedOppositionCodec(request.context), wireJsonSchema = codec.schema(request.wireJsonSchema);
  const sourceSchemaHash = contentHash(request.wireJsonSchema), schemaHash = contentHash(wireJsonSchema);
  const system = request.system.replace(original, instruction), jsonObjectPostlude = `${request.jsonObjectPostlude}\n\n${instruction}`;
  const candidate: StructuredModelRequest<T> = { ...request, context: codec.context, wireJsonSchema, system, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${RATING_OWNED_OPPOSITION}@${contentHash({ context: codec.context, wireJsonSchema, system, jsonObjectPostlude }).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (contentHash(request.wireJsonSchema) !== sourceSchemaHash || contentHash(candidate.wireJsonSchema) !== schemaHash) return fail("wire schema changed");
      if (candidate.context !== codec.context || candidate.system !== system || candidate.jsonObjectPostlude !== jsonObjectPostlude) return fail("bound request changed");
      const value = codec.decode(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
  return candidate;
}
