import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { recordedContext } from "../../../benchmarks/step-efficiency/repair-tail";
import { actionCompilationBatchSchema, type ActionCompilationBatchDraft } from "../../../contracts/llm-schemas";
import { actionCompilationCandidateKeySchema, referenceHandleFor } from "../../../contracts/model-context";
import type { AgentActionProposal } from "../../../contracts/model";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import { createTestModelRegistry, deterministicActionCompilationBatch, ScriptedModelProvider } from "../../../testing/model-provider";
import { compileActions } from "../action-compiler";
import { ActionCompilationCodec } from "../action-compilation-representation";
import { representedActionCompiler } from "../represented-action-compiler";

it.each([false, true])("retains the whole rejected source-description attempt at the repair HTTP boundary (omitted schema %s)", async omitField => {
  let canonical!: ActionCompilationBatchDraft;
  const baseline = new ScriptedModelProvider(({ profileId, context }) => {
    canonical = actionCompilationBatchSchema.parse(deterministicActionCompilationBatch(profileId, context));
    return canonical;
  });
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: baseline.catalog });
  const actions: AgentActionProposal[] = ["keeper", "player"].map(actorId => ({ id: `inspect-${actorId}`, actorId,
    baseRevision: state.revision, rawText: `Inspect the gate as ${actorId}.`, goal: "Inspect the gate", means: null, targetIds: [] }));
  const scope = { workloadId: "description-evidence", batchId: "root", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const before = contentHash(state), expected = await compileActions(baseline, state, actions, scope, "truth-engine", 12);
  canonical.slots.forEach((slot, index) => { slot.temporalPlan.description = actions[index]!.rawText; });
  const codec = new ActionCompilationCodec("AT", baseline.requests[0]!.context);
  const bad = structuredClone(canonical);
  bad.slots[1]!.temporalPlan.description = "Inspect the gate and recruit a guard.";
  const repaired = codec.encodeOutput(canonical) as { slots: Array<{ temporalPlan: { description?: string } }> };
  repaired.slots.forEach(slot => { delete slot.temporalPlan.description; });
  let http = 0;
  const gateway = createModelGateway(baseline.catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    registry: createTestModelRegistry(baseline.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      const body = JSON.parse(String(init?.body)); http++;
      const context = recordedContext(body.messages[1].content).value as {
        task: { slots: Array<{ slot: number; issues: Array<{ code: string }>; previousAttempt: unknown }> };
      };
      expect(context.task.slots).toHaveLength(2);
      if (http > 1) {
        expect(http).toBe(2);
        expect(context.task.slots.map(slot => slot.previousAttempt)).toEqual((codec.encodeOutput(bad) as { slots: unknown[] }).slots);
        expect(context.task.slots.every(slot => slot.issues.some(issue => issue.code === "action_compilation.source_description_mismatch"))).toBe(true);
      }
      return new Response(JSON.stringify({ id: `source-repair-${http}`, model: body.model, choices: [{ index: 0,
        message: { role: "assistant", content: JSON.stringify(http === 1 ? codec.encodeOutput(bad) : repaired) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await representedActionCompiler("AT", true, true, false, false, omitField)(gateway, state, actions, scope, "truth-engine", 12);
  expect(http).toBe(2);
  expect(result.metrics.repairCalls).toBe(1);
  const expectedCompilations = structuredClone(expected.compilations);
  expectedCompilations.forEach((compilation, index) => {
    compilation.plan.description = actions[index]!.rawText;
    compilation.activity.plan.description = actions[index]!.rawText;
  });
  expect(result.compilations).toEqual(expectedCompilations);
  expect(contentHash(state)).toBe(before);
});

it.each([false, true])("sends every independent reference failure when a sibling schema is malformed: %s", async malformedSibling => {
  let canonical!: ActionCompilationBatchDraft;
  const baseline = new ScriptedModelProvider(({ profileId, context }) => {
    canonical = actionCompilationBatchSchema.parse(deterministicActionCompilationBatch(profileId, context, (draft, { action }) => {
      draft.temporalPlan.profileRef = referenceHandleFor("temporal_profile", "wait-condition");
      draft.temporalPlan.continuationAssertions = [
        { kind: "entity_lifecycle", entityRef: referenceHandleFor("entity", action.actorId), expected: "active" },
        { kind: "placement_equals", entityRef: referenceHandleFor("entity", action.actorId), placementRef: referenceHandleFor("placement", state.truth.placements[action.actorId]!) },
      ];
    }));
    return canonical;
  });
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: baseline.catalog });
  const actions: AgentActionProposal[] = ["keeper", "player"].map(actorId => ({ id: `wait-${actorId}`, actorId,
    baseRevision: state.revision, rawText: "Wait at my current position until the gate changes.", goal: "Watch the gate", means: null, targetIds: [] }));
  const scope = { workloadId: "repair-evidence", batchId: "root", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const before = contentHash(state), expected = await compileActions(baseline, state, actions, scope, "truth-engine", 12);
  const source = baseline.requests[0]!.context as { referenceCatalog: { candidates: Array<{ candidateKey: string; kind: string; label: string }> };
    task: { slots: Array<{ actionReferences: { actor: { agentCandidateKey: string } } }> } };
  const codec = new ActionCompilationCodec("AT", source);
  const agent = source.referenceCatalog.candidates.find(row => row.candidateKey === source.task.slots[1]!.actionReferences.actor.agentCandidateKey)!;
  expect(agent).toBeDefined();
  const bad = structuredClone(canonical), key = actionCompilationCandidateKeySchema.parse(agent.candidateKey);
  for (const assertion of bad.slots[1]!.temporalPlan.continuationAssertions) if ("entityRef" in assertion) assertion.entityRef = key;
  bad.slots[1]!.interactionDependency.stateDependencies.potentiallyAffectedCandidateKeys.push(key);
  if (malformedSibling) delete (bad.slots[0]!.temporalPlan as Partial<typeof bad.slots[0]["temporalPlan"]>).basis;
  const agentAlias = codec.aliases.get(key)!;
  const repaired = { slots: [{ ...structuredClone(canonical.slots[1]!), slot: 0 }] };
  let http = 0;
  const gateway = createModelGateway(baseline.catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    registry: createTestModelRegistry(baseline.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      const body = JSON.parse(String(init?.body)); http++;
      const context = recordedContext(body.messages[1].content).value as {
        task: { slots: Array<{ slot: number; issues: Array<{ code: string; path: Array<string | number>; originalValue: string; allowedHandles: string[] }>; previousAttempt: unknown }> };
      };
      expect(body.messages[0].content).toContain("Correct every listed failure");
      if (http === 1) {
        expect(context.task.slots).toHaveLength(2);
        expect(context.task.slots.every(slot => slot.issues.length === 0)).toBe(true);
      } else {
        expect(http).toBe(2);
        expect(context.task.slots).toHaveLength(malformedSibling ? 2 : 1);
        const slot = context.task.slots[malformedSibling ? 1 : 0]!;
        expect(slot.slot).toBe(malformedSibling ? 1 : 0);
        expect(slot.previousAttempt).toEqual((codec.encodeOutput(bad) as { slots: unknown[] }).slots[1]);
        expect(slot.issues.map(issue => issue.path)).toEqual([
          ["temporalPlan", "continuationAssertions", "first", "entityRef"],
          ["temporalPlan", "continuationAssertions", "rest", 0, "entityRef"],
          ["interactionDependency", "stateDependencies", "potentiallyAffectedCandidateKeys", 0],
        ]);
        for (const issue of slot.issues) {
          expect(issue.code).toBe("reference.disallowed_use");
          expect(issue.originalValue).toBe(agentAlias);
          expect(issue.allowedHandles).not.toContain(agentAlias);
          expect(issue.allowedHandles.length).toBeGreaterThan(0);
          const value = issue.path.reduce<unknown>((current, part) => (current as Record<string | number, unknown>)[part], slot.previousAttempt);
          expect(value).toBe(issue.originalValue);
        }
      }
      return new Response(JSON.stringify({ id: `repair-${http}`, model: body.model, choices: [{ index: 0,
        message: { role: "assistant", content: JSON.stringify(codec.encodeOutput(http === 1 ? bad : malformedSibling ? canonical : repaired)) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await representedActionCompiler("AT")(gateway, state, actions, scope, "truth-engine", 12);
  expect(http).toBe(2);
  expect(result.metrics.repairCalls).toBe(1);
  expect(result.compilations).toEqual(expected.compilations);
  expect(contentHash(state)).toBe(before);
});
