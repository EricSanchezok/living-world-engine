import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../../script/world-loader";
import type { AgentActionProposal } from "../../../contracts/model";
import type { ActionCompilationBatchDraft } from "../../../contracts/llm-schemas";
import { actionCompilationCandidateKeyForHandle, referenceHandleFor } from "../../../contracts/model-context";
import { contentHash } from "../../../models/model-audit";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../../testing/model-provider";
import { compileActions } from "../action-compiler";
import { createActionCompilationRetrievalRuntime } from "../candidate-retrieval/runtime";
import { PinnedActionCompilationSelection } from "../candidate-retrieval/pinned-selection";
import type { CandidateSelectionResult } from "../../roles";
import { createActivity, type TemporalPlan } from "../../../mechanics/temporal";

type Context = { task: { slots: Array<{ slot: number; action: { rawText: string }; actionReferences: { actionCandidateKey: string } }> };
  referenceCatalog: { candidates: Array<{ candidateKey: string; kind: string; label: string; scope: { kind: "shared" | "slot"; slot?: number } }> } } & Record<string, unknown>;
const actions: AgentActionProposal[] = ["keeper", "player"].map((actorId) => ({ id: `inspect-${actorId}`, actorId,
  baseRevision: 0, rawText: `${actorId} examines the gate.`, goal: "Inspect the gate", means: null, targetIds: [] }));

function setup() {
  const fixture = new ScriptedModelProvider(() => ({}));
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: fixture.catalog });
  // Enough genuine state facts for the unchanged strict root budget to include
  // every anchor plus the reference needed by the repair response.
  for (let i = 0; i < 100; i++) state.truth.facts[`fixture-fact-${i}`] = { ...structuredClone(state.truth.facts["gate-lock"]!), id: `fixture-fact-${i}` };
  const key = actionCompilationCandidateKeyForHandle(referenceHandleFor("fact", "gate-lock"));
  let rankings = 0;
  const runtime = createActionCompilationRetrievalRuntime({ version: "pinned-test",
    retrieveSlot: async ({ context, slotIndex }) => {
      rankings++;
      return { candidates: (context as Context).referenceCatalog.candidates
        .filter((candidate) => candidate.scope.kind === "shared" || candidate.scope.slot === slotIndex)
        .map((candidate, index) => ({ candidateKey: candidate.candidateKey, score: -index })) };
    },
    selectBatch: ({ mandatoryKeys, candidates }) => [...new Set([...mandatoryKeys, key,
      ...candidates.filter((candidate) => candidate.kind === "local_entity").map((candidate) => candidate.candidateKey)])],
  });
  return { state, key, runtime, rankings: () => rankings,
    scope: { workloadId: "pinned-compiler", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } } };
}

