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
import { runtimeId } from "../runtime/runtime-id";
import { createEventBeliefs, validateBeliefCreation, type BeliefCreation } from "./belief-creation";

export interface BeliefRevision {
  version: 2; hash: string; agentId: string; baseRevision: number; evidenceIds: string[];
  projectionHash: string; patch: BeliefPatch; evidence: Array<{ batch: DecisionBatch; result: DecisionResult }>;
  creation: BeliefCreation | null; creationEvidence: Array<{ batch: DecisionBatch; result: DecisionResult }>;
}
export interface BeliefDecisionScope extends ProgramDecisionScope { creationProfileId: string }

function prepare(state: Readonly<SimulationState>, agentId: string, evidenceIds: readonly string[], previous: PrivateResourceSnapshot | undefined) {
  const agent = state.agents[agentId]; if (!agent) throw new Error("unknown cognition owner");
  if (new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some(id => !agent.belief.evidence[id])) throw new Error("cognition requires the owner's actual evidence");
  const perspective = projectAgentPerspective(state as SimulationState, agent);
  const resources = privateProgramResources(perspective, previous);
  const instruction = loadPromptAsset("shared/program-belief-revision.md");
  const expansionInstruction = loadPromptAsset("shared/program-belief-expansion.md");
  const claims = Object.values(agent.belief.claims).sort((a, b) => a.id.localeCompare(b.id));
  const makeBatch = (ids: string[], expansion = false): DecisionBatch => {
    const input = JSON.parse(JSON.stringify({ perspective, newEvidenceIds: evidenceIds, claimIds: ids, expansion })) as JsonValue;
    return { version: 1, view: { kind: "agent", agentId, projectionHash: contentHash(input) }, programHash: contentHash({ instruction, expansionInstruction }),
      state: input, dependencies: Object.fromEntries(Object.entries(resources.resources).map(([key, value]) => [key, value.version])),
      questions: { ...Object.fromEntries(ids.map((id, index) => [`q${index}`, { version: contentHash({ instruction, claim: agent.belief.claims[id] }),
        instructions: `${instruction}\nEvaluate the existing claim ${id} using newEvidenceIds.`,
        criteria: { supported: "The new evidence supports this exact claim according to this Agent's understanding.",
          contradicted: "The new evidence supports a contradiction of this exact claim according to this Agent's understanding.",
          unchanged: "The evidence is irrelevant, ambiguous or insufficient; retain the existing belief." },
        sources: evidenceIds.slice() }])),
        ...(expansion ? { expand: { version: contentHash(expansionInstruction), instructions: expansionInstruction,
          criteria: { needed: "New evidence requires a distinct durable belief, commitment, reported claim or hypothesis absent from existing claims.",
            unchanged: "Existing claims and raw evidence are sufficient; no new durable representation is needed.",
            unknown: "There is insufficient evidence to decide whether a new representation is useful." }, sources: evidenceIds.slice() } } : {}) } };
  };
  const batches: DecisionBatch[] = []; let group: string[] = [];
  if (evidenceIds.length) for (const claim of claims) {
    const next = [...group, claim.id];
    if (group.length && !nativeDecisionBounds(makeBatch(next)).fits) { batches.push(makeBatch(group)); group = [claim.id]; } else group = next;
  }
  if (evidenceIds.length) {
    if (group.length && !nativeDecisionBounds(makeBatch(group, true)).fits) { batches.push(makeBatch(group)); group = []; }
    batches.push(makeBatch(group, true));
  }
  return { agent, resources, batches, perspective, projectionHash: contentHash(perspective) };
}

function derivePatch(agent: Readonly<AgentState>, baseRevision: number, evidenceIds: readonly string[],
  evidence: BeliefRevision["evidence"]): BeliefPatch {
  const patch: BeliefPatch = { agentId: agent.id, baseRevision, operations: [] };
  for (const { batch, result } of evidence) {
    validateModelAudit(result.audit, "private belief decision"); validateDecisionResult(batch, result);
    const claimIds = (batch.state as { claimIds: string[] }).claimIds;
    for (const [index, id] of claimIds.entries()) {
      const choice = result.answers[`q${index}`]!.choice;
      if (choice === "unchanged") continue;
      if (choice !== "supported" && choice !== "contradicted") throw new Error("invalid belief decision");
      const prior = agent.belief.claims[id]; if (!prior) throw new Error("unknown belief claim");
      patch.operations.push({ kind: "upsert_claim", claim: { ...prior,
        stance: choice === "supported" ? "believed" : "disbelieved",
        evidenceIds: [...new Set([...prior.evidenceIds, ...evidenceIds])] } });
    }
  }
  return patch;
}

function creationBatches(input: ReturnType<typeof prepare>, creation: BeliefCreation | null): DecisionBatch[] {
  if (creation?.status !== "ready") return [];
  const instruction = loadPromptAsset("shared/program-new-belief-decision.md");
  const makeBatch = (indices: number[]): DecisionBatch => {
    const state = JSON.parse(JSON.stringify({ perspective: input.perspective, proposals: Object.fromEntries(indices.map((index, ordinal) =>
      [`q${ordinal}`, { index, claim: creation.value.claims[index] }])) })) as JsonValue;
    return { version: 1, view: { kind: "agent", agentId: input.agent.id, projectionHash: contentHash(state) },
      state, programHash: contentHash({ instruction, sourceHash: creation.sourceHash }),
      dependencies: Object.fromEntries(Object.entries(input.resources.resources).map(([key, value]) => [key, value.version])),
      questions: Object.fromEntries(indices.map((index, ordinal) => [`q${ordinal}`, {
        version: contentHash({ instruction, claim: creation.value.claims[index] }), instructions: `${instruction}\nEvaluate proposals.q${ordinal}.`,
        criteria: { supported: "The owner's evidence supports this precise new claim.",
          contradicted: "The owner's evidence supports a contradiction of this precise new claim.",
          unknown: "This useful claim remains an uncertain hypothesis or unverified report.",
          discard: "The proposal is redundant, irrelevant or misrepresents what was observed or said." },
        sources: creation.value.claims[index]!.evidenceIds,
      }])) };
  };
  const batches: DecisionBatch[] = []; let group: number[] = [];
  for (const index of creation.value.claims.keys()) {
    const next = [...group, index];
    if (group.length && !nativeDecisionBounds(makeBatch(next)).fits) { batches.push(makeBatch(group)); group = [index]; } else group = next;
  }
  if (group.length) batches.push(makeBatch(group));
  return batches;
}

