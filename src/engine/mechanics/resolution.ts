import type {
  CausalRef,
  CheckVisibility,
  D20CheckResult,
  WorldDeltaOperation,
  WorldFact,
} from "../contracts/model";

export const magnitudeBands = ["none", "minor", "standard", "major", "decisive"] as const;
export type MagnitudeBand = (typeof magnitudeBands)[number];

export const outcomeGrades = ["miss", "mixed", "full", "exceptional"] as const;
export type OutcomeGrade = (typeof outcomeGrades)[number];

export const riskBands = ["safe", "risky", "dire"] as const;
export type RiskBand = (typeof riskBands)[number];

export const resolutionModes = ["automatic", "check", "blocked"] as const;
export type ResolutionMode = (typeof resolutionModes)[number];

export const difficultyBands = ["trivial", "easy", "challenging", "hard", "extreme"] as const;
export type DifficultyBand = (typeof difficultyBands)[number];

export type FactorRole = "permission" | "control" | "potency" | "protection" | "secondary" | "risk";
export type FactorDirection = "helpful" | "hindering" | "neutral";
export type FactorAuthority = "semantic" | "authored";

/** Independent missing stakes must reach the same repair, before settlement. */
export class ResolutionCheckEffectError extends Error {
  readonly issues: Array<{ code: string; path: Array<string | number>; message: string; originalValue: null | "none" }>;

  constructor(plan: ResolutionPlan) {
    const issues: ResolutionCheckEffectError["issues"] = [];
    if (!plan.primaryEffect || plan.primaryEffect.magnitude === "none") issues.push({
      code: "resolution_check_primary_effect", path: plan.primaryEffect ? ["primaryEffect", "magnitude"] : ["primaryEffect"],
      message: `plan ${plan.id} requires a non-none primary effect`, originalValue: plan.primaryEffect ? "none" : null,
    });
    if (!plan.threatenedEffect) issues.push({ code: "resolution_check_threatened_effect", path: ["threatenedEffect"],
      message: `plan ${plan.id} has no failure threat`, originalValue: null });
    super(issues.map(issue => issue.message).join("; "));
    this.name = "ResolutionCheckEffectError";
    this.issues = issues;
  }
}

export type ResolutionSourceRef =
  | { kind: "action"; id: string }
  | { kind: "entity"; id: string }
  | { kind: "fact"; id: string }
  | { kind: "condition"; id: string }
  | { kind: "rating"; id: string }
  | { kind: "law"; id: string }
  | { kind: "placement"; id: string };

export interface GroundedMean {
  description: string;
  source: ResolutionSourceRef;
}

export interface ResolutionFactor {
  source: ResolutionSourceRef;
  role: FactorRole;
  direction: FactorDirection;
  steps: 0 | 1 | 2;
  authority: FactorAuthority;
  channel: string | null;
  explanation: string;
}

export type ResolutionDifficulty =
  | { kind: "environment"; band: DifficultyBand; source: ResolutionSourceRef }
  | { kind: "opposed"; targetId: string; ratingId: string; source: ResolutionSourceRef };

interface EffectIntentBase {
  id: string;
  targetId: string;
  channel: string;
  label: string;
  description: string;
  sourceRefs: ResolutionSourceRef[];
}

export interface MeterEffectIntent extends EffectIntentBase {
  kind: "meter";
  meterId: string;
  impactProfileId: string;
  magnitude: MagnitudeBand;
}

export interface ConditionEffectIntent extends EffectIntentBase {
  kind: "condition";
  conditionId: string;
  conditionProfileId: string | null;
  durationProfileId: string;
  access: WorldFact["access"];
  magnitude: MagnitudeBand;
}

export type EffectIntent = MeterEffectIntent | ConditionEffectIntent;
export type ThreatenedEffect =
  | Omit<MeterEffectIntent, "magnitude">
  | Omit<ConditionEffectIntent, "magnitude">;

