import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { contentHash } from "../../../models/model-audit";
import { SimulationEngine } from "../../../runtime/simulation";
import { CanonicalCommitter } from "../../../runtime/canonical-committer";
import type { WorldExecutionAlgorithm, WorldStepCandidate } from "../../../runtime/execution";
import { deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, ScriptedModelProvider } from "../../../testing/model-provider";
import { EagerReferenceAlgorithm } from "../eager-reference";

type ReviewContext = {
  state: {
    candidate: { observations: Array<{ observationRef: string; observerRef: string; summary: string }>;
      outcomes: Array<{ outcomeRef: string; summary: string }> };
    candidateTemporalExecution: { sourceHash: string };
    actionSet: { assigned: Array<{ actorRef: string }> };
  };
};

async function fixture(mode: "accept" | "observation" | "outcome" | "terminal") {
  let reviews = 0;
  const provider = new ScriptedModelProvider(({ role, profileId, context, schemaName }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context,
      (compilation, { action }) => {
        compilation.interactionDependency = deterministicInteractionDependency({ reads: [],
          writes: [{ kind: "entity", id: action.actorId }], audienceAgentIds: [action.actorId], sharedResourceClaims: [] });
      });
    if (schemaName === "causal_verification") {
      reviews += 1;
      const candidate = (context as ReviewContext).state.candidate;
      if (mode === "terminal" || mode !== "accept" && reviews === 1) {
        const kind = mode === "outcome" ? "outcome" : "observation";
        return { verdict: "reject", findings: [{
          target: { kind, targetHandle: kind === "outcome" ? candidate.outcomes[0]!.outcomeRef : candidate.observations[0]!.observationRef },
          evidenceHandles: [], code: kind === "outcome" ? "effect-mismatch" : "observation-mismatch",
          message: "Controlled unsupported completion claim.", repairHint: "Describe only the actual interval evidence.",
        }] };
      }
      return { verdict: "accept", findings: [] };
    }
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    return deterministicModelOutput(profileId, context);
  }, undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const delegate = new EagerReferenceAlgorithm(provider);
  let candidate: WorldStepCandidate | undefined;
  const algorithm: WorldExecutionAlgorithm = {
    manifest: delegate.manifest,
    bootstrap: (input, context) => delegate.bootstrap(input, context),
    prepareStep: (input, context) => delegate.prepareStep(input, context),
    completeStep: async (input, preparation, reactions, context) => {
      candidate = await delegate.completeStep(input, preparation, reactions, context);
      return candidate;
    },
  };
  const engine = new SimulationEngine(definition, algorithm);
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const roster = Object.fromEntries(Object.keys(source.agents).map(agentId => [agentId,
    { kind: "external" as const, agentId, participantId: `test-${agentId}` }]));
  const run = () => engine.step(roster, { expectedRevision: source.revision, trigger: "participant_action",
    externalActions: Object.keys(source.agents).map(agentId => ({ submissionId: `action-${agentId}`, agentId,
      rawText: "Remain here and look around.", goal: "Observe my surroundings", means: null, targetIds: [] })) });
  return { provider, definition, engine, source, roster, run, candidate: () => candidate };
}

it.each(["accept", "observation", "outcome"] as const)("reviews the exact final merged content and retains preparation on %s", async mode => {
  const test = await fixture(mode);
  const result = await test.run();
  const candidate = test.candidate()!;
  expect(new Set(candidate.resolution.proposal.outcomes.map(outcome => outcome.id)).size).toBe(2);
  const requests = test.provider.requests;
  const reviews = requests.filter(request => request.schemaName === "causal_verification");
  expect(reviews).toHaveLength(mode === "accept" ? 1 : 2);
  const last = reviews.at(-1)!.context as ReviewContext;
  expect(last.state.actionSet.assigned).toHaveLength(2);
  expect(last.state.candidate.observations.map(packet => packet.summary)).toEqual(candidate.resolution.proposal.observations.map(packet => packet.summary));
  expect(last.state.candidateTemporalExecution.sourceHash).toBe(contentHash(candidate.temporalState));
  expect(result.committed.observations).toEqual(candidate.resolution.proposal.observations);
  const observations = requests.filter(request => request.role === "observation-renderer");
  expect(observations).toHaveLength(mode === "accept" ? 1 : 2);
  const transitions = requests.filter(request => request.role === "truth-transition");
  expect(transitions).toHaveLength(mode === "outcome" ? 3 : 2);
  expect(requests.filter(request => request.role === "truth-resolution")).toHaveLength(4);
  if (mode === "outcome") expect(JSON.stringify(transitions.at(-1)!.context)).toContain("Rejected expanded candidate target");
  if (mode === "observation") {
    expect(JSON.stringify(observations.at(-1)!.context)).toContain("Controlled unsupported completion claim.");
    const first = (reviews[0]!.context as ReviewContext).state.candidate.observations;
    expect(last.state.candidate.observations[1]).toEqual(first[1]);
  }
  for (const mutate of [
    (changed: WorldStepCandidate) => { changed.resolution.proposal.observations[0]!.summary = "Unreviewed completion claim"; },
    (changed: WorldStepCandidate) => { changed.resolution.proposal.outcomes[0]!.summary = "Unreviewed outcome"; },
    (changed: WorldStepCandidate) => { changed.finalCausalReview.invocationIds = ["another-review"]; },
    (changed: WorldStepCandidate) => { changed.resolution.causalVerification = { verdict: "reject", findings: [] }; },
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed);
    expect(() => new CanonicalCommitter().step(test.source, changed, test.roster,
      test.definition.runtimeDefaults.maxAutonomousSpanSeconds)).toThrow("final causal review");
  }
});

it("exhausts targeted final-observer repair without committing or rerunning preparation", async () => {
  const test = await fixture("terminal");
  const sourceHash = contentHash(test.source);
  await expect(test.run()).rejects.toThrow("causal verifier rejected final transition");
  expect(contentHash(test.engine.snapshot)).toBe(sourceHash);
  expect(test.candidate()).toBeUndefined();
  expect(test.provider.requests.filter(request => request.schemaName === "causal_verification")).toHaveLength(3);
  expect(test.provider.requests.filter(request => request.role === "truth-transition")).toHaveLength(2);
  expect(test.provider.requests.filter(request => request.role === "truth-resolution")).toHaveLength(4);
});
