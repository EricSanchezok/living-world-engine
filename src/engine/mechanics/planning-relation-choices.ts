import { z } from "zod";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../models/model-provider";
import { assertIndexedPlanningContext, planningIndexDomain, withoutPlanningIndices } from "./source-indexed-planning";
import { withoutPhysicalPlanningWorklist } from "./physical-planning-worklist";
import { expandSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";
import { SourceIndexedPlanCauseCodec } from "./source-indexed-plan-causes";

const instruction = loadPromptAsset("shared/planning-relation-choices.md");
export const PLANNING_RELATION_CHOICES = `bound-planning-relations-v1@${contentHash(instruction).slice(0, 16)}`;
type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`planning relations: ${message}`); };
const record = (value: unknown): Value => object(value) ? value : fail("missing source object");
const at = <T>(rows: readonly T[], index: unknown): T | undefined => typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? rows[index] : undefined;
const invalid = (message: string): never => { throw new z.ZodError([{ code: "custom", path: [], message: `planning relations: ${message}` }]); };
interface Rating { ratingRef: string; label: string; value: number }
interface Scoped { slots: number[] }
interface Target { targetIndex: number; targetRef: string; ratings: Array<Rating & Scoped>; meterEffects: Array<{
  meterRef: string; meterLabel: string; impactProfileRef: string; impactLabel: string;
} & Scoped> }
interface Conditions extends Scoped { conditionProfileRef: string | null; durationProfileRef: string; label: string }

/** Complete source joins, with model-selected positions and no semantic inference. */
export class PlanningRelationChoiceCodec {
  readonly actions: Array<{ actionIndex: number; actionRef: string; actorRef: string; slot: number; ratings: Rating[] }> = [];
  readonly targets: Target[];
  readonly conditionDurations: Conditions[] = [];
  readonly context: Value;
  readonly bindingHash: string;
  private readonly sourceHash: string;
  private readonly contextHash: string;
  private readonly domainHash: string;