export interface ResolutionPlan {
  id: string;
  actionId: string;
  actorId: string;
  targetIds: string[];
  goal: string;
  means: GroundedMean[];
  mode: ResolutionMode;
  difficulty: ResolutionDifficulty | null;
  actorRatingId: string | null;
  factors: ResolutionFactor[];
  risk: RiskBand;
  baseEffect: MagnitudeBand;
  primaryEffect: EffectIntent | null;
  secondaryEffect: EffectIntent | null;
  threatenedEffect: ThreatenedEffect | null;
  visibility: CheckVisibility;
  causes: CausalRef[];
}

export interface ResolvedEffect {
  role: "primary" | "secondary" | "consequence";
  magnitude: MagnitudeBand;
  intent: EffectIntent;
}

export interface ResolutionReceipt {
  id: string;
  plan: ResolutionPlan;
  settled: boolean;
  checkRequestId: string | null;
  dc: number | null;
  modifier: number;
  checkMode: "normal" | "advantage" | "disadvantage" | null;
  dice: number[];
  kept: number | null;
  total: number | null;
  margin: number | null;
  outcome: OutcomeGrade | null;
  effects: ResolvedEffect[];
  operations: WorldDeltaOperation[];
}

export interface ResolutionEvidenceIndex {
  actions: ReadonlySet<string>;
  entities: ReadonlySet<string>;
  facts: ReadonlySet<string>;
  conditions: ReadonlySet<string>;
  conditionOwners: ReadonlyMap<string, string>;
  laws: ReadonlySet<string>;
  placements: ReadonlySet<string>;
  ratingOwners: ReadonlyMap<string, string>;
  ratingValues: ReadonlyMap<string, number>;
}

export interface DerivedCheck {
  dc: number;
  modifier: number;
  mode: "normal" | "advantage" | "disadvantage";
}

export interface ImpactProfileDefinition {
  id: string;
  name: string;
  meterDefinitionId: string;
  direction: "increase" | "decrease";
  amounts: Record<MagnitudeBand, number>;
}

export type DurationProfileDefinition = {
  id: string;
  name: string;
} & (
  | { kind: "uses"; uses: number }
  | { kind: "elapsed"; seconds: number }
  | { kind: "until_cleared" }
);

export interface ConditionProfileDefinition {
  id: string;
  name: string;
  stackingKey: string | null;
  defaultDurationProfileId: string;
  recurringImpactProfileId: string | null;
  recovery: string | null;
  thresholds: Array<{
    at: MagnitudeBand;
    description: string;
  }>;
}

export interface EntityMechanicsProfileDefinition {
  id: string;
  name: string;
  meters: Array<{ definitionId: string; current: number }>;
  quantities: Array<{ definitionId: string; amount: number }>;
  ratings: Array<{ definitionId: string; value: number }>;
}

export interface AdjudicationCalibration {
  id: string;
  situation: string;
  difficulty: DifficultyBand | "opposed" | "automatic" | "blocked";
  risk: RiskBand;
  effect: MagnitudeBand;
  explanation: string;
}

export interface ConditionState {
  id: string;
  subjectId: string;
  label: string;
  description: string;
  magnitude: MagnitudeBand;
  durationProfileId: string;
  conditionProfileId: string | null;
  stackingKey: string | null;
  remainingUses: number | null;
  expiresAtElapsedSeconds: number | null;
  access: WorldFact["access"];
  provenance: CausalRef[];
}

const magnitudeIndex = new Map<MagnitudeBand, number>(magnitudeBands.map((band, index) => [band, index]));
const gradeIndex = new Map<OutcomeGrade, number>(outcomeGrades.map((grade, index) => [grade, index]));

export const difficultyDc: Record<DifficultyBand, number> = {
  trivial: 5,
  easy: 10,
  challenging: 15,
  hard: 20,
  extreme: 25,
};

export const riskConsequence: Record<RiskBand, { mixed: MagnitudeBand; miss: MagnitudeBand }> = {
  safe: { mixed: "none", miss: "minor" },
  risky: { mixed: "minor", miss: "standard" },
  dire: { mixed: "major", miss: "decisive" },
};

export function shiftMagnitude(band: MagnitudeBand, steps: number): MagnitudeBand {
  const index = magnitudeIndex.get(band);
  if (index === undefined || !Number.isSafeInteger(steps)) throw new Error("invalid magnitude shift");
  return magnitudeBands[Math.max(0, Math.min(magnitudeBands.length - 1, index + steps))]!;
}

