import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import { contentHash } from "../../models/model-audit";
import type { ActionOutcome, AgentActionProposal, TransitionProposal } from "../../contracts/model";
import { applyTransitionProposal } from "../../runtime/transaction";
import { runtimeId } from "../../runtime/runtime-id";
import { createActivity, materializeTemporalPlan } from "../../mechanics/temporal";
import { evaluateBehaviorOracle, evaluateCommittedBehaviorOracle, type FrozenBehaviorOracle } from "./behavior-oracle";

function fixture() {
  const source = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { modelCatalog: createTestModelCatalog() }).initialState;
  const action: AgentActionProposal = { id: "known-travel", actorId: "player", baseRevision: source.revision,
    rawText: "Carry the key from me to the keeper.", goal: "The keeper holds the key", means: null, targetIds: [] };
  const outcome: ActionOutcome = { id: runtimeId({ worldHash: source.worldHash, revision: 0, kind: "outcome", stage: "oracle", owner: action.id, round: 0, ordinal: 0 }),
    proposalId: action.id, status: "succeeded", summary: "Done",
    causeRefs: [{ kind: "action", id: action.id }], assertions: [{ kind: "entity_lifecycle", entityId: "player", expected: "active" }], knownAlternatives: [] };
  const oracle: FrozenBehaviorOracle = { id: "transfer-key", worldHash: source.worldHash, sourceStateHash: contentHash(source),
    sourceActionHash: contentHash(action), preconditions: [{ kind: "placement_equals", entityId: "key", placementId: "player" }],
    branches: { succeeded: { assertions: [{ kind: "placement_equals", entityId: "key", placementId: "keeper" }] } } };
  const proposal: TransitionProposal = { baseRevision: source.revision, operations: [{ kind: "advance_time", seconds: 10,
    causes: [{ kind: "law", id: "time-passes" }], assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 0 }] }],
    events: [], outcomes: [outcome], decisionRequests: [], observations: [], mechanicInvocations: [] };
  return { source, action, outcome, oracle, proposal };
}

describe("independent behavior evidence through the real world loader and transaction path", () => {
  it("rejects a schema-valid no-effect success and accepts the actual transfer", () => {
    const f = fixture();
    const inert = applyTransitionProposal(f.source, f.proposal);
    expect(evaluateBehaviorOracle({ ...f, checkpoint: inert }).verdict).toBe("failed");
    f.proposal.operations.unshift({ kind: "place_entity", entityId: "key", placementId: "keeper",
      causes: [{ kind: "action", id: f.action.id }], assertions: [{ kind: "placement_equals", entityId: "key", placementId: "player" }] });
    const moved = applyTransitionProposal(f.source, f.proposal);
    expect(evaluateBehaviorOracle({ ...f, checkpoint: moved }).verdict).toBe("passed");
  });

  it("admits real waiting with no physical delta but rejects an all-brief duration mutant", () => {
    const f = fixture();
    f.action.rawText = "Wait here for 10 minutes.";
    f.oracle.sourceActionHash = contentHash(f.action);
    f.oracle.earliestSuccessAtSeconds = 600;
    f.oracle.branches.succeeded = { assertions: [{ kind: "placement_equals", entityId: "player", placementId: "courtyard" }] };
    expect(evaluateBehaviorOracle({ ...f, checkpoint: applyTransitionProposal(f.source, f.proposal) }).verdict).toBe("failed");
    const time = f.proposal.operations[0]!;
    if (time.kind !== "advance_time") throw new Error("fixture time operation missing");
    time.seconds = 600;
    expect(evaluateBehaviorOracle({ ...f, checkpoint: applyTransitionProposal(f.source, f.proposal) }).verdict).toBe("passed");
  });

  it("requires live original work for continuing outcomes and refuses indefinite deadline evasion", () => {
    const f = fixture();f.outcome.status = "continuing";
    f.oracle.branches.continuing = { assertions: [], requireLiveSourceActivity: true };
    const checkpoint = applyTransitionProposal(f.source, f.proposal);
    expect(evaluateBehaviorOracle({ ...f, checkpoint }).verdict).toBe("failed");
    const profile = Object.values(f.source.truth.mechanics.temporalProfiles).find((p) => p.kind === "ongoing")!;
    const plan = materializeTemporalPlan({ id: "plan", actionId: f.action.id, actorId: f.action.actorId, rawText: f.action.rawText,
      startsAtSeconds: 0, profiles: f.source.truth.mechanics.temporalProfiles,
      draft: { profileId: profile.id, basis: { kind: "profile" }, description: "Continue", continuationAssertions: [], causes: [{ kind: "action", id: f.action.id }] } });
    checkpoint.truth.activities.work = createActivity({ id: "work", plan, sourceAction: f.action });
    expect(evaluateBehaviorOracle({ ...f, checkpoint }).verdict).toBe("passed");
    f.oracle.mustSucceedBySeconds = 10;
    expect(evaluateBehaviorOracle({ ...f, checkpoint }).verdict).toBe("failed");
  });

  it("fails closed on evidence mismatch and keeps missing outcomes unknown", () => {
    const f = fixture(), checkpoint = applyTransitionProposal(f.source, f.proposal);
    expect(evaluateBehaviorOracle({ ...f, checkpoint, outcome: null }).verdict).toBe("unknown");
    expect(() => evaluateBehaviorOracle({ ...f, checkpoint, action: { ...f.action, rawText: "Other task" } })).toThrow("binding mismatch");
    const changed = structuredClone(f.source);changed.truth.elapsedSeconds = 1;
    expect(() => evaluateBehaviorOracle({ ...f, source: changed, checkpoint })).toThrow("binding mismatch");
    expect(() => evaluateCommittedBehaviorOracle({ ...f, checkpoint })).toThrow("lacks its committed step");
  });

  it("accepts independently supported blocked and already-satisfied outcomes without demanding writes", () => {
    const f = fixture();
    f.action.rawText = "Open the gate using this key.";f.action.goal = "Open gate";
    f.oracle.sourceActionHash = contentHash(f.action);
    f.oracle.preconditions.push({ kind: "fact_matches", factId: "key-authenticity", expected: { kind: "text", value: "fake" } });
    f.outcome.status = "blocked";
    f.oracle.branches.blocked = { assertions: [{ kind: "fact_matches", factId: "key-authenticity", expected: { kind: "text", value: "fake" } }] };
    expect(evaluateBehaviorOracle({ ...f, checkpoint: applyTransitionProposal(f.source, f.proposal) }).verdict).toBe("passed");
    f.action.rawText = "Keep holding my key.";f.action.goal = "Keep key";
    f.oracle.sourceActionHash = contentHash(f.action);
    f.outcome.status = "succeeded";
    f.oracle.branches.succeeded = { assertions: [{ kind: "placement_equals", entityId: "key", placementId: "player" }] };
    expect(evaluateBehaviorOracle({ ...f, checkpoint: applyTransitionProposal(f.source, f.proposal) }).verdict).toBe("passed");
  });
});
