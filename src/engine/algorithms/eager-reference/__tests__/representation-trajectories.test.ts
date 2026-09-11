import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import type { AgentActionProposal, SimulationState } from "../../../contracts/model";
import { actionCompilationCandidateKeySchema, referenceHandleFor } from "../../../contracts/model-context";
import { actionCompilationBatchSchema, type ActionCompilationBatchDraft } from "../../../contracts/llm-schemas";
import { contentHash } from "../../../models/model-audit";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../../testing/model-provider";
import { compileActions } from "../action-compiler";
import { ActionCompilationCodec } from "../action-compilation-representation";
import { representedActionCompiler } from "../represented-action-compiler";
import {
  advanceTemporalState, cancelActivity, evaluateActivityContinuation, pauseActivity,
  resumeActivity, selectTemporalBoundary, validateActivityResources, type ActivityState,
} from "../../../mechanics/temporal";
import { applyWorldDeltaOperation } from "../../../runtime/transaction";
import type { CompiledAction } from "../../roles";

const cases = [
  ["brief-action", "Inspect the gate and improvise a signal for an unknown helper.", false],
  ["explicit-duration", "Observe the gate for 2 minutes.", true],
  ["measured-travel", "Walk 2 km, carrying a newly proposed tool.", true],
  ["staged-treatment", "Inspect and treat the injury in stages.", true],
  ["wait-condition", "Wait while the gate lock still points to the gate.", true],
  ["ongoing-action", "Keep observing while the gate lock still points to the gate.", true],
] as const;