export function compareMagnitude(left: MagnitudeBand, right: MagnitudeBand): number {
  return magnitudeIndex.get(left)! - magnitudeIndex.get(right)!;
}

export function shiftOutcome(grade: OutcomeGrade, steps: number): OutcomeGrade {
  const index = gradeIndex.get(grade);
  if (index === undefined || !Number.isSafeInteger(steps)) throw new Error("invalid outcome shift");
  return outcomeGrades[Math.max(0, Math.min(outcomeGrades.length - 1, index + steps))]!;
}

function sourceKey(source: ResolutionSourceRef): string {
  return `${source.kind}:${source.id}`;
}

function sourceExists(source: ResolutionSourceRef, index: ResolutionEvidenceIndex): boolean {
  switch (source.kind) {
    case "action": return index.actions.has(source.id);
    case "entity": return index.entities.has(source.id);
    case "fact": return index.facts.has(source.id);
    case "condition": return index.conditions.has(source.id);
    case "rating": return index.ratingOwners.has(source.id);
    case "law": return index.laws.has(source.id);
    case "placement": return index.placements.has(source.id);
  }
}

/** Semantic check choices share one evidence contract and numeric rule. */
export function deriveCheckNumbers(
  input: Pick<ResolutionPlan, "actorId" | "actorRatingId" | "targetIds"> & { difficulty: ResolutionDifficulty },
  index: ResolutionEvidenceIndex,
  label: string,
): Pick<DerivedCheck, "dc" | "modifier"> {
  if (input.actorRatingId && index.ratingOwners.get(input.actorRatingId) !== input.actorId) {
    throw new Error(`${label} actor rating is not owned by the actor`);
  }
  const difficulty = input.difficulty;
  if (!sourceExists(difficulty.source, index)) throw new Error(`${label} has ungrounded difficulty`);
  if (difficulty.kind === "opposed") {
    if (!input.targetIds.includes(difficulty.targetId) ||
      index.ratingOwners.get(difficulty.ratingId) !== difficulty.targetId) {
      throw new Error(`${label} has invalid opposed rating`);
    }
    if (difficulty.source.kind !== "rating" || difficulty.source.id !== difficulty.ratingId) {
      throw new Error(`${label} opposed difficulty does not cite its rating`);
    }
  }
  if (input.actorRatingId && difficulty.source.kind === "rating" && difficulty.source.id === input.actorRatingId) {
    throw new Error(`${label} assigns source ${sourceKey(difficulty.source)} more than one mechanical role: difficulty.source conflicts with actorRatingRef`);
  }
  return {
    dc: difficulty.kind === "environment" ? difficultyDc[difficulty.band] : 10 + requiredRatingValue(difficulty.ratingId, index),
    modifier: input.actorRatingId ? requiredRatingValue(input.actorRatingId, index) : 0,
  };
}