describe("production compiler root candidate selection", () => {
  it("preserves authored profile details when a repair drops another actor's activity", async () => {
    const base = setup(), oldAction = { ...actions[0]!, id: "ongoing-keeper" };
    const plan: TemporalPlan = { id: "ongoing-plan", actionId: oldAction.id, actorId: "keeper",
      profileId: "brief-action", mode: "fixed", description: "Existing keeper activity",
      basis: { kind: "profile", profileId: "brief-action" }, startsAtSeconds: 0,
      completionAtSeconds: 10, checkpointSeconds: 10, progress: null, stages: [], continuationAssertions: [],
      interruptible: true, resourceClaims: [{ resourceId: "foreground", amount: 1 }],
      causes: [{ kind: "action", id: oldAction.id }] };
    base.state.truth.activities["ongoing-keeper"] = createActivity({ id: "ongoing-keeper", plan, sourceAction: oldAction });
    const profileKey = actionCompilationCandidateKeyForHandle(referenceHandleFor("temporal_profile", "brief-action"));
    const provider = new ScriptedModelProvider(({ profileId, context }) => {
      const current = context as Context;
      const profile = current.referenceCatalog.candidates.find(candidate => candidate.candidateKey === profileKey);
      expect(profile).toMatchObject({ details: { kind: "fixed", name: base.state.truth.mechanics.temporalProfiles["brief-action"]!.name } });
      return deterministicActionCompilationBatch(profileId, context, (compilation, slot) => {
        if (provider.requests.length === 1 && slot.slot === 1) compilation.temporalPlan.profileRef = referenceHandleFor("temporal_profile", "missing");
      });
    });
    const before = contentHash(base.state);
    const result = await compileActions(provider, base.state, actions, { ...base.scope, actionCompilationRetrieval: base.runtime }, "truth-engine", 12);
    expect(result.compilations).toHaveLength(2);
    expect(result.metrics.repairCalls).toBe(1);
    expect(provider.requests).toHaveLength(2);
    expect((provider.requests[1]!.context as Context).task.slots).toHaveLength(1);
    expect(contentHash(base.state)).toBe(before);
  });

  it.each([false, true])("limits repair suggestions to the failed action's original shortlist (schema localization: %s)", async (schemaFailure) => {
    const base = setup();
    let suggested: string[] = [];
    const provider = new ScriptedModelProvider(({ profileId, context }) => {
      const current = context as Context;
      if (provider.requests.length === 2) {
        expect(current.task.slots).toHaveLength(schemaFailure ? 2 : 1);
        const slotIndex = current.task.slots.findIndex((slot) => slot.action.rawText === actions[1]!.rawText);
        const issue = ((current.task.slots[slotIndex] as Record<string, unknown>).issues as unknown[])[0] as { code: string; originalValue: string; allowedHandles: string[] };
        expect(issue.code).toBe("reference.disallowed_use");
        expect(issue.originalValue).toBe(actionCompilationCandidateKeyForHandle(referenceHandleFor("agent", "player")));
        suggested = issue.allowedHandles;
        expect(suggested).toContain(base.key);
        const visible = new Set(current.referenceCatalog.candidates.filter((row) => row.scope.kind === "shared" || row.scope.slot === slotIndex).map((row) => row.candidateKey));
        expect(suggested.every((key) => visible.has(key))).toBe(true);
        expect(suggested).not.toContain(issue.originalValue);
      }
      const wire = deterministicActionCompilationBatch(profileId, context) as unknown as ActionCompilationBatchDraft;
      if (provider.requests.length === 1) {
        wire.slots[1]!.interactionDependency.stateDependencies.requiredExistingCandidateKeys.push(actionCompilationCandidateKeyForHandle(referenceHandleFor("agent", "player")));
        if (schemaFailure) (wire.slots[0]!.temporalPlan as unknown as Record<string, unknown>).causes = null;
      }
      return wire;
    });
    const result = await compileActions(provider, base.state, actions, { ...base.scope, actionCompilationRetrieval: base.runtime }, "truth-engine", 12);
    expect(result.compilations).toHaveLength(2);
    expect(result.metrics.repairCalls).toBe(1);
    expect(suggested.length).toBeGreaterThan(0);
    expect(base.rankings()).toBe(2);
  });
  it("keeps original references and private identities when one failed slot is renumbered", async () => {
    const base = setup();
    let root: CandidateSelectionResult | undefined, rootContext: Context | undefined, retrievalCalls = 0;
    const provider = new ScriptedModelProvider(({ profileId, context }) => {
      const current = context as Context;
      if (provider.requests.length === 2) {
        expect(current.task.slots).toHaveLength(1);
        expect(current.task.slots[0]!.action.rawText).toBe(actions[1]!.rawText);
        const original = new Map(rootContext!.referenceCatalog.candidates.map((row) => [row.candidateKey, row]));
        const currentKeys = current.referenceCatalog.candidates.map((row) => row.candidateKey).sort();
        expect(currentKeys).toEqual([...root!.selectedKeysBySlot.get(1)!].sort());
        const privateRows = current.referenceCatalog.candidates.filter((row) => row.scope.kind === "slot");
        expect(privateRows.length).toBeGreaterThan(0);
        for (const row of privateRows) {
          expect(row.scope.slot).toBe(0);
          expect(original.get(row.candidateKey)!.scope.slot).toBe(1);
        }
      }
      return deterministicActionCompilationBatch(profileId, context, (compilation, slot) => {
        if (provider.requests.length === 1 && slot.slot === 1) compilation.temporalPlan.profileRef = referenceHandleFor("temporal_profile", "missing");
        else compilation.interactionDependency.stateDependencies.requiredExistingRefs.push(referenceHandleFor("fact", "gate-lock"));
      });
    });
    const requestSchemas: unknown[] = [];
    const generate = provider.generateStructured.bind(provider);
    provider.generateStructured = (request) => {
      requestSchemas.push(z.toJSONSchema(request.schema));
      return generate(request);
    };
    const before = contentHash(base.state);
    const result = await compileActions(provider, base.state, actions, { ...base.scope, actionCompilationRetrieval: {
      ...base.runtime, retrieveBatch: async (request) => {
        retrievalCalls++;
        if (retrievalCalls > 1) throw new Error("repair must not rerank candidates");
        rootContext = request.fullContext as Context;
        root = await base.runtime.retrieveBatch(request);
        return root;
      },
    } }, "truth-engine", 12);
    expect(result.compilations).toHaveLength(2);
    expect(result.metrics.repairCalls).toBe(1);
    expect(retrievalCalls).toBe(1);
    expect(base.rankings()).toBe(2);
    expect(provider.requests).toHaveLength(2);
    const count = (index: number) => JSON.parse(JSON.stringify(requestSchemas[index])).properties.slots;
    expect(count(0)).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(count(1)).toMatchObject({ minItems: 1, maxItems: 1 });
    expect(contentHash(base.state)).toBe(before);
  });

  it("fails before reuse on changed state identity, source text, or candidate meaning", async () => {
    const base = setup();
    const provider = new ScriptedModelProvider(({ profileId, context }) => deterministicActionCompilationBatch(profileId, context));
    await compileActions(provider, base.state, actions, base.scope, "truth-engine", 12);
    const full = provider.requests[0]!.context as Context;
    const selected = await base.runtime.retrieveBatch({ fullContext: full, slotIndices: [0, 1], worldContentHash: base.state.worldHash });
    const pinned = new PinnedActionCompilationSelection(full, selected);
    const result = pinned.reuse(full);
    expect(result.selectedKeysBySlot).toEqual(selected.selectedKeysBySlot);
    expect(result.diagnostics.cache.queryBatchSize).toBe(0);
    expect(result.diagnostics.rootSelection).toMatchObject({ fullContextHash: selected.fullContextHash, batchBudget: selected.diagnostics.batchBudget });
    const changed = structuredClone(full);
    changed.task.slots[0]!.action.rawText += " then recruit a guard";
    expect(() => pinned.reuse(changed)).toThrow("action mismatch");
    const stateChanged = { ...full, execution: { ...(full.execution as object), revision: 9 } };
    expect(() => pinned.reuse(stateChanged)).toThrow("snapshot changed");
    const candidateChanged = structuredClone(full);
    candidateChanged.referenceCatalog.candidates.find((row) => row.candidateKey === base.key)!.label = "different meaning";
    expect(() => pinned.reuse(candidateChanged)).toThrow("changed original candidate");
    expect(() => pinned.project(candidateChanged)).toThrow("changed original candidate");
    const pruned = structuredClone(full);
    const detailed = pruned.referenceCatalog.candidates.find((row) => row.candidateKey === base.key)! as Record<string, unknown>;
    expect(detailed.details).not.toBeNull();
    detailed.details = null;
    const restored = pinned.reuse(pinned.project(pruned));
    expect(restored.modelContext.referenceCatalog).toEqual(selected.modelContext.referenceCatalog);
  });
});