function deriveCreationPatch(state: Readonly<SimulationState>, input: ReturnType<typeof prepare>, revision: Pick<BeliefRevision,
  "evidenceIds" | "creation" | "creationEvidence" | "evidence">, creationProfileId: string): BeliefPatch["operations"] {
  const needed = revision.evidence.some(proof => proof.result.answers.expand?.choice === "needed");
  if (needed !== Boolean(revision.creation)) throw new Error("belief creation lacks an explicit expansion decision");
  if (revision.creation) validateBeliefCreation(input.agent, input.perspective, revision.evidenceIds, revision.creation, creationProfileId);
  const expected = creationBatches(input, revision.creation);
  if (contentHash(expected) !== contentHash(revision.creationEvidence.map(proof => proof.batch))) throw new Error("new belief judgments used another private input or proposal");
  const operations: BeliefPatch["operations"] = [];
  for (const { batch, result } of revision.creationEvidence) {
    validateModelAudit(result.audit, "new private belief decision"); validateDecisionResult(batch, result);
    const proposals = (batch.state as unknown as { proposals: Record<string, { index: number }> }).proposals;
    for (const [id, proposal] of Object.entries(proposals)) {
      const choice = result.answers[id]!.choice; if (choice === "discard") continue;
      if (!["supported", "contradicted", "unknown"].includes(choice) || revision.creation?.status !== "ready") throw new Error("invalid new belief judgment");
      const draft = revision.creation.value.claims[proposal.index]!;
      operations.push({ kind: "upsert_claim", claim: { ...structuredClone(draft),
        id: runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "claim", stage: "belief-expansion",
          owner: [input.agent.id, revision.creation.sourceHash], round: 0, ordinal: proposal.index }),
        stance: choice === "supported" ? "believed" : choice === "contradicted" ? "disbelieved" : "suspected",
        // A neutral initial epistemic prior; native class probabilities are kept only in the audit.
        confidence: 0.5,
      } });
    }
  }
  return operations;
}

export async function reviseEventBeliefs(runtime: DecisionRuntime, state: Readonly<SimulationState>, agentId: string,
  evidenceIds: string[], previous: PrivateResourceSnapshot | undefined, scope: BeliefDecisionScope) {
  const input = prepare(state, agentId, evidenceIds, previous), calls: DecisionUse[] = [], evidence: BeliefRevision["evidence"] = [];
  for (const batch of input.batches) {
    const call = await runtime.decide({ ...scope, batch, subjectId: agentId, modelInvocation: scope.nextInvocation() });
    calls.push(call); evidence.push({ batch, result: call.result });
  }
  let creation: BeliefCreation | null = null;
  if (evidence.some(proof => proof.result.answers.expand?.choice === "needed")) {
    const invocationBase = scope.nextInvocation(); scope.nextInvocation();
    creation = await createEventBeliefs(runtime.provider, input.agent, input.perspective, evidenceIds,
      { ...scope, profileId: scope.creationProfileId, invocationBase });
  }
  const creationEvidence: BeliefRevision["creationEvidence"] = [];
  for (const batch of creationBatches(input, creation)) {
    const call = await runtime.decide({ ...scope, batch, subjectId: agentId, modelInvocation: scope.nextInvocation() });
    calls.push(call); creationEvidence.push({ batch, result: call.result });
  }
  const patch = derivePatch(input.agent, state.revision, evidenceIds, evidence);
  patch.operations.push(...deriveCreationPatch(state, input, { evidenceIds, evidence, creation, creationEvidence }, scope.creationProfileId));
  const body = { version: 2 as const, agentId, baseRevision: state.revision, evidenceIds, projectionHash: input.projectionHash,
    patch, evidence, creation, creationEvidence };
  return { revision: frozenClone({ ...body, hash: contentHash(body) }), calls, resources: input.resources,
    creationAudits: creation?.audit ? [creation.audit] : [] };
}

/** Verify the exact private input, creation and decisions at the commit boundary without another model call. */
export function applyEventBeliefs(state: Readonly<SimulationState>, revision: BeliefRevision, previous: PrivateResourceSnapshot | undefined,
  creationProfileId: string): AgentState {
  const { hash, ...body } = revision;
  if (revision.version !== 2 || hash !== contentHash(body) || revision.baseRevision !== state.revision) throw new Error("stale or edited belief revision");
  const input = prepare(state, revision.agentId, revision.evidenceIds, previous);
  if (input.projectionHash !== revision.projectionHash || contentHash(input.batches) !== contentHash(revision.evidence.map(entry => entry.batch))) {
    throw new Error("belief revision differs from the owner's current private input");
  }
  const patch = derivePatch(input.agent, state.revision, revision.evidenceIds, revision.evidence);
  patch.operations.push(...deriveCreationPatch(state, input, revision, creationProfileId));
  if (contentHash(patch) !== contentHash(revision.patch)) throw new Error("belief patch differs from its decisions");
  return { ...structuredClone(input.agent), belief: applyBeliefPatch(input.agent.belief, patch) };
}