export function validateResolutionPlan(
  plan: ResolutionPlan,
  index: ResolutionEvidenceIndex,
): void {
  if (!index.actions.has(plan.actionId)) throw new Error(`plan ${plan.id} references unknown action ${plan.actionId}`);
  if (!index.entities.has(plan.actorId)) throw new Error(`plan ${plan.id} references unknown actor ${plan.actorId}`);
  if (!plan.goal.trim()) throw new Error(`plan ${plan.id} has no goal`);
  if (plan.targetIds.length !== new Set(plan.targetIds).size ||
    plan.targetIds.some((targetId) => !index.entities.has(targetId))) {
    throw new Error(`plan ${plan.id} has invalid targets`);
  }
  if (plan.mode !== "blocked" && plan.means.length === 0 &&
    !(plan.mode === "automatic" && plan.baseEffect === "none")) {
    throw new Error(`plan ${plan.id} has no grounded means`);
  }
  for (const mean of plan.means) {
    if (!mean.description.trim() || !sourceExists(mean.source, index)) {
      throw new Error(`plan ${plan.id} has ungrounded means ${sourceKey(mean.source)}`);
    }
  }

  if (plan.mode === "check" && !plan.difficulty) throw new Error(`plan ${plan.id} check has no difficulty`);
  if (plan.mode !== "check" && (plan.difficulty || plan.actorRatingId)) {
    throw new Error(`plan ${plan.id} ${plan.mode} mode cannot carry check inputs`);
  }
  if (plan.difficulty) {
    deriveCheckNumbers({ ...plan, difficulty: plan.difficulty }, index, `plan ${plan.id}`);
  }

  const preassignedSources = new Map<string, string>();
  if (plan.actorRatingId) preassignedSources.set(sourceKey({ kind: "rating", id: plan.actorRatingId }), "actorRatingRef");
  if (plan.difficulty) {
    const difficultyKey = sourceKey(plan.difficulty.source);
    if (preassignedSources.has(difficultyKey)) {
      throw new Error(`plan ${plan.id} assigns source ${difficultyKey} more than one mechanical role: difficulty.source conflicts with ${preassignedSources.get(difficultyKey)}`);
    }
    preassignedSources.set(difficultyKey, "difficulty.source");
  }
  const factorSources = new Map<string, string>();
  for (const [factorIndex, factor] of plan.factors.entries()) {
    const key = sourceKey(factor.source);
    if (factorSources.has(key) || preassignedSources.has(key)) {
      throw new Error(`plan ${plan.id} assigns source ${key} more than one mechanical role: factors[${factorIndex}].source (${factor.role}) conflicts with ${factorSources.get(key) ?? preassignedSources.get(key)}. Neutral permission, secondary and risk factors also consume the source's one mechanical assignment`);
    }
    factorSources.set(key, `factors[${factorIndex}].source (${factor.role})`);
    if (!sourceExists(factor.source, index)) throw new Error(`plan ${plan.id} cites unknown factor ${key}`);
    if (!factor.explanation.trim()) throw new Error(`plan ${plan.id} has an unexplained factor`);
    if (factor.authority === "authored" && factor.source.kind !== "rating" && factor.source.kind !== "law") {
      throw new Error(`plan ${plan.id} has an unauthoritative authored factor`);
    }
    if (factor.authority === "semantic" && factor.steps > 1) {
      throw new Error(`plan ${plan.id} gives an ordinary semantic factor more than one step`);
    }
    if ((factor.role === "permission" || factor.role === "secondary" || factor.role === "risk") &&
      (factor.direction !== "neutral" || factor.steps !== 0)) {
      throw new Error(`plan ${plan.id} uses a numeric ${factor.role} factor`);
    }
    if (factor.role === "control" && (factor.direction === "neutral" || factor.steps !== 1)) {
      throw new Error(`plan ${plan.id} control factors must be one edge or hindrance`);
    }
    if ((factor.role === "potency" || factor.role === "protection") &&
      (factor.direction === "neutral" || factor.steps === 0 || !factor.channel)) {
      throw new Error(`plan ${plan.id} ${factor.role} factors require a relevant channel and steps`);
    }
  }

  if (plan.mode === "blocked") {
    if (plan.baseEffect !== "none" || plan.primaryEffect || plan.secondaryEffect || plan.threatenedEffect) {
      throw new Error(`blocked plan ${plan.id} cannot carry effects`);
    }
    return;
  }
  if (plan.mode === "check" && (!plan.primaryEffect || plan.primaryEffect.magnitude === "none" || !plan.threatenedEffect)) {
    throw new ResolutionCheckEffectError(plan);
  }
  if (!plan.primaryEffect) {
    if (plan.mode !== "automatic" || plan.baseEffect !== "none" || plan.secondaryEffect || plan.threatenedEffect) {
      throw new Error(`plan ${plan.id} requires a non-none primary effect`);
    }
    return;
  }
  if (plan.primaryEffect.magnitude === "none") throw new Error(`plan ${plan.id} requires a non-none primary effect`);
  if (plan.primaryEffect.magnitude !== plan.baseEffect) {
    throw new Error(`plan ${plan.id} base effect does not match its primary effect`);
  }

  const intended = [plan.primaryEffect, plan.secondaryEffect].filter((effect): effect is EffectIntent => Boolean(effect));
  for (const effect of intended) {
    if (!plan.targetIds.includes(effect.targetId)) throw new Error(`plan ${plan.id} effect targets an undeclared entity`);
    if (!effect.channel.trim() || !effect.label.trim() || !effect.description.trim() || effect.sourceRefs.length === 0 ||
      effect.sourceRefs.some((source) => !sourceExists(source, index))) {
      throw new Error(`plan ${plan.id} has an invalid ${effect.id} effect`);
    }
    if (effect.kind === "condition") {
      const existingSubject = index.conditionOwners.get(effect.conditionId);
      if (existingSubject && existingSubject !== effect.targetId) {
        throw new Error(`plan ${plan.id} reuses condition ${effect.conditionId} for another subject`);
      }
    }
  }
  if (plan.threatenedEffect && !plan.targetIds.includes(plan.threatenedEffect.targetId)) {
    throw new Error(`plan ${plan.id} threat targets an undeclared entity`);
  }
  if (plan.threatenedEffect && (!plan.threatenedEffect.channel.trim() ||
    !plan.threatenedEffect.label.trim() || !plan.threatenedEffect.description.trim() ||
    plan.threatenedEffect.sourceRefs.length === 0 ||
    plan.threatenedEffect.sourceRefs.some((source) => !sourceExists(source, index)))) {
    throw new Error(`plan ${plan.id} has an invalid ${plan.threatenedEffect.id} threat`);
  }
  if (plan.threatenedEffect?.kind === "condition") {
    const existingSubject = index.conditionOwners.get(plan.threatenedEffect.conditionId);
    if (existingSubject && existingSubject !== plan.threatenedEffect.targetId) {
      throw new Error(`plan ${plan.id} reuses condition ${plan.threatenedEffect.conditionId} for another subject`);
    }
  }
  if (plan.secondaryEffect) {
    if (compareMagnitude(plan.secondaryEffect.magnitude, plan.primaryEffect.magnitude) >= 0) {
      throw new Error(`plan ${plan.id} secondary effect must be weaker than primary`);
    }
    const secondarySources = new Set(plan.secondaryEffect.sourceRefs.map(sourceKey));
    if (!plan.factors.some((factor) => factor.role === "secondary" && secondarySources.has(sourceKey(factor.source)))) {
      throw new Error(`plan ${plan.id} secondary effect has no uniquely assigned source`);
    }
    if (plan.factors.some((factor) => factor.role === "potency" && secondarySources.has(sourceKey(factor.source)))) {
      throw new Error(`plan ${plan.id} reuses a secondary source for potency`);
    }
  }
  const effectChannels = new Set(intended.map((effect) => effect.channel));
  for (const factor of plan.factors) {
    if ((factor.role === "potency" || factor.role === "protection") && !effectChannels.has(factor.channel!)) {
      throw new Error(`plan ${plan.id} applies ${factor.role} to an irrelevant channel`);
    }
  }
  for (const channel of effectChannels) {
    const shift = effectShift(plan, channel);
    if (Math.abs(shift) > 2) throw new Error(`plan ${plan.id} exceeds the effect shift cap on ${channel}`);
    const semanticShift = plan.factors.reduce((total, factor) => {
      if (factor.authority !== "semantic" ||
        (factor.role !== "potency" && factor.role !== "protection") || factor.channel !== channel) return total;
      return total + (factor.direction === "helpful" ? factor.steps : -factor.steps);
    }, 0);
    if (Math.abs(semanticShift) > 1) {
      throw new Error(`plan ${plan.id} gives ordinary semantic factors more than one net step on ${channel}`);
    }
  }
}

