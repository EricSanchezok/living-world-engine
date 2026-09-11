import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { ScriptedModelProvider } from "../../testing/model-provider";
import { buildTruthContext } from "../prompts";
import { resolutionMeansSources, withResolutionFactEvidence, RESOLUTION_FACT_EVIDENCE, RESOLUTION_FACT_EVIDENCE_NOTICE } from "../resolution-source-inventory";
import { contentHash } from "../../models/model-audit";
import type { AgentActionProposal } from "../model";
import type { InteractionDependency } from "../../runtime/execution";
import { referenceHandleFor, type ModelReferenceCandidate } from "../model-context";

describe("resolution means inventory", () => {
  it("copies the selected visible record without conflating population and price", () => {
    const records = {
      "ref:fact:population": { predicate: "population", subjectRef: "ref:entity:hold", value: { kind: "number", value: 342 }, description: "Resident population", access: { kind: "public" } },
      "ref:fact:price": { predicate: "offer", subjectRef: "ref:entity:lord", value: { kind: "text", value: "200 gold per unit" }, description: "Offer terms", access: { kind: "public" } },
    };
    const sources = ["population", "price", "population"].map(id => ({ kind: "fact", ref: `ref:fact:${id}` }));
    const before = contentHash({ records, sources }), result = withResolutionFactEvidence(sources, records);
    expect(result.map(r => r.factEvidence!.record)).toEqual([records["ref:fact:population"], records["ref:fact:price"], records["ref:fact:population"]]);
    expect(result[0]!.factEvidence!.recordHash).toBe(contentHash(records["ref:fact:population"]));
    expect(result[0]!.factEvidence!.sourcePath).toEqual(["state", "canonicalTruth", "facts", "ref:fact:population"]);
    (result[0]!.factEvidence!.record as Record<string, unknown>).description = "changed";
    const changed = structuredClone(records); changed["ref:fact:population"].value.value = 343;
    expect(withResolutionFactEvidence(sources, changed)[0]!.factEvidence!.recordHash).not.toBe(result[0]!.factEvidence!.recordHash);
    expect(contentHash({ records, sources })).toBe(before);
    for (const facts of [{}, { "ref:fact:population": null }, { "ref:fact:population": [] }]) {
      expect(() => withResolutionFactEvidence(sources, facts)).toThrow("missing visible record");
    }
    expect(withResolutionFactEvidence([{ kind: "action", ref: "ref:action:own" }], {})).toEqual([{ kind: "action", ref: "ref:action:own" }]);
  });
  it("copies only typed eligible handles, including explicit fallback without expanding action scope", () => {
    const kinds = ["action", "law", "entity", "fact", "condition", "rating", "placement", "meter", "agent"] as const;
    const candidates: ModelReferenceCandidate[] = kinds.flatMap(kind => ["one", "two"].map(id => ({
      handle: referenceHandleFor(kind, id), kind, label: id, meaning: id, allowedUses: ["source"], visibility: "public",
    })));
    candidates.push({ ...candidates[2]!, handle: referenceHandleFor("law", "unusable"), allowedUses: ["cause"] });
    const grounding = { requiredExistingRefs: ["ref:fact:one", "ref:rating:two"],
      potentiallyAffectedExistingRefs: ["ref:entity:one"], globalFallback: false };
    const result = resolutionMeansSources({ candidates }, "ref:action:one", grounding);
    expect(result.map(s => s.ref).sort()).toEqual([
      "ref:action:one", "ref:entity:one", "ref:fact:one", "ref:law:one", "ref:law:two", "ref:rating:two",
    ]);
    const fallback = resolutionMeansSources({ candidates }, "ref:action:one", { ...grounding, globalFallback: true });
    expect(fallback).toHaveLength(13);
    expect(fallback).not.toContainEqual({ kind: "action", ref: "ref:action:two" });
    expect(fallback.some(s => s.kind === "meter" || s.kind === "agent")).toBe(false);
  });

  it("preserves the complete real context and binds repair inventory to its unchanged grounding", () => {
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: new ScriptedModelProvider(() => ({})).catalog });
    const state = definition.initialState;
    const agents = Object.values(state.agents);
    const actions: AgentActionProposal[] = agents.slice(0, 2).map((agent, index) => ({
      id: `inventory-${index}`, actorId: agent.id, baseRevision: state.revision,
      rawText: "Observe the courtyard", goal: "Know who is present", means: null, targetIds: [],
    }));
    const groundings: InteractionDependency[] = actions.map((action, index) => ({
      kind: "action", id: action.id, actorId: action.actorId,
      reads: [{ kind: "entity", id: agents[index]!.entityId }], writes: [],
      audienceAgentIds: [agents[1 - index]!.id], sharedResourceClaims: [], globalFallback: false,
    }));
    const input: Parameters<typeof buildTruthContext>[0] = {
      definition, state, workset: { state, mode: "full", initialActions: actions, availableActions: actions,
        assignedActions: actions, availableDependencies: groundings, assignedDependencies: groundings },
      reactionRequests: [], reactionDecisions: [], reactionWindow: "closed", committedCheckRequests: [],
      checkResults: [], committedRandomRequests: [], randomResults: [], commitmentRounds: [],
      resolutionPlans: [], resolutionReceipts: [], temporalBoundary: { fromElapsedSeconds: state.truth.elapsedSeconds,
        toElapsedSeconds: state.truth.elapsedSeconds + 1, deltaSeconds: 1, reasons: [{ kind: "safety_horizon" }],
        dueActivityIds: [], dueTimerIds: [], dueConditionIds: [] },
      instanceId: "inventory-instance", advanceId: "inventory-step", issues: [], stage: "resolution",
    };
    type Context = { state: { actionSet: { assigned: { actionRef: string; allowedMeansSources?: { kind: string; ref: string }[] }[] } } };
    const baseline = buildTruthContext(input);
    const candidate = buildTruthContext({ ...input, includeResolutionMeansSources: true }) as Context;
    const original = structuredClone(candidate);
    candidate.state.actionSet.assigned.forEach(action => { delete action.allowedMeansSources; });
    expect(candidate).toEqual(baseline);
    expect(original.state.actionSet.assigned[0]!.allowedMeansSources).toContainEqual({ kind: "entity", ref: `ref:entity:${agents[0]!.entityId}` });
    expect(original.state.actionSet.assigned[0]!.allowedMeansSources).not.toContainEqual({ kind: "entity", ref: `ref:entity:${agents[1]!.entityId}` });
    const repair = buildTruthContext({ ...input, includeResolutionMeansSources: true,
      workset: { ...input.workset, assignedActions: [actions[1]!], assignedDependencies: [groundings[1]!] },
      resolutionScope: { mode: "repair", selectedActionIds: [actions[1]!.id], totalActionCount: actions.length },
    }) as Context;
    expect(repair.state.actionSet.assigned).toEqual([original.state.actionSet.assigned[1]]);
    expect(() => buildTruthContext({ ...input, includeResolutionMeansSources: true,
      workset: { ...input.workset, assignedDependencies: [] } })).toThrow("requires grounding");
    expect(buildTruthContext({ ...input, stage: "transition", includeResolutionMeansSources: true }))
      .toEqual(buildTruthContext({ ...input, stage: "transition" }));

    const factInput = { ...input, includeResolutionMeansSources: true, workset: { ...input.workset,
      assignedDependencies: groundings.map(g => ({ ...g, globalFallback: true })) } };
    type EvidenceContext = { task: { constraints: string[]; planFactEvidence?: { contract: string; factSnapshotHash: string } }; state: {
      canonicalTruth: { facts: Record<string, unknown> }; actionSet: { assigned: Array<{ allowedMeansSources: Array<{
        kind: string; ref: string; factEvidence?: { record: unknown; recordHash: string };
      }> }> };
    } };
    const annotated = buildTruthContext({ ...factInput, includeResolutionFactEvidence: true }) as EvidenceContext;
    expect(annotated.task.planFactEvidence).toEqual({ contract: RESOLUTION_FACT_EVIDENCE,
      factSnapshotHash: contentHash(annotated.state.canonicalTruth.facts) });
    const facts = annotated.state.actionSet.assigned.flatMap(a => a.allowedMeansSources).filter(s => s.kind === "fact");
    expect(facts.length).toBeGreaterThan(0);
    for (const source of facts) {
      expect(source.factEvidence!.record).toEqual(annotated.state.canonicalTruth.facts[source.ref]);
      expect(source.factEvidence!.recordHash).toBe(contentHash(annotated.state.canonicalTruth.facts[source.ref]));
    }
    const repairEvidence = buildTruthContext({ ...factInput, includeResolutionFactEvidence: true,
      workset: { ...factInput.workset, assignedActions: [actions[1]!] },
      resolutionScope: { mode: "repair", selectedActionIds: [actions[1]!.id], totalActionCount: actions.length },
    }) as EvidenceContext;
    expect(repairEvidence.state.actionSet.assigned).toEqual([annotated.state.actionSet.assigned[1]]);
    const inverse = structuredClone(annotated);
    inverse.state.actionSet.assigned.forEach(a => a.allowedMeansSources.forEach(s => { delete s.factEvidence; }));
    delete inverse.task.planFactEvidence;
    inverse.task.constraints = inverse.task.constraints.filter(c => c !== RESOLUTION_FACT_EVIDENCE_NOTICE);
    expect(inverse).toEqual(buildTruthContext(factInput));
    expect(() => buildTruthContext({ ...input, includeResolutionFactEvidence: true })).toThrow("requires source inventory");
    expect(buildTruthContext({ ...input, stage: "transition", includeResolutionFactEvidence: true }))
      .toEqual(buildTruthContext({ ...input, stage: "transition" }));
  });
});
