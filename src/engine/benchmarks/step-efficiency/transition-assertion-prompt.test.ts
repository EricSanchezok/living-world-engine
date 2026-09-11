import { expect, it } from "vitest";
import type { TransitionProposal } from "../../contracts/model";
import { evaluateProposalCausality } from "../../mechanics/causality";
import { contentHash } from "../../models/model-audit";
import { runConditionalCompletionScenario } from "./conditional-scenario";
import { transitionAssertionPrompt } from "./transition-assertion-prompt";

it("aligns actual transition instructions with sequential preconditions and final witnesses", async () => {
  const { source } = await runConditionalCompletionScenario("arrived", async (request, fallback) => {
    expect(request.system).toContain("immediately before that operation");
    expect(request.system).toContain("against the original input state");
    expect(request.system).toContain("final time advance");
    expect(request.userPrompt).not.toContain("use the current elapsed time");
    expect(request.system).not.toContain("condition that is true before the write");
    // The frozen benchmark transformation cannot silently compare identical arms
    // after the corrected contract becomes the shipped request.
    expect(() => transitionAssertionPrompt(request.userPrompt, request.system)).toThrow("drift");
    return fallback();
  });
  const causes = [{ kind: "action" as const, id: "controlled-action" }];
  const at = (placementId: string) => ({ kind: "placement_equals" as const, entityId: "player", placementId });
  const clock = (value: number) => ({ kind: "elapsed_seconds_compare" as const, operator: "eq" as const, value });
  const proposal: TransitionProposal = {
    baseRevision: source.revision, observations: [], decisionRequests: [],
    operations: [
      { kind: "place_entity", entityId: "player", placementId: "gate", causes, assertions: [at("courtyard"), clock(0)] },
      { kind: "place_entity", entityId: "player", placementId: "courtyard", causes, assertions: [at("gate")] },
      { kind: "advance_time", seconds: 60, causes, assertions: [clock(0)] },
    ],
    mechanicInvocations: [{ id: "invocation", packageId: "controlled", ruleId: "controlled", input: {}, causes, assertions: [at("courtyard"), clock(0)] }],
    events: [{ id: "event", step: 1, description: "Returned after travel", impact: "ordinary", causes, assertions: [at("courtyard"), clock(60)] }],
    outcomes: [{ id: "outcome", proposalId: "controlled-action", status: "succeeded", summary: "Returned", causeRefs: causes, assertions: [at("courtyard"), clock(60)], knownAlternatives: [] }],
  };
  const before = contentHash(source);
  const staleClock = structuredClone(proposal);
  staleClock.outcomes[0]!.assertions = [{ kind: "elapsed_seconds_compare", operator: "lt", value: 60 }];
  expect(() => evaluateProposalCausality(source, [], [], staleClock)).toThrow("causal assertions failed: outcome:");
  expect(evaluateProposalCausality(source, [], [], proposal).every((entry) => entry.passed)).toBe(true);
  expect(contentHash(source)).toBe(before);
  for (const target of ["operation", "mechanic", "event", "outcome"] as const) {
    const mutant = structuredClone(proposal);
    if (target === "operation") mutant.operations[0]!.assertions = [at("gate")];
    if (target === "mechanic") mutant.mechanicInvocations[0]!.assertions = [clock(60)];
    if (target === "event") mutant.events[0]!.assertions = [clock(0)];
    if (target === "outcome") mutant.outcomes[0]!.assertions = [clock(0)];
    expect(() => evaluateProposalCausality(source, [], [], mutant)).toThrow(`causal assertions failed: ${target}:`);
  }
});