export function deriveCheck(plan: ResolutionPlan, index: ResolutionEvidenceIndex): DerivedCheck {
  if (plan.mode !== "check" || !plan.difficulty) throw new Error(`plan ${plan.id} is not a check`);
  const { dc, modifier } = deriveCheckNumbers({ ...plan, difficulty: plan.difficulty }, index, `plan ${plan.id}`);
  let balance = 0;
  for (const factor of plan.factors) {
    if (factor.role !== "control") continue;
    balance += factor.direction === "helpful" ? 1 : -1;
  }
  return {
    dc,
    modifier,
    mode: balance > 0 ? "advantage" : balance < 0 ? "disadvantage" : "normal",
  };
}

function requiredRatingValue(ratingId: string, index: ResolutionEvidenceIndex): number {
  const value = index.ratingValues.get(ratingId);
  if (value === undefined || !Number.isFinite(value)) throw new Error(`rating ${ratingId} has no numeric value`);
  return value;
}

export function gradeD20(result: Pick<D20CheckResult, "margin" | "kept">): OutcomeGrade {
  let grade: OutcomeGrade = result.margin >= 10
    ? "exceptional"
    : result.margin >= 0
      ? "full"
      : result.margin >= -5
        ? "mixed"
        : "miss";
  if (result.kept === 20) grade = shiftOutcome(grade, 1);
  else if (result.kept === 1) grade = shiftOutcome(grade, -1);
  return grade;
}

