import type { BeliefRevision } from "./cognition";
import type { WorldEventCandidate } from "./kernel";
import type { DecisionEventState } from "./runtime-state";
import type { PendingProgramAttempt } from "./runtime-state";
import type { DecisionUse } from "../programs/decision-runtime";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { ModelExecutionAudit } from "../contracts/model";
import type { PolicyBinding, WorldAdvanceRequest } from "../runtime/execution";

export interface DecisionEventBootstrap {
  version: 3;
  producerHash: string;
  modelCatalog: import("../models/model-catalog").ModelCatalogDocument;
  authority: WorldRuntimeContract;
  control: DecisionEventState;
  activityAdmissionInput: PendingProgramAttempt[];
  decisions: DecisionUse[];
  modelAudits: ModelExecutionAudit[];
}

/** The compatibility presentation on a step is derived from this proof by the committer. */
export interface DecisionEventStep {
  version: 1;
  authority: WorldRuntimeContract;
  preparedControl: DecisionEventState;
  activityAdmissionInput: PendingProgramAttempt[];
  event: WorldEventCandidate | null;
  beliefRevisions: BeliefRevision[];
  finalControl: DecisionEventState;
  decisions: DecisionUse[];
  modelAudits: ModelExecutionAudit[];
  policyRoster: Record<string, PolicyBinding>;
  request: WorldAdvanceRequest;
}
