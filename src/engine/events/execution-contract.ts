import type { BeliefRevision } from "./cognition";
import type { WorldEventCandidate } from "./kernel";
import type { DecisionEventState } from "./runtime-state";
import type { DecisionUse } from "../programs/decision-runtime";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { ModelExecutionAudit } from "../contracts/model";
import type { PolicyBinding, WorldAdvanceRequest } from "../runtime/execution";

export interface DecisionEventBootstrap {
  version: 1;
  producerHash: string;
  authority: WorldRuntimeContract;
  control: DecisionEventState;
  decisions: DecisionUse[];
  modelAudits: ModelExecutionAudit[];
}

/** The compatibility presentation on a step is derived from this proof by the committer. */
export interface DecisionEventStep {
  version: 1;
  authority: WorldRuntimeContract;
  preparedControl: DecisionEventState;
  event: WorldEventCandidate | null;
  beliefRevisions: BeliefRevision[];
  finalControl: DecisionEventState;
  decisions: DecisionUse[];
  modelAudits: ModelExecutionAudit[];
  policyRoster: Record<string, PolicyBinding>;
  request: WorldAdvanceRequest;
}