function effectShift(plan: ResolutionPlan, channel: string): number {
  return plan.factors.reduce((total, factor) => {
    if ((factor.role !== "potency" && factor.role !== "protection") || factor.channel !== channel) return total;
    return total + (factor.direction === "helpful" ? factor.steps : -factor.steps);
  }, 0);
}

function withMagnitude(effect: ThreatenedEffect, magnitude: MagnitudeBand): EffectIntent {
  return { ...structuredClone(effect), magnitude } as EffectIntent;
}

function settleEffects(plan: ResolutionPlan, outcome: OutcomeGrade | null): ResolvedEffect[] {
  if (plan.mode === "blocked") return [];
  if (outcome === null) throw new Error(`plan ${plan.id} has no outcome`);
  const result: ResolvedEffect[] = [];
  if (outcome !== "miss") {
    const primary = plan.primaryEffect;
    if (!primary) return result;
    const outcomeShift = outcome === "exceptional" ? 1 : outcome === "mixed" ? -1 : 0;
    const primaryMagnitude = shiftMagnitude(
      primary.magnitude,
      Math.max(-2, Math.min(2, effectShift(plan, primary.channel))) + outcomeShift,
    );
    if (primaryMagnitude !== "none") {
      result.push({ role: "primary", magnitude: primaryMagnitude, intent: { ...structuredClone(primary), magnitude: primaryMagnitude } });
    }
    if (plan.secondaryEffect) {
      const secondary = plan.secondaryEffect;
      let secondaryMagnitude = shiftMagnitude(
        secondary.magnitude,
        Math.max(-2, Math.min(2, effectShift(plan, secondary.channel))) + (outcome === "mixed" ? -1 : 0),
      );
      const strongestSecondary = shiftMagnitude(primaryMagnitude, -1);
      if (compareMagnitude(secondaryMagnitude, strongestSecondary) > 0) secondaryMagnitude = strongestSecondary;
      if (secondaryMagnitude !== "none") {
        result.push({
          role: "secondary",
          magnitude: secondaryMagnitude,
          intent: { ...structuredClone(secondary), magnitude: secondaryMagnitude },
        });
      }
    }
  }
  if ((outcome === "mixed" || outcome === "miss") && plan.threatenedEffect) {
    const magnitude = riskConsequence[plan.risk][outcome];
    if (magnitude !== "none") {
      result.push({ role: "consequence", magnitude, intent: withMagnitude(plan.threatenedEffect, magnitude) });
    }
  }
  return result;
}

export function deriveResolutionReceipt(input: {
  receiptId: string;
  plan: ResolutionPlan;
  checkRequestId: string | null;
  check: DerivedCheck | null;
  result: D20CheckResult | null;
}): ResolutionReceipt {
  const { plan } = input;
  if (plan.mode === "check" && (!input.check || !input.result || !input.checkRequestId)) {
    throw new Error(`check plan ${plan.id} has no committed result`);
  }
  if (plan.mode !== "check" && (input.check || input.result || input.checkRequestId)) {
    throw new Error(`${plan.mode} plan ${plan.id} cannot consume a check result`);
  }
  const outcome = plan.mode === "blocked" ? null : plan.mode === "automatic" ? "full" : gradeD20(input.result!);
  return {
    id: input.receiptId,
    plan: structuredClone(plan),
    settled: true,
    checkRequestId: input.checkRequestId,
    dc: input.check?.dc ?? null,
    modifier: input.check?.modifier ?? 0,
    checkMode: input.check?.mode ?? null,
    dice: structuredClone(input.result?.dice ?? []),
    kept: input.result?.kept ?? null,
    total: input.result?.total ?? null,
    margin: input.result?.margin ?? null,
    outcome,
    effects: settleEffects(plan, outcome),
    operations: [],
  };
}

