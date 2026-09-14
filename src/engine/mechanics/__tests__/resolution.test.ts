import { describe, expect, it } from "vitest";
import type { D20CheckResult } from "../../contracts/model";
import {
  deriveCheck,
  deriveClampedMeterDelta,
  deriveResolutionReceipt,
  difficultyDc,
  gradeD20,
  materializeCondition,
  mergeCondition,
  shiftMagnitude,
  validateImpactProfile,
  validateResolutionPlan,
  type ConditionEffectIntent,
  type ConditionState,
  type ResolutionEvidenceIndex,
  type ResolutionPlan,
} from "../resolution";

function evidence(): ResolutionEvidenceIndex {
  return {
    actions: new Set(["strike"]),
    entities: new Set(["hero", "foe", "sword", "sand-ground"]),
    facts: new Set(["sword-burning"]),
    conditions: new Set(["armored"]),
    conditionOwners: new Map([["armored", "hero"]]),
    laws: new Set(["ordinary-physics"]),
    placements: new Set(["courtyard"]),
    ratingOwners: new Map([["hero-prowess", "hero"], ["foe-defense", "foe"]]),
    ratingValues: new Map([["hero-prowess", 3], ["foe-defense", 4]]),
  };
}

function conditionIntent(overrides: Partial<ConditionEffectIntent> = {}): ConditionEffectIntent {
  return {
    kind: "condition",
    id: "burning-effect",
    targetId: "foe",
    channel: "fire",
    label: "burning",
    description: "Flames cling to clothing.",
    sourceRefs: [{ kind: "fact", id: "sword-burning" }],
    conditionId: "burning",
    conditionProfileId: "burning-profile",
    durationProfileId: "ongoing",
    access: { kind: "public" },
    magnitude: "minor",
    ...overrides,
  };
}

function plan(overrides: Partial<ResolutionPlan> = {}): ResolutionPlan {
  return {
    id: "plan-strike",
    actionId: "strike",
    actorId: "hero",
    targetIds: ["foe", "hero"],
    goal: "Drive the foe back with the burning sword.",
    means: [{ description: "the sword in hand", source: { kind: "entity", id: "sword" } }],
    mode: "check",
    difficulty: {
      kind: "opposed",
      targetId: "foe",
      ratingId: "foe-defense",
      source: { kind: "rating", id: "foe-defense" },
    },
    actorRatingId: "hero-prowess",
    factors: [{
      source: { kind: "fact", id: "sword-burning" },
      role: "secondary",
      direction: "neutral",
      steps: 0,
      authority: "semantic",
      channel: null,
      explanation: "The flame can persist after the blade lands.",
    }],
    risk: "risky",
    baseEffect: "standard",
    primaryEffect: {
      kind: "meter",
      id: "harm",
      targetId: "foe",
      channel: "physical-harm",
      label: "harm",
      description: "The blade wounds the foe.",
      sourceRefs: [{ kind: "entity", id: "sword" }],
      meterId: "foe-vitality",
      impactProfileId: "harm",
      magnitude: "standard",
    },
    secondaryEffect: conditionIntent(),
    threatenedEffect: {
      kind: "condition",
      id: "opening",
      targetId: "hero",
      channel: "position",
      label: "off-balance",
      description: "The committed swing leaves an opening.",
      sourceRefs: [{ kind: "action", id: "strike" }],
      conditionId: "off-balance",
      conditionProfileId: null,
      durationProfileId: "brief",
      access: { kind: "public" },
    },
    visibility: "full",
    causes: [{ kind: "action", id: "strike" }],
    ...overrides,
  };
}

function result(margin: number, kept = 10): D20CheckResult {
  return {
    requestId: "check-strike",
    dice: [kept],
    kept,
    modifier: 3,
    total: kept + 3,
    dc: kept + 3 - margin,
    succeeded: margin >= 0,
    margin,
    visibility: "full",
  };
}

