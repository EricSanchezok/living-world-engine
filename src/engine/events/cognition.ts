import type { AgentState, BeliefPatch, SimulationState } from "../contracts/model";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import { applyBeliefPatch } from "../cognition/belief";
import { contentHash } from "../models/model-audit";
import { nativeDecisionBounds, validateDecisionResult, type DecisionBatch, type DecisionResult } from "../models/decision";
import { DecisionRuntime, type DecisionUse, type ProgramDecisionScope } from "../programs/decision-runtime";
import { privateProgramResources, type PrivateResourceSnapshot } from "../programs/private-resources";
import { loadPromptAsset } from "../prompts";
import { frozenClone, type JsonValue } from "../runtime/json";
import { validateModelAudit } from "../runtime/transaction";

export interface BeliefRevision {
  version: 1; hash: string; agentId: string; baseRevision: number; evidenceIds: string[];
  projectionHash: string; patch: BeliefPatch; evidence: Array<{ batch: DecisionBatch; result: DecisionResult }>;
}

function prepare(state: Readonly<SimulationState>, agentId: string, evidenceIds: readonly string[], previous: PrivateResourceSnapshot | undefined) {
  const agent = state.agents[agentId]; if (!agent) throw new Error("unknown cognition owner");
  if (new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some(id => !agent.belief.evidence[id])) throw new Error("cognition requires the owner's actual evidence");
  const perspective = projectAgentPerspective(state as SimulationState, agent);
  const resources = privateProgramResources(perspective, previous);
  const instruction = loadPromptAsset("shared/program-belief-revision.md");
  const claims = Object.values(agent.belief.claims).sort((a, b) => a.id.localeCompare(b.id));
  const makeBatch = (ids: string[]): DecisionBatch => {
    // This projection contains only the owner's knowledge, testimony, character and visible physical facts.
    const input = JSON.parse(JSON.stringify({ perspective, newEvidenceIds: evidenceIds, claimIds: ids })) as JsonValue;
    return { version: 1, view: { kind: "agent", agentId, projectionHash: contentHash(input) }, programHash: contentHash(instruction),
      state: input, dependencies: Object.fromEntries(Object.entries(resources.resources).map(([key, value]) => [key, value.version])),
      questions: Object.fromEntries(ids.map((id, index) => [`q${index}`, { version: contentHash({ instruction, claim: agent.belief.claims[id] }),
        instructions: `${instruction}\nEvaluate the existing claim ${id} using newEvidenceIds.`,
        criteria: { supported: "The new evidence supports this exact claim according to this Agent's understanding.",
          contradicted: "The new evidence supports a contradiction of this exact claim according to this Agent's understanding.",
          unchanged: "The evidence is irrelevant, ambiguous or insufficient; retain the existing belief." },
        sources: evidenceIds.slice() }])) };
  };
  const batches: DecisionBatch[] = []; let group: string[] = [];
  if (evidenceIds.length) for (const claim of claims) {
    const next = [...group, claim.id];
    if (group.length && !nativeDecisionBounds(makeBatch(next)).fits) { batches.push(makeBatch(group)); group = [claim.id]; } else group = next;
  }
  if (group.length) batches.push(makeBatch(group));
  return { agent, resources, batches, projectionHash: contentHash(perspective) };
}

function derivePatch(agent: Readonly<AgentState>, baseRevision: number, evidenceIds: readonly string[],
  evidence: BeliefRevision["evidence"]): BeliefPatch {
  const patch: BeliefPatch = { agentId: agent.id, baseRevision, operations: [] };
  for (const { batch, result } of evidence) {
    validateModelAudit(result.audit, "private belief decision");
    validateDecisionResult(batch, result);
    const claimIds = (batch.state as { claimIds: string[] }).claimIds;
    for (const [index, id] of claimIds.entries()) {
      const choice = result.answers[`q${index}`]!.choice;
      if (choice === "unchanged") continue;
      if (choice !== "supported" && choice !== "contradicted") throw new Error("invalid belief decision");
      const prior = agent.belief.claims[id]; if (!prior) throw new Error("unknown belief claim");
      patch.operations.push({ kind: "upsert_claim", claim: { ...prior,
        stance: choice === "supported" ? "believed" : "disbelieved",
        // Model class probability is diagnostic, not a calibrated epistemic confidence.
        evidenceIds: [...new Set([...prior.evidenceIds, ...evidenceIds])] } });
    }
  }
  return patch;
}

export async function reviseEventBeliefs(runtime: DecisionRuntime, state: Readonly<SimulationState>, agentId: string,
  evidenceIds: string[], previous: PrivateResourceSnapshot | undefined, scope: ProgramDecisionScope): Promise<{ revision: BeliefRevision; calls: DecisionUse[]; resources: PrivateResourceSnapshot }> {
  const input = prepare(state, agentId, evidenceIds, previous), calls: DecisionUse[] = [], evidence: BeliefRevision["evidence"] = [];
  for (const batch of input.batches) {
    const call = await runtime.decide({ ...scope, batch, subjectId: agentId, modelInvocation: scope.nextInvocation() });
    calls.push(call); evidence.push({ batch, result: call.result });
  }
  const body = { version: 1 as const, agentId, baseRevision: state.revision, evidenceIds, projectionHash: input.projectionHash,
    patch: derivePatch(input.agent, state.revision, evidenceIds, evidence), evidence };
  return { revision: frozenClone({ ...body, hash: contentHash(body) }), calls, resources: input.resources };
}

/** Verify private input and exact decisions again at the commit boundary; no model calls during replay. */
export function applyEventBeliefs(state: Readonly<SimulationState>, revision: BeliefRevision, previous?: PrivateResourceSnapshot): AgentState {
  const { hash, ...body } = revision;
  if (hash !== contentHash(body) || revision.baseRevision !== state.revision) throw new Error("stale or edited belief revision");
  const input = prepare(state, revision.agentId, revision.evidenceIds, previous);
  if (input.projectionHash !== revision.projectionHash || contentHash(input.batches) !== contentHash(revision.evidence.map(entry => entry.batch))) {
    throw new Error("belief revision differs from the owner's current private input");
  }
  const patch = derivePatch(input.agent, state.revision, revision.evidenceIds, revision.evidence);
  if (contentHash(patch) !== contentHash(revision.patch)) throw new Error("belief patch differs from its decisions");
  return { ...structuredClone(input.agent), belief: applyBeliefPatch(input.agent.belief, patch) };
}