  constructor(private readonly sourceContext: unknown) {
    this.sourceHash = contentHash(sourceContext);
    const indexed = structuredClone(record(sourceContext)), task = record(indexed.task);
    if (Object.hasOwn(task, "planningRelations")) fail("repeated projection");
    if (Object.hasOwn(task, "planCauseChoices")) {
      delete task.planCauseChoices;
      if (contentHash(new SourceIndexedPlanCauseCodec(indexed).project()) !== this.sourceHash) fail("cause binding changed");
    }
    assertIndexedPlanningContext(indexed);
    const unindexed = withoutPlanningIndices(indexed), domain = planningIndexDomain(unindexed);
    const source = withoutPhysicalPlanningWorklist(unindexed);
    const contexts = isSharedBatchContext(source.state) ? expandSharedBatchContexts(source.state) : [source];
    this.targets = domain.targets.map((row, targetIndex) => ({ targetIndex, targetRef: row.handle, ratings: [], meterEffects: [] }));
    const add = <T extends Scoped>(rows: T[], value: Omit<T, "slots">, slot: number) => {
      const existing = rows.find(row => contentHash(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "slots"))) === contentHash(value));
      if (existing) { if (!existing.slots.includes(slot)) existing.slots.push(slot); }
      else rows.push({ ...value, slots: [slot] } as T);
    };
    contexts.forEach((context, slot) => {
      const state = record(context.state), truth = record(state.canonicalTruth), mechanics = record(truth.mechanics);
      const ratings = record(truth.ratings), meters = record(truth.meters), entities = record(truth.entities);
      const candidates = record(context.referenceCatalog).candidates;
      if (!Array.isArray(candidates) || !candidates.every(object)) return fail("missing catalog");
      if (new Set(candidates.map(row => row.handle)).size !== candidates.length) return fail("duplicate catalog handle");
      const catalog = new Map(candidates.map(row => [row.handle, row]));
      const permits = (handle: unknown, kind: string, use: string) => {
        const row = catalog.get(handle);
        return row?.kind === kind && Array.isArray(row.allowedUses) && row.allowedUses.includes(use);
      };
      const profileRows = (collection: string) => Object.entries(record(mechanics[collection])).flatMap(([id, value]) => {
        const rows = candidates.filter(row => row.kind === "mechanic" && row.statePath === `state.truth.mechanics.${collection}.${id}` && permits(row.handle, "mechanic", "mechanic"));
        if (rows.length > 1) return fail("ambiguous mechanic binding");
        return rows.map(row => ({ ...record(value), ref: String(row.handle), label: String(row.label) } as Value & { ref: string; label: string }));
      });
      const impacts = profileRows("impactProfiles"), durations = profileRows("durationProfiles"), conditions = profileRows("conditionProfiles");
      const ownedRatings = (owner: string, use: string): Rating[] => candidates.flatMap(row => {
        if (row.kind !== "rating" || !permits(row.handle, "rating", use)) return [];
        const rating = record(ratings[String(row.handle)]);
        if (typeof rating.entityRef !== "string" || typeof rating.value !== "number" || !Number.isFinite(rating.value)) return fail("invalid displayed rating");
        return rating.entityRef === owner ? [{ ratingRef: String(row.handle), label: String(row.label), value: rating.value }] : [];
      });
      const assigned = record(state.actionSet).assigned;
      if (!Array.isArray(assigned) || !assigned.every(object) || !Array.isArray(state.actors) || !state.actors.every(object)) return fail("missing action/actor binding");
      for (const action of assigned) {
        const actionIndex = domain.actions.findIndex(row => row.handle === action.actionRef && row.slot === slot);
        const actors = state.actors.filter(row => row.agentRef === action.actorRef);
        if (actionIndex < 0 || actors.length !== 1 || typeof actors[0]!.entityRef !== "string" || !object(entities[actors[0]!.entityRef])) return fail("ambiguous assigned actor");
        const actorRef = actors[0]!.entityRef as string;
        this.actions.push({ actionIndex, actionRef: String(action.actionRef), actorRef, slot, ratings: ownedRatings(actorRef, "modifier") });
      }
      this.targets.forEach((target, targetIndex) => {
        if (!domain.targets[targetIndex]!.slots.includes(slot)) return;
        for (const rating of ownedRatings(target.targetRef, "source")) add(target.ratings, rating, slot);
        for (const row of candidates) {
          if (row.kind !== "meter" || !permits(row.handle, "meter", "source")) continue;
          const meter = record(meters[String(row.handle)]);
          if (meter.entityRef !== target.targetRef) continue;
          for (const impact of impacts) if (impact.meterDefinitionId === meter.definitionId) add(target.meterEffects, {
            meterRef: String(row.handle), meterLabel: String(row.label), impactProfileRef: impact.ref, impactLabel: impact.label,
          }, slot);
        }
      });
      for (const duration of durations) add(this.conditionDurations, { conditionProfileRef: null, durationProfileRef: duration.ref, label: `Open condition / ${duration.label}` }, slot);
      for (const condition of conditions) for (const duration of durations) if (condition.defaultDurationProfileId === duration.id) {
        add(this.conditionDurations, { conditionProfileRef: condition.ref, durationProfileRef: duration.ref, label: `${condition.label} / ${duration.label}` }, slot);
      }
    });
    this.actions.sort((a, b) => a.actionIndex - b.actionIndex);
    if (this.actions.length !== domain.actions.length || this.actions.some((row, i) => row.actionIndex !== i)) fail("incomplete action coverage");
    const relations = { actions: this.actions, targets: this.targets, conditionDurations: this.conditionDurations };
    this.domainHash = contentHash(relations);
    this.bindingHash = contentHash({ contract: PLANNING_RELATION_CHOICES, source: this.sourceHash, relations });
    this.context = structuredClone(record(sourceContext));
    record(this.context.task).planningRelations = { contract: PLANNING_RELATION_CHOICES, bindingHash: this.bindingHash,
      actions: this.actions.map(row => ({ ...structuredClone(row), ratings: row.ratings.map((rating, actorRatingPosition) => ({ ...rating, actorRatingPosition })) })),
      targets: this.targets.map(row => ({ ...structuredClone(row), ratings: row.ratings.map((rating, opposedRatingPosition) => ({ ...structuredClone(rating), opposedRatingPosition })),
        meterEffects: row.meterEffects.map((effect, meterEffectPosition) => ({ ...structuredClone(effect), meterEffectPosition })) })),
      conditionDurations: this.conditionDurations.map((choice, conditionDurationIndex) => ({ ...structuredClone(choice), conditionDurationIndex })) };
    this.contextHash = contentHash(this.context);
  }

  private assertBinding(bindingHash: string) {
    if (bindingHash !== this.bindingHash || contentHash(this.sourceContext) !== this.sourceHash || contentHash(this.context) !== this.contextHash ||
      contentHash({ actions: this.actions, targets: this.targets, conditionDurations: this.conditionDurations }) !== this.domainHash) return fail("source or menu binding changed");
  }

  restoreContext(): unknown {
    this.assertBinding(this.bindingHash);
    const restored = structuredClone(this.context); delete record(restored.task).planningRelations; return restored;
  }

  private plan(value: Value, encode: boolean): Value {
    const plan = structuredClone(value), action = at(this.actions, plan.actionIndex);
    if (!action || !Array.isArray(plan.targetIndices)) return invalid("missing action/targets");
    const selected = plan.targetIndices.map(index => at(this.targets, index));
    const scoped = <T extends Scoped>(row: T | undefined): T => row?.slots.includes(action.slot) ? row : invalid("unknown or cross-slot relation position");
    const targetAt = (position: unknown): Target => at(selected, position) ?? invalid("relation targetPosition absent from selected targets");
    const mixed = (container: Value, names: string[]) => { if (names.some(name => Object.hasOwn(container, name))) invalid("mixed relation representations"); };
    if (encode) {
      mixed(plan, ["actorRatingPosition"]);
      plan.actorRatingPosition = plan.actorRatingRef === null ? null : action.ratings.findIndex(row => row.ratingRef === plan.actorRatingRef);
      if (plan.actorRatingPosition !== null && !at(action.ratings, plan.actorRatingPosition)) return invalid("rating is not owned by assigned actor");
      delete plan.actorRatingRef;
    } else {
      mixed(plan, ["actorRatingRef"]);
      plan.actorRatingRef = plan.actorRatingPosition === null ? null : (at(action.ratings, plan.actorRatingPosition) ?? invalid("unknown actor rating position")).ratingRef;
      delete plan.actorRatingPosition;
    }
    const difficulty = plan.difficulty;
    if (object(difficulty) && difficulty.kind === "opposed") {
      if (encode) {
        mixed(difficulty, ["targetPosition", "opposedRatingPosition"]);
        difficulty.targetPosition = selected.findIndex(row => row?.targetRef === difficulty.targetRef);
        const target = targetAt(difficulty.targetPosition);
        difficulty.opposedRatingPosition = target.ratings.findIndex(row => row.ratingRef === difficulty.ratingRef && row.slots.includes(action.slot));
        scoped(at(target.ratings, difficulty.opposedRatingPosition));
        delete difficulty.targetRef; delete difficulty.ratingRef;
      } else {
        mixed(difficulty, ["targetRef", "ratingRef"]);
        const target = targetAt(difficulty.targetPosition), rating = scoped(at(target.ratings, difficulty.opposedRatingPosition));
        difficulty.targetRef = target.targetRef; difficulty.ratingRef = rating.ratingRef;
        delete difficulty.targetPosition; delete difficulty.opposedRatingPosition;
      }
    }
    for (const name of ["primaryEffect", "secondaryEffect", "threatenedEffect"]) {
      const effect = plan[name]; if (!object(effect)) continue;
      if (effect.kind === "meter") {
        const target = targetAt(effect.targetPosition);
        if (encode) {
          mixed(effect, ["meterEffectPosition"]);
          effect.meterEffectPosition = target.meterEffects.findIndex(row => row.meterRef === effect.meterRef && row.impactProfileRef === effect.impactProfileRef && row.slots.includes(action.slot));
          scoped(at(target.meterEffects, effect.meterEffectPosition));
          delete effect.meterRef; delete effect.impactProfileRef;
        } else {
          mixed(effect, ["meterRef", "impactProfileRef"]);
          const choice = scoped(at(target.meterEffects, effect.meterEffectPosition));
          effect.meterRef = choice.meterRef; effect.impactProfileRef = choice.impactProfileRef; delete effect.meterEffectPosition;
        }
      } else if (effect.kind === "condition") {
        if (encode) {
          mixed(effect, ["conditionDurationIndex"]);
          effect.conditionDurationIndex = this.conditionDurations.findIndex(row => row.conditionProfileRef === effect.conditionProfileRef && row.durationProfileRef === effect.durationProfileRef && row.slots.includes(action.slot));
          scoped(at(this.conditionDurations, effect.conditionDurationIndex));
          delete effect.conditionProfileRef; delete effect.durationProfileRef;
        } else {
          mixed(effect, ["conditionProfileRef", "durationProfileRef"]);
          const choice = scoped(at(this.conditionDurations, effect.conditionDurationIndex));
          effect.conditionProfileRef = choice.conditionProfileRef; effect.durationProfileRef = choice.durationProfileRef; delete effect.conditionDurationIndex;
        }
      }
    }
    return plan;
  }

  decode(raw: unknown, bindingHash = this.bindingHash): unknown {
    this.assertBinding(bindingHash);
    const value = structuredClone(raw);
    if (!object(value) || !Array.isArray(value.plans)) return value;
    value.plans = value.plans.map(plan => {
      if (!object(plan)) return plan;
      try { return this.plan(plan, false); } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        // Keep the invalid slot invalid, and retain its exact vocabulary for a narrowed repair.
        const action = at(this.actions, plan.actionIndex);
        return { ...plan, invalidPlanningRelation: { issues: error.issues, bindingHash: this.bindingHash, action,
          targets: Array.isArray(plan.targetIndices) ? plan.targetIndices.map(index => at(this.targets, index)) : [], conditionDurations: this.conditionDurations } };
      }
    });
    return value;
  }

  encode(raw: unknown): unknown {
    this.assertBinding(this.bindingHash);
    const value = structuredClone(raw);
    if (!object(value) || !Array.isArray(value.plans) || !value.plans.every(object)) return invalid("missing source plans");
    value.plans = value.plans.map(plan => this.plan(plan, true));
    if (contentHash(this.decode(value)) !== contentHash(raw)) return invalid("source cannot round trip");
    return value;
  }

  schema(input: Value): Value {
    this.assertBinding(this.bindingHash);
    const schema = structuredClone(input); let count = 0;
    const position = (description: string) => ({ type: "integer", minimum: 0, description });
    const replace = (node: Value, fields: Value, remove: string[], additions: Value) => {
      if (!Array.isArray(node.required) || remove.some(key => !Object.hasOwn(fields, key)) || Object.keys(additions).some(key => Object.hasOwn(fields, key))) return fail("unexpected relation schema");
      remove.forEach(key => { delete fields[key]; }); Object.assign(fields, additions);
      node.required = [...node.required.filter(key => !remove.includes(String(key))), ...Object.keys(additions)]; count++;
    };
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; } if (!object(node)) return;
      const fields = node.properties;
      if (object(fields)) {
        if (["actionIndex", "actorRatingRef", "mode", "primaryEffect"].every(key => Object.hasOwn(fields, key))) {
          const nullableOnly = object(fields.actorRatingRef) && fields.actorRatingRef.type === "null";
          replace(node, fields, ["actorRatingRef"], { actorRatingPosition: nullableOnly ? { type: "null" } : { anyOf: [{ type: "null" }, position("Position in this actionIndex's planningRelations.actions ratings; null means no actor rating.")] } });
        } else if (object(fields.kind) && fields.kind.const === "opposed" && Object.hasOwn(fields, "ratingRef")) {
          replace(node, fields, ["targetRef", "ratingRef"], { targetPosition: position("Position in this plan's selected targetIndices."), opposedRatingPosition: position("Position in the selected target's planningRelations.targets ratings; require this action's slot.") });
        } else if (object(fields.kind) && fields.kind.const === "meter" && Object.hasOwn(fields, "targetPosition")) {
          replace(node, fields, ["meterRef", "impactProfileRef"], { meterEffectPosition: position("Position in this effect target's compatible meterEffects; require this action's slot.") });
        } else if (object(fields.kind) && fields.kind.const === "condition" && Object.hasOwn(fields, "targetPosition")) {
          replace(node, fields, ["conditionProfileRef", "durationProfileRef"], { conditionDurationIndex: position("Index in planningRelations.conditionDurations; require this action's slot. Null-profile rows preserve open semantic conditions.") });
        }
      }
      Object.values(node).forEach(visit);
    };
    visit(schema); if (!count) return fail("missing indexed plan schema"); return schema;
  }
}

export function planningRelationChoicesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (!request.wireJsonSchema || request.promptVersion.includes(PLANNING_RELATION_CHOICES)) return fail("requires one indexed request");
  const codec = new PlanningRelationChoiceCodec(request.context), wire = codec.schema(request.wireJsonSchema);
  return { ...request, context: codec.context, wireJsonSchema: wire, jsonExamplePolicy: "omit",
    userPrompt: [request.userPrompt, instruction].join("\n\n"),
    ...(request.jsonObjectPostlude ? { jsonObjectPostlude: `${request.jsonObjectPostlude}\n\n${instruction}` } : {}),
    promptVersion: `${request.promptVersion}/${PLANNING_RELATION_CHOICES}@${contentHash({ binding: codec.bindingHash, wire }).slice(0, 16)}`,
    preprocessOutput: raw => { const value = codec.decode(raw); return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] }; } };
}