describe("open semantic resolution", () => {
  it("preserves permission and risk explanations without counting their evidence twice", () => {
    const source = { kind: "fact" as const, id: "sword-burning" };
    const permission = { source, role: "permission" as const, direction: "neutral" as const,
      steps: 0 as const, authority: "semantic" as const, channel: null, explanation: "The flame permits ignition." };
    const risk = { ...permission, role: "risk" as const, explanation: "The flame may expose the wielder." };
    const mechanical = plan({ factors: [], secondaryEffect: null, means: [{ description: "Use the burning blade.", source }] });
    const valid = { ...mechanical, factors: [permission, risk] };
    const before = structuredClone(valid);
    expect(() => validateResolutionPlan(valid, evidence())).not.toThrow();
    expect(valid).toEqual(before);
    expect(deriveCheck(valid, evidence())).toEqual(deriveCheck(mechanical, evidence()));
    expect(() => validateResolutionPlan({ ...valid, id: "another-plan" }, evidence())).not.toThrow();
    const annotatedInputs = { ...mechanical, factors: [
      { ...permission, source: { kind: "rating" as const, id: "hero-prowess" } },
      { ...risk, source: { kind: "rating" as const, id: "foe-defense" } },
    ] };
    expect(() => validateResolutionPlan(annotatedInputs, evidence())).not.toThrow();
    expect(deriveCheck(annotatedInputs, evidence())).toEqual(deriveCheck(mechanical, evidence()));
    const secondary = plan();
    const annotatedSecondary = { ...secondary, factors: [...secondary.factors, permission, risk] };
    expect(() => validateResolutionPlan(annotatedSecondary, evidence())).not.toThrow();
    const receipt = (value: ResolutionPlan) => deriveResolutionReceipt({ receiptId: "receipt", plan: value,
      checkRequestId: "check-strike", check: deriveCheck(value, evidence()), result: result(4, 15) });
    expect(receipt(annotatedSecondary).effects).toEqual(receipt(secondary).effects);
  });

  it("rejects repeated annotation roles, numeric notes and invalid evidence without deleting explanations", () => {
    const permission = { source: { kind: "fact" as const, id: "sword-burning" }, role: "permission" as const, direction: "neutral" as const,
      steps: 0 as const, authority: "semantic" as const, channel: null, explanation: "The flame permits ignition." };
    const value = plan({ factors: [permission, { ...permission, explanation: "A second description does not create a second permission." }], secondaryEffect: null });
    expect(() => validateResolutionPlan(value, evidence())).toThrow("repeats evidence annotation");
    expect(value.factors).toHaveLength(2);
    expect(() => validateResolutionPlan({ ...value, factors: [{ ...permission, direction: "helpful", steps: 1 }] }, evidence())).toThrow("numeric permission");
    expect(() => validateResolutionPlan({ ...value, factors: [{ ...permission, source: { kind: "fact", id: "missing" } }] }, evidence())).toThrow("unknown factor");
    expect(() => validateResolutionPlan({ ...value, factors: [{ ...permission, authority: "authored" }] }, evidence())).toThrow("unauthoritative authored factor");
  });
  it("maps named difficulty and opposed ratings without fact modifiers", () => {
    expect(difficultyDc).toEqual({ trivial: 5, easy: 10, challenging: 15, hard: 20, extreme: 25 });
    const value = plan();
    validateResolutionPlan(value, evidence());
    expect(deriveCheck(value, evidence())).toEqual({ dc: 14, modifier: 3, mode: "normal" });
  });

  it("cancels semantic edges and enforces actor rating ownership", () => {
    const value = plan({
      factors: [
        { source: { kind: "entity", id: "sword" }, role: "control", direction: "helpful", steps: 1, authority: "semantic", channel: null, explanation: "Reach." },
        { source: { kind: "condition", id: "armored" }, role: "control", direction: "hindering", steps: 1, authority: "semantic", channel: null, explanation: "Restricted opening." },
      ],
      secondaryEffect: null,
    });
    validateResolutionPlan(value, evidence());
    expect(deriveCheck(value, evidence()).mode).toBe("normal");
    expect(() => validateResolutionPlan({ ...value, actorRatingId: "foe-defense" }, evidence()))
      .toThrow("not owned by the actor");
  });

  it("grades margins and natural 20/1 as bounded one-grade shifts", () => {
    expect(gradeD20(result(10))).toBe("exceptional");
    expect(gradeD20(result(0))).toBe("full");
    expect(gradeD20(result(-5))).toBe("mixed");
    expect(gradeD20(result(-6))).toBe("miss");
    expect(gradeD20(result(-6, 20))).toBe("mixed");
    expect(gradeD20(result(12, 1))).toBe("full");
  });

  it("settles intended and threatened effects deterministically", () => {
    const value = plan();
    const mixed = deriveResolutionReceipt({
      receiptId: "receipt-strike",
      plan: value,
      checkRequestId: "check-strike",
      check: deriveCheck(value, evidence()),
      result: result(-2),
    });
    expect(mixed.outcome).toBe("mixed");
    expect(mixed.effects.map((effect) => [effect.role, effect.magnitude])).toEqual([
      ["primary", "minor"],
      ["consequence", "minor"],
    ]);

    const exceptional = deriveResolutionReceipt({
      receiptId: "receipt-strike",
      plan: value,
      checkRequestId: "check-strike",
      check: deriveCheck(value, evidence()),
      result: result(10),
    });
    expect(exceptional.effects.map((effect) => [effect.role, effect.magnitude])).toEqual([
      ["primary", "major"],
      ["secondary", "minor"],
    ]);
  });

  it("rejects source reuse, oversized semantic shifts, and an equal secondary", () => {
    const reused = plan({
      factors: [
        { source: { kind: "fact", id: "sword-burning" }, role: "potency", direction: "helpful", steps: 1, authority: "semantic", channel: "physical-harm", explanation: "Hot blade." },
        { source: { kind: "fact", id: "sword-burning" }, role: "secondary", direction: "neutral", steps: 0, authority: "semantic", channel: null, explanation: "Ignition." },
      ],
    });
    expect(() => validateResolutionPlan(reused, evidence())).toThrow("factors[1].source (secondary) conflicts with factors[0].source (potency)");

    const reusedAptitude = plan({
      factors: [{
        source: { kind: "rating", id: "hero-prowess" },
        role: "potency",
        direction: "helpful",
        steps: 1,
        authority: "authored",
        channel: "physical-harm",
        explanation: "The same aptitude cannot improve both the roll and its effect.",
      }],
      secondaryEffect: null,
    });
    expect(() => validateResolutionPlan(reusedAptitude, evidence()))
      .toThrow("factors[0].source (potency) conflicts with actorRatingRef");

    const falseOppositionEvidence = plan({
      difficulty: {
        kind: "opposed",
        targetId: "foe",
        ratingId: "foe-defense",
        source: { kind: "law", id: "ordinary-physics" },
      },
    });
    expect(() => validateResolutionPlan(falseOppositionEvidence, evidence()))
      .toThrow("does not cite its rating");

    expect(() => validateResolutionPlan(plan({
      secondaryEffect: conditionIntent({ conditionId: "armored" }),
    }), evidence())).toThrow("for another subject");

    const oversized = plan({
      factors: [{ source: { kind: "entity", id: "sword" }, role: "potency", direction: "helpful", steps: 2, authority: "semantic", channel: "physical-harm", explanation: "Overclaim." }],
      secondaryEffect: null,
    });
    expect(() => validateResolutionPlan(oversized, evidence())).toThrow("more than one step");
    expect(() => validateResolutionPlan(plan({ secondaryEffect: conditionIntent({ magnitude: "standard" }) }), evidence()))
      .toThrow("weaker than primary");

    const inflatedByOrdinaryFactors = plan({
      factors: [
        { source: { kind: "entity", id: "sword" }, role: "potency", direction: "helpful", steps: 1, authority: "semantic", channel: "physical-harm", explanation: "Sharp edge." },
        { source: { kind: "fact", id: "sword-burning" }, role: "potency", direction: "helpful", steps: 1, authority: "semantic", channel: "physical-harm", explanation: "Heat." },
      ],
      secondaryEffect: null,
    });
    expect(() => validateResolutionPlan(inflatedByOrdinaryFactors, evidence()))
      .toThrow("more than one net step");

    expect(() => validateResolutionPlan(plan({
      baseEffect: "major",
      secondaryEffect: null,
    }), evidence())).toThrow("base effect does not match");
  });

  it("clamps meter impacts instead of rejecting bounded overflow", () => {
    expect(deriveClampedMeterDelta(3, 0, 30, -10)).toBe(-3);
    expect(deriveClampedMeterDelta(28, 0, 30, 5)).toBe(2);
  });

  it("validates monotonic impact profiles", () => {
    expect(() => validateImpactProfile({
      id: "harm",
      name: "Harm",
      meterDefinitionId: "vitality",
      direction: "decrease",
      amounts: { none: 0, minor: 2, standard: 5, major: 10, decisive: 30 },
    })).not.toThrow();
    expect(() => validateImpactProfile({
      id: "bad",
      name: "Bad",
      meterDefinitionId: "vitality",
      direction: "decrease",
      amounts: { none: 0, minor: 2, standard: 1, major: 10, decisive: 30 },
    })).toThrow("monotonic");
  });

  it("merges only matching identities or stacking keys and always refreshes duration", () => {
    const intent = conditionIntent();
    const incoming = materializeCondition({
      intent,
      magnitude: "standard",
      duration: { id: "ongoing", name: "Ongoing", kind: "elapsed", seconds: 60 },
      profile: {
        id: "burning-profile",
        name: "Burning",
        stackingKey: "burning",
        defaultDurationProfileId: "ongoing",
        recurringImpactProfileId: "harm",
        recovery: "Extinguish the flames.",
        thresholds: [],
      },
      elapsedSeconds: 40,
      provenance: [{ kind: "action", id: "strike" }],
    });
    const previous: ConditionState = {
      ...incoming,
      id: "older-burning",
      magnitude: "standard",
      expiresAtElapsedSeconds: 60,
      provenance: [{ kind: "fact", id: "sword-burning" }],
    };
    const merged = mergeCondition([previous], incoming);
    expect(merged.condition.id).toBe("older-burning");
    expect(merged.condition.magnitude).toBe("major");
    expect(merged.condition.expiresAtElapsedSeconds).toBe(100);
    expect(merged.condition.provenance).toHaveLength(2);

    const weaker = mergeCondition([merged.condition], { ...incoming, magnitude: "minor", expiresAtElapsedSeconds: 140 });
    expect(weaker.condition.magnitude).toBe("major");
    expect(weaker.condition.expiresAtElapsedSeconds).toBe(140);
    expect(shiftMagnitude("decisive", 1)).toBe("decisive");
    expect(() => materializeCondition({
      intent: { ...intent, durationProfileId: "brief" },
      magnitude: "standard",
      duration: { id: "brief", name: "Brief", kind: "uses", uses: 1 },
      profile: {
        id: "burning-profile",
        name: "Burning",
        stackingKey: "burning",
        defaultDurationProfileId: "ongoing",
        recurringImpactProfileId: "harm",
        recovery: "Extinguish the flames.",
        thresholds: [],
      },
      elapsedSeconds: 40,
      provenance: [{ kind: "action", id: "strike" }],
    })).toThrow("default duration mismatch");
  });
});