export function deriveClampedMeterDelta(current: number, min: number, max: number, desiredDelta: number): number {
  if (![current, min, max, desiredDelta].every(Number.isFinite) || min > max || current < min || current > max) {
    throw new Error("invalid bounded meter impact");
  }
  return Math.max(min, Math.min(max, current + desiredDelta)) - current;
}

export function validateImpactProfile(profile: ImpactProfileDefinition): void {
  if (profile.amounts.none !== 0) throw new Error(`impact profile ${profile.id} none must map to zero`);
  let previous = -Infinity;
  for (const band of magnitudeBands) {
    const amount = profile.amounts[band];
    if (!Number.isFinite(amount) || amount < 0 || amount < previous) {
      throw new Error(`impact profile ${profile.id} must be finite, non-negative, and monotonic`);
    }
    previous = amount;
  }
}

export function materializeCondition(input: {
  intent: ConditionEffectIntent;
  magnitude: MagnitudeBand;
  duration: DurationProfileDefinition;
  profile: ConditionProfileDefinition | null;
  elapsedSeconds: number;
  provenance: CausalRef[];
}): ConditionState {
  if (input.intent.durationProfileId !== input.duration.id) throw new Error("condition duration profile mismatch");
  if (input.intent.conditionProfileId !== input.profile?.id &&
    !(input.intent.conditionProfileId === null && input.profile === null)) {
    throw new Error("condition profile mismatch");
  }
  if (input.profile && input.profile.defaultDurationProfileId !== input.duration.id) {
    throw new Error("condition profile default duration mismatch");
  }
  return {
    id: input.intent.conditionId,
    subjectId: input.intent.targetId,
    label: input.intent.label,
    description: input.intent.description,
    magnitude: input.magnitude,
    durationProfileId: input.duration.id,
    conditionProfileId: input.profile?.id ?? null,
    stackingKey: input.profile?.stackingKey ?? null,
    remainingUses: input.duration.kind === "uses" ? input.duration.uses : null,
    expiresAtElapsedSeconds: input.duration.kind === "elapsed" ? input.elapsedSeconds + input.duration.seconds : null,
    access: structuredClone(input.intent.access),
    provenance: structuredClone(input.provenance),
  };
}

function sameStack(left: ConditionState, right: ConditionState): boolean {
  return left.subjectId === right.subjectId &&
    (left.id === right.id || (left.stackingKey !== null && left.stackingKey === right.stackingKey));
}

export function mergeCondition(
  existing: readonly ConditionState[],
  incoming: ConditionState,
): { conditions: ConditionState[]; condition: ConditionState; merged: boolean } {
  const index = existing.findIndex((condition) => sameStack(condition, incoming));
  if (index < 0) {
    return { conditions: [...structuredClone(existing), structuredClone(incoming)], condition: structuredClone(incoming), merged: false };
  }
  const previous = existing[index]!;
  const comparison = compareMagnitude(incoming.magnitude, previous.magnitude);
  const magnitude = comparison > 0
    ? incoming.magnitude
    : comparison === 0
      ? shiftMagnitude(previous.magnitude, 1)
      : previous.magnitude;
  const provenance = [...previous.provenance, ...incoming.provenance].filter((source, sourceIndex, all) =>
    all.findIndex((candidate) => candidate.kind === source.kind && candidate.id === source.id) === sourceIndex);
  const condition: ConditionState = {
    ...structuredClone(incoming),
    id: previous.id,
    magnitude,
    provenance,
  };
  const conditions = existing.map((condition) => structuredClone(condition));
  conditions[index] = condition;
  return { conditions, condition: structuredClone(condition), merged: true };
}

export function expectedActionStatus(
  receipt: ResolutionReceipt,
): "succeeded" | "partial" | "failed" | "blocked" {
  switch (receipt.outcome) {
    case null: return "blocked";
    case "exceptional":
    case "full": return "succeeded";
    case "mixed": return "partial";
    case "miss": return "failed";
  }
}