async function compiledPair(profile: string, rawText: string, assertions: boolean) {
  let canonical: unknown;
  const provider = new ScriptedModelProvider(({ profileId, context }) => {
    canonical = deterministicActionCompilationBatch(profileId, context, (draft, slot) => {
      draft.temporalPlan.profileRef = referenceHandleFor("temporal_profile", profile);
      if (profile === "explicit-duration" || profile === "measured-travel") {
        const evidence = slot.temporalEvidence.find((entry) => entry.kind === (profile === "measured-travel" ? "quantity" : "duration"));
        if (!evidence) throw new Error("fixture has no exact temporal evidence");
        draft.temporalPlan.basis = { kind: "action_text_evidence", evidenceKey: evidence.key };
      }
      if (assertions) {
        draft.temporalPlan.continuationAssertions = [
          { kind: "fact_matches", factRef: referenceHandleFor("fact", "gate-lock"), expected: { kind: "entity", entityRef: referenceHandleFor("entity", "gate") } },
          { kind: "entity_lifecycle", entityRef: referenceHandleFor("entity", "player"), expected: "active" },
        ];
        draft.temporalPlan.causes.push({ kind: "fact", ref: referenceHandleFor("fact", "gate-lock") });
        draft.interactionDependency.stateDependencies.requiredExistingRefs.push(referenceHandleFor("fact", "gate-lock"));
        draft.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs.push(referenceHandleFor("entity", "gate"));
      }
    });
    return canonical;
  });
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  state.truth.facts["gate-lock"]!.value = { kind: "entity", entityId: "gate" };
  const action: AgentActionProposal = { id: "trajectory-action", actorId: "player", baseRevision: 0, rawText, goal: rawText, means: null, targetIds: [] };
  const scope = { workloadId: "trajectory", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const before = contentHash(state);
  const baseline = await compileActions(provider, state, [action], scope, "truth-engine", 12);
  const codec = new ActionCompilationCodec("AT", provider.requests[0]!.context);
  const wire = new ScriptedModelProvider(() => codec.encodeOutput(canonical));
  const treatment = await representedActionCompiler("AT")(wire, state, [action], scope, "truth-engine", 12);
  expect(contentHash(state)).toBe(before);
  expect(treatment.compilations).toEqual(baseline.compilations);
  return { state, baseline: baseline.compilations[0]!, treatment: treatment.compilations[0]! };
}

function trace(source: SimulationState, compilation: CompiledAction, perturbation: "none" | "gate" | "unrelated") {
  const state = structuredClone(source);
  let activities: Record<string, ActivityState> = { [compilation.activity.id]: structuredClone(compilation.activity) };
  const rows: unknown[] = [];
  for (let step = 0; step < 6; step++) {
    if (step === 2 && perturbation === "gate") {
      const fact = structuredClone(state.truth.facts["gate-lock"]!);
      fact.value = { kind: "entity", entityId: "player" };
      applyWorldDeltaOperation(state, { kind: "set_fact", fact,
        causes: [{ kind: "action", id: compilation.plan.actionId }],
        assertions: [{ kind: "entity_lifecycle", entityId: "gate", expected: "active" }],
      });
    }
    if (step === 2 && perturbation === "unrelated") {
      // Changing an unrelated entity's descriptive text must not affect the
      // gate assertion, scheduler boundary, resource occupancy or activity.
      state.truth.entities.keeper!.description += " An unrelated note.";
    }
    const boundary = selectTemporalBoundary({ elapsedSeconds: state.truth.elapsedSeconds,
      maxAutonomousSpanSeconds: 600, activities, timers: {}, conditionExpiries: {} });
    const advanced = advanceTemporalState({ boundary, activities, timers: {} });
    state.truth.elapsedSeconds = boundary.toElapsedSeconds;
    activities = advanced.activities;
    const activity = activities[compilation.activity.id]!;
    validateActivityResources(activities, state.truth.mechanics.activityResources);
    rows.push({ boundary, advanced, continuation: evaluateActivityContinuation(state, activity) });
  }
  return rows;
}

describe("representation world-trajectory invariants", () => {
  it("repairs a disallowed agent dependency using the same alias in rejected evidence and previous output", async () => {
    let canonical!: ActionCompilationBatchDraft;
    const baseline = new ScriptedModelProvider(({ profileId, context }) => {
      canonical = actionCompilationBatchSchema.parse(deterministicActionCompilationBatch(profileId, context));
      return canonical;
    });
    const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: baseline.catalog });
    const action: AgentActionProposal = { id: "watch", actorId: "player", baseRevision: 0, rawText: "Observe the courtyard", goal: "Observe", means: null, targetIds: [] };
    const scope = { workloadId: "repair", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
    const before = contentHash(state);
    const expected = await compileActions(baseline, state, [action], scope, "truth-engine", 12);
    const root = baseline.requests[0]!.context as { referenceCatalog: { candidates: Array<{ kind: string; candidateKey: string }> } };
    const agent = root.referenceCatalog.candidates.find(candidate => candidate.kind === "agent")!;
    const codec = new ActionCompilationCodec("AT", root);
    const rejected = structuredClone(canonical);
    rejected.slots[0]!.interactionDependency.stateDependencies.requiredExistingCandidateKeys.push(actionCompilationCandidateKeySchema.parse(agent.candidateKey));
    let calls = 0;
    const wire = new ScriptedModelProvider(({ context }) => {
      if (++calls === 1) return codec.encodeOutput(rejected);
      const slot = (context as { task: { slots: Array<{ issues: Array<{ code: string; originalValue: string; allowedHandles: string[] }>; previousAttempt: ActionCompilationBatchDraft["slots"][number] }> } }).task.slots[0]!;
      expect(slot.issues[0]!.code).toBe("reference.disallowed_use");
      expect(slot.issues[0]!.originalValue).toBe(codec.aliases.get(agent.candidateKey));
      expect(slot.previousAttempt.interactionDependency.stateDependencies.requiredExistingCandidateKeys.at(-1)).toBe(slot.issues[0]!.originalValue);
      expect(slot.issues[0]!.allowedHandles).not.toContain(slot.issues[0]!.originalValue);
      return codec.encodeOutput(canonical);
    });
    const actual = await representedActionCompiler("AT")(wire, state, [action], scope, "truth-engine", 12);
    expect(calls).toBe(2);
    expect(actual.compilations).toEqual(expected.compilations);
    expect(contentHash(state)).toBe(before);
  });
  it.each(cases)("preserves six real temporal boundaries and counterfactuals for %s", async (profile, text, assertions) => {
    const pair = await compiledPair(profile, text, assertions);
    for (const perturbation of ["none", "gate", "unrelated"] as const) {
      expect(trace(pair.state, pair.treatment, perturbation)).toEqual(trace(pair.state, pair.baseline, perturbation));
    }
    expect(trace(pair.state, pair.treatment, "unrelated")).toEqual(trace(pair.state, pair.treatment, "none"));
    if (assertions) expect(trace(pair.state, pair.treatment, "gate")).not.toEqual(trace(pair.state, pair.treatment, "none"));
    expect(pair.treatment.activity.sourceAction.rawText).toBe(text);
  });

  it("preserves pause/resume/cancel timing and rejects double resource occupancy", async () => {
    const pair = await compiledPair("ongoing-action", "Keep observing the gate.", true);
    const controls = (compilation: CompiledAction) => {
      const first = compilation.activity;
      const second = { ...structuredClone(first), id: "competing-activity" };
      expect(() => validateActivityResources({ first, second }, pair.state.truth.mechanics.activityResources)).toThrow("exceeds activity resource");
      const paused = pauseActivity(first, 0);
      expect(() => validateActivityResources({ first: paused.activity, second }, pair.state.truth.mechanics.activityResources)).toThrow("exceeds activity resource");
      const resumed = resumeActivity(paused.activity, 0);
      const cancelled = cancelActivity(resumed.activity, 0);
      expect(() => validateActivityResources({ first: cancelled.activity, second }, pair.state.truth.mechanics.activityResources)).not.toThrow();
      return { paused, resumed, cancelled };
    };
    expect(controls(pair.treatment)).toEqual(controls(pair.baseline));
  });
});
