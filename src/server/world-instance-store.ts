import type { RulePackageRegistry } from "../engine/mechanics/rule-package";
import { validateAlgorithmRef, type PolicyBinding } from "../engine/runtime/execution";
import { EXECUTION_STAGES } from "../engine/runtime/stages";
import { reactionRequestSchema } from "../engine/contracts/llm-schemas";
import { contentHash } from "../engine/models/model-audit";
import type { RuntimeCorrelation } from "../engine/runtime/observability";
import { validateSimulationState } from "../engine/runtime/transaction";
import type { StoredWorldInstance, WorldInstanceDocument } from "./world-instance-types";

export class WorldInstanceNotFoundError extends Error {
  readonly status = 404;
  constructor(id: string) {
    super(`world instance ${id} not found`);
    this.name = "WorldInstanceNotFoundError";
  }
}

export class WorldInstanceConflictError extends Error {
  readonly status = 409;
  constructor(id: string) {
    super(`world instance ${id} changed concurrently`);
    this.name = "WorldInstanceConflictError";
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
}

function validateExperimentEnrollment(document: WorldInstanceDocument): void {
  const enrollment = document.experimentEnrollment;
  if (enrollment === null) return;
  requireText(enrollment.experimentId, "experiment enrollment id");
  requireText(enrollment.experimentVersion, "experiment enrollment version");
  requireText(enrollment.experimentManifestHash, "experiment enrollment manifest hash");
  requireText(enrollment.variantId, "experiment enrollment variant id");
  requireText(enrollment.assignmentHash, "experiment enrollment assignment hash");
  if (!Number.isSafeInteger(enrollment.bucket) || enrollment.bucket < 0 || enrollment.bucket >= 10_000) {
    throw new Error("experiment enrollment bucket must be an integer from 0 to 9999");
  }
  validateAlgorithmRef(enrollment.algorithmRef);
  if (contentHash(enrollment.algorithmRef) !== contentHash(document.executionAlgorithm)) {
    throw new Error("experiment enrollment algorithm does not match the pinned instance algorithm");
  }
  const { assignmentHash, ...body } = enrollment;
  if (contentHash(body) !== assignmentHash) throw new Error("experiment enrollment assignment hash mismatch");
}

function validateExperimentExclusion(document: WorldInstanceDocument): void {
  const exclusion = document.experimentExclusion;
  if (exclusion === null) return;
  if (!["explicit-execution-tuning", "no-active-experiment", "world-ineligible", "experiment-stopped"].includes(exclusion.reason)) {
    throw new Error("experiment exclusion reason is invalid");
  }
  if (exclusion.detail !== null && typeof exclusion.detail !== "string") throw new Error("experiment exclusion detail is invalid");
  if (document.experimentEnrollment) throw new Error("instance cannot have both experiment enrollment and exclusion");
}

function validateExternalAction(
  action: WorldInstanceDocument["runs"][string]["rootIntents"][number],
  label: string,
): void {
  if (!action || typeof action !== "object") throw new Error(`${label} must be an object`);
  requireText(action.submissionId, `${label} submission id`);
  requireText(action.agentId, `${label} agent id`);
  requireText(action.rawText, `${label} text`);
  requireText(action.goal, `${label} goal`);
  if (action.means !== null) requireText(action.means, `${label} means`);
  if (!Array.isArray(action.targetIds) || action.targetIds.some((targetId) => typeof targetId !== "string" || !targetId.trim())) {
    throw new Error(`${label} target ids must be non-empty strings`);
  }
  if (new Set(action.targetIds).size !== action.targetIds.length) {
    throw new Error(`${label} contains duplicate target ids`);
  }
}

function validateBinding(agentId: string, binding: PolicyBinding, document: WorldInstanceDocument): void {
  if (!binding || typeof binding !== "object") throw new Error(`policy binding ${agentId} must be an object`);
  if (binding.agentId !== agentId) throw new Error(`policy binding key mismatch for ${agentId}`);
  if (!(agentId in document.state.agents)) throw new Error(`policy binding references unknown agent ${agentId}`);
  switch (binding.kind) {
    case "model": {
      requireText(binding.profiles.creation, `model policy ${agentId} creation profile`);
      requireText(binding.profiles.decision, `model policy ${agentId} decision profile`);
      requireText(binding.profiles.fallback, `model policy ${agentId} decision fallback profile`);
      if (binding.resumeFromRevision !== undefined &&
        (!Number.isSafeInteger(binding.resumeFromRevision) || binding.resumeFromRevision < 0 ||
          binding.resumeFromRevision > document.state.revision)) {
        throw new Error(`model policy ${agentId} has an invalid resume revision`);
      }
      break;
    }
    case "external": {
      requireText(binding.participantId, `external policy ${agentId} participant id`);
      const participant = document.participants[binding.participantId];
      if (!participant || participant.status !== "active" || participant.agentId !== agentId) {
        throw new Error(`external policy ${agentId} has no active participant`);
      }
      break;
    }
    case "idle":
      if (!["timeout", "released", "explicit"].includes(binding.reason)) {
        throw new Error(`idle policy ${agentId} has an invalid reason`);
      }
      break;
    case "replay":
      requireText(binding.sourceExecutionId, `replay policy ${agentId} source execution id`);
      break;
    default:
      throw new Error(`policy binding ${agentId} has an unknown kind`);
  }
}

function validateParticipant(
  participantId: string,
  participant: WorldInstanceDocument["participants"][string],
  document: WorldInstanceDocument,
): void {
  if (!participant || typeof participant !== "object") throw new Error(`participant ${participantId} must be an object`);
  if (participant.id !== participantId) throw new Error(`participant key mismatch for ${participantId}`);
  requireText(participant.principalId, `participant ${participantId} principal`);
  requireText(participant.displayName, `participant ${participantId} display name`);
  requireText(participant.agentId, `participant ${participantId} agent id`);
  if (!(participant.agentId in document.state.agents)) throw new Error(`participant ${participantId} references unknown agent`);
  if (participant.status !== "active" && participant.status !== "released") {
    throw new Error(`participant ${participantId} has an invalid status`);
  }
  if (!Number.isFinite(Date.parse(participant.joinedAt)) || !Number.isFinite(Date.parse(participant.updatedAt))) {
    throw new Error(`participant ${participantId} timestamps must be ISO dates`);
  }
  if (!Number.isSafeInteger(participant.controlledSinceRevision) || participant.controlledSinceRevision < 0 ||
    participant.controlledSinceRevision > document.state.revision) {
    throw new Error(`participant ${participantId} has an invalid control revision`);
  }
  if (participant.admissionExecutionId !== undefined) {
    requireText(participant.admissionExecutionId, `participant ${participantId} admission execution id`);
  }
  if (participant.suppressedActionId !== undefined) {
    requireText(participant.suppressedActionId, `participant ${participantId} suppressed action id`);
  }
  const arrival = participant.arrival;
  if (!arrival || typeof arrival !== "object") throw new Error(`participant ${participantId} arrival is required`);
  requireText(arrival.id, `participant ${participantId} arrival id`);
  requireText(arrival.title, `participant ${participantId} arrival title`);
  requireText(arrival.scene, `participant ${participantId} arrival scene`);
  if (!Number.isSafeInteger(arrival.revision) || arrival.revision < 0 || arrival.revision > document.state.revision) {
    throw new Error(`participant ${participantId} arrival revision is invalid`);
  }
  if (!Number.isSafeInteger(arrival.step) || arrival.step < 0 || arrival.step > document.state.step) {
    throw new Error(`participant ${participantId} arrival step is invalid`);
  }
  if (!Array.isArray(arrival.possibleNextActions) || arrival.possibleNextActions.length !== 3 ||
    arrival.possibleNextActions.some((suggestion) => typeof suggestion !== "string" || !suggestion.trim())) {
    throw new Error(`participant ${participantId} arrival possibleNextActions are invalid`);
  }
  if (typeof arrival.generated !== "boolean" || !Number.isFinite(Date.parse(arrival.createdAt))) {
    throw new Error(`participant ${participantId} arrival metadata is invalid`);
  }
  if (arrival.executionId !== undefined) {
    requireText(arrival.executionId, `participant ${participantId} arrival execution id`);
  }
}

function validateActionWindow(document: WorldInstanceDocument): void {
  const window = document.actionWindow;
  if (!window) return;
  requireText(window.id, "action window id");
  if (!Number.isSafeInteger(window.baseRevision) || window.baseRevision !== document.state.revision) {
    throw new Error("action window must belong to the current revision");
  }
  if (!Number.isSafeInteger(window.generation) || window.generation < 1) {
    throw new Error("action window generation must be positive");
  }
  if (!["open", "resolving", "committed", "cancelled"].includes(window.status)) {
    throw new Error("action window has an invalid status");
  }
  if (window.deadlineAt !== null && !Number.isFinite(Date.parse(window.deadlineAt))) {
    throw new Error("action window deadline must be an ISO date or null");
  }
  if (new Set(window.requiredAgentIds).size !== window.requiredAgentIds.length) {
    throw new Error("action window contains duplicate required Agents");
  }
  for (const agentId of window.requiredAgentIds) {
    const binding = document.policyBindings[agentId];
    if (binding?.kind !== "external") throw new Error(`action window requires non-external Agent ${agentId}`);
  }
  for (const [agentId, action] of Object.entries(window.submissions)) {
    if (!window.requiredAgentIds.includes(agentId) || action.agentId !== agentId) {
      throw new Error(`invalid action window submission for ${agentId}`);
    }
    if (window.kind === "decision") {
      validateExternalAction(action, `action window submission ${agentId}`);
    } else {
      requireText(action.submissionId, `reaction window submission ${agentId} id`);
      requireText(action.requestId, `reaction window submission ${agentId} request`);
      if (action.requestId !== window.requests[agentId]?.id ||
        action.kind !== "keep" && action.kind !== "replace") {
        throw new Error(`invalid reaction window submission for ${agentId}`);
      }
      if (action.kind === "replace") {
        requireText(action.rawText, `reaction window submission ${agentId} text`);
        requireText(action.goal, `reaction window submission ${agentId} goal`);
        if (action.means !== null) requireText(action.means, `reaction window submission ${agentId} means`);
        if (new Set(action.targetIds).size !== action.targetIds.length) {
          throw new Error(`reaction window submission ${agentId} repeats target ids`);
        }
      }
    }
  }
  if (window.kind === "reaction") {
    requireText(window.preparedStepId, "reaction window prepared step id");
    requireText(window.preparationArtifactHash, "reaction window artifact hash");
    requireText(window.preparationExecutionId, "reaction window execution id");
    requireText(window.sourceStateHash, "reaction window source state hash");
    requireText(window.algorithmManifestHash, "reaction window algorithm manifest hash");
    requireText(window.policyRosterHash, "reaction window policy roster hash");
    if (contentHash(window.policyRoster) !== window.policyRosterHash) {
      throw new Error("reaction window policy roster hash does not match its frozen roster");
    }
    for (const [agentId, binding] of Object.entries(window.policyRoster)) {
      validateBinding(agentId, binding, document);
    }
    if (window.advanceRequest.expectedRevision !== window.baseRevision ||
      !["manual", "batch", "realtime", "participant_action"].includes(window.advanceRequest.trigger)) {
      throw new Error("reaction window advance request does not match its base revision");
    }
    for (const [index, action] of window.advanceRequest.externalActions.entries()) {
      validateExternalAction(action, `reaction window advance request action ${index}`);
    }
    if (contentHash(Object.keys(window.requests).sort()) !== contentHash([...window.requiredAgentIds].sort())) {
      throw new Error("reaction window requests must cover every required Agent");
    }
    for (const [agentId, request] of Object.entries(window.requests)) {
      reactionRequestSchema.parse(request);
      if (request.agentId !== agentId) throw new Error(`reaction window request key mismatch for ${agentId}`);
    }
  }
}

export function validateWorldInstanceDocument(document: WorldInstanceDocument, rulePackages?: RulePackageRegistry): void {
  if (document.schemaVersion !== 24) throw new Error("world instance schema v24 required");
  requireText(document.id, "instance id");
  requireText(document.title, "instance title");
  validateAlgorithmRef(document.executionAlgorithm);
  validateExperimentEnrollment(document);
  validateExperimentExclusion(document);
  if (document.experimentEnrollment === null && document.experimentExclusion === null) {
    throw new Error("world instance must record experiment enrollment or exclusion");
  }
  if (document.title.length > 80) throw new Error("instance title exceeds 80 characters");
  if (!Number.isFinite(Date.parse(document.createdAt)) || !Number.isFinite(Date.parse(document.updatedAt))) {
    throw new Error("instance timestamps must be ISO dates");
  }
  validateSimulationState(document.state, false, true, rulePackages);
  if (document.state.worldId !== document.world.id || document.state.worldHash !== document.world.contentHash) {
    throw new Error("instance state does not match its pinned world");
  }
  const bindingIds = Object.keys(document.policyBindings).sort();
  const agentIds = Object.keys(document.state.agents).sort();
  if (contentHash(bindingIds) !== contentHash(agentIds)) throw new Error("every agent must have exactly one policy binding");
  for (const [agentId, binding] of Object.entries(document.policyBindings)) validateBinding(agentId, binding, document);
  const controlled = new Set<string>();
  for (const [participantId, participant] of Object.entries(document.participants)) {
    validateParticipant(participantId, participant, document);
    if (participant.status === "active" && controlled.has(participant.agentId)) {
      throw new Error(`agent ${participant.agentId} is controlled by multiple participants`);
    }
    if (participant.status === "active") {
      const binding = document.policyBindings[participant.agentId];
      if (binding?.kind !== "external" || binding.participantId !== participantId) {
        throw new Error(`active participant ${participantId} does not own its external policy`);
      }
      controlled.add(participant.agentId);
    }
  }
  validateActionWindow(document);
  if (!Number.isSafeInteger(document.runtime.maxAutonomousSpanSeconds) || document.runtime.maxAutonomousSpanSeconds <= 0 ||
    !Number.isSafeInteger(document.runtime.realtimeIntervalMs) || document.runtime.realtimeIntervalMs <= 0 ||
    !Number.isSafeInteger(document.runtime.actionWindowMs) || document.runtime.actionWindowMs <= 0 ||
    typeof document.runtime.debugSteppingEnabled !== "boolean") {
    throw new Error("runtime configuration is invalid");
  }
  if (document.scheduler.mode !== "paused" && document.scheduler.mode !== "realtime") {
    throw new Error("scheduler mode is invalid");
  }
  if (!Number.isSafeInteger(document.scheduler.generation) || document.scheduler.generation < 1) {
    throw new Error("scheduler generation must be positive");
  }
  if (document.scheduler.nextTickAt !== null && !Number.isFinite(Date.parse(document.scheduler.nextTickAt))) {
    throw new Error("scheduler next tick must be an ISO date or null");
  }
  if (document.scheduler.mode === "paused" && document.scheduler.nextTickAt !== null) {
    throw new Error("paused scheduler cannot have a next tick");
  }
  for (const [runId, run] of Object.entries(document.runs)) {
    if (run.id !== runId) throw new Error(`run key mismatch for ${runId}`);
    if (!["queued", "running", "pausing", "paused", "debug-paused", "awaiting-decision", "awaiting-reaction",
      "preparation-invalidated", "completed", "failed", "budget-paused"]
      .includes(run.status)) throw new Error(`run ${runId} has an invalid status`);
    if (!Number.isSafeInteger(run.generation) || run.generation < 1 ||
      !Number.isFinite(Date.parse(run.createdAt)) || !Number.isFinite(Date.parse(run.updatedAt))) {
      throw new Error(`run ${runId} has invalid generation or timestamps`);
    }
    if (!["manual", "batch", "realtime", "participant_action"].includes(run.trigger)) {
      throw new Error(`run ${runId} has an invalid trigger`);
    }
    if (run.requestedBoundaryCount !== null &&
      (!Number.isSafeInteger(run.requestedBoundaryCount) || run.requestedBoundaryCount < 1 ||
        run.requestedBoundaryCount > 100)) {
      throw new Error(`run ${runId} has an invalid requested boundary count`);
    }
    if (!Array.isArray(run.rootIntents)) throw new Error(`run ${runId} root intents must be an array`);
    const submittedAgents = new Set<string>();
    const submissionIds = new Set<string>();
    for (const action of run.rootIntents) {
      validateExternalAction(action, `run ${runId} root intent`);
      if (!(action.agentId in document.state.agents)) {
        throw new Error(`run ${runId} action references unknown Agent ${action.agentId}`);
      }
      if (submittedAgents.has(action.agentId) || submissionIds.has(action.submissionId)) {
        throw new Error(`run ${runId} contains duplicate root intents`);
      }
      submittedAgents.add(action.agentId);
      submissionIds.add(action.submissionId);
    }
    if (!Array.isArray(run.activityIds) || new Set(run.activityIds).size !== run.activityIds.length ||
      run.activityIds.some((id) => !document.state.truth.activities[id])) {
      throw new Error(`run ${runId} activity ids are invalid`);
    }
    if (!Array.isArray(run.executionIds) || run.executionIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error(`run ${runId} execution ids must be non-empty strings`);
    }
    if (!Array.isArray(run.committedRevisions) || run.committedRevisions.some((revision) =>
      !Number.isSafeInteger(revision) || revision < 0 || revision > document.state.revision)) {
      throw new Error(`run ${runId} committed revisions are invalid`);
    }
    if (run.stopReason !== null) requireText(run.stopReason, `run ${runId} stop reason`);
    if (run.lease) {
      requireText(run.lease.id, `run ${runId} lease id`);
      const suspendedDurationMs = run.lease.suspendedDurationMs ?? 0;
      if (run.lease.generation !== run.generation || !Number.isFinite(Date.parse(run.lease.startedAt)) ||
        !Number.isSafeInteger(run.lease.maxCommits) || run.lease.maxCommits < 1 ||
        !Number.isSafeInteger(run.lease.maxWallTimeMs) || run.lease.maxWallTimeMs < 1 ||
        !Number.isSafeInteger(run.lease.commitCount) || run.lease.commitCount < 0 ||
        run.lease.commitCount > run.lease.maxCommits ||
        !Number.isSafeInteger(suspendedDurationMs) || suspendedDurationMs < 0) {
        throw new Error(`run ${runId} lease is invalid`);
      }
    }
    if (["running", "debug-paused"].includes(run.status) && !run.lease) {
      throw new Error(`active run ${runId} requires a lease`);
    }
    if (run.debugMode !== "off" && run.debugMode !== "step") {
      throw new Error(`run ${runId} has an invalid debug mode`);
    }
    if (run.debugCheckpoint !== null) {
      requireText(run.debugCheckpoint.id, `run ${runId} debug checkpoint id`);
      requireText(run.debugCheckpoint.executionId, `run ${runId} debug checkpoint execution id`);
      requireText(run.debugCheckpoint.artifactHash, `run ${runId} debug checkpoint artifact hash`);
      if (!Number.isSafeInteger(run.debugCheckpoint.boundaryIndex) || run.debugCheckpoint.boundaryIndex < 0 ||
        !Number.isSafeInteger(run.debugCheckpoint.stageIndex) || run.debugCheckpoint.stageIndex < 0 ||
        run.debugCheckpoint.stageIndex >= EXECUTION_STAGES.length ||
        EXECUTION_STAGES[run.debugCheckpoint.stageIndex]?.key !== run.debugCheckpoint.stageKey ||
        !Number.isFinite(Date.parse(run.debugCheckpoint.updatedAt))) {
        throw new Error(`run ${runId} debug checkpoint metadata is invalid`);
      }
    }
    if (run.lastDebugRequestId !== null && typeof run.lastDebugRequestId !== "string") {
      throw new Error(`run ${runId} last debug request id must be null or text`);
    }
    if (run.error !== undefined) requireText(run.error, `run ${runId} error`);
  }
  for (const intent of document.participantIntents) {
    requireText(intent.participantId, "participant intent participant id");
    requireText(intent.agentId, "participant intent agent id");
    requireText(intent.runId, "participant intent run id");
    requireText(intent.submissionId, "participant intent submission id");
    requireText(intent.text, "participant intent text");
    if (!(intent.participantId in document.participants)) {
      throw new Error(`participant intent references unknown participant ${intent.participantId}`);
    }
    if (!(intent.agentId in document.state.agents) || !(intent.runId in document.runs)) {
      throw new Error(`participant intent ${intent.submissionId} references unknown execution state`);
    }
    if (!Number.isSafeInteger(intent.revision) || intent.revision < 0 || intent.revision > document.state.revision) {
      throw new Error(`participant intent ${intent.submissionId} has an invalid revision`);
    }
    if (!Number.isFinite(Date.parse(intent.submittedAt))) {
      throw new Error(`participant intent ${intent.submissionId} timestamp must be an ISO date`);
    }
  }
  const reactionSubmissionIds = new Set<string>();
  for (const reaction of document.reactionSubmissions) {
    requireText(reaction.participantId, "reaction submission participant id");
    requireText(reaction.agentId, "reaction submission agent id");
    requireText(reaction.runId, "reaction submission run id");
    requireText(reaction.preparedStepId, "reaction submission prepared step id");
    requireText(reaction.requestId, "reaction submission request id");
    requireText(reaction.submissionId, "reaction submission id");
    if (reactionSubmissionIds.has(reaction.submissionId)) {
      throw new Error(`duplicate reaction submission ${reaction.submissionId}`);
    }
    reactionSubmissionIds.add(reaction.submissionId);
    if (!(reaction.participantId in document.participants) || !(reaction.agentId in document.state.agents) ||
      !(reaction.runId in document.runs) || !["keep", "replace"].includes(reaction.kind) ||
      (reaction.kind === "replace" && !reaction.text?.trim()) ||
      (reaction.kind === "keep" && reaction.text !== null) ||
      !Number.isFinite(Date.parse(reaction.submittedAt))) {
      throw new Error(`reaction submission ${reaction.submissionId} is invalid`);
    }
  }
}

export function serializeWorldInstanceDocument(document: WorldInstanceDocument, rulePackages?: RulePackageRegistry): string {
  validateWorldInstanceDocument(document, rulePackages);
  return JSON.stringify(document);
}

export function parseWorldInstanceDocument(serialized: string, expectedId: string, rulePackages?: RulePackageRegistry): WorldInstanceDocument {
  const value = JSON.parse(serialized) as WorldInstanceDocument;
  validateWorldInstanceDocument(value, rulePackages);
  if (value.id !== expectedId) throw new Error("world instance id mismatch");
  return value;
}

export interface WorldInstanceStore {
  createInstance(document: WorldInstanceDocument, correlation?: RuntimeCorrelation): StoredWorldInstance;
  readInstance(id: string, correlation?: RuntimeCorrelation): StoredWorldInstance;
  compareAndSwapInstance(
    id: string,
    expectedGeneration: number,
    document: WorldInstanceDocument,
    correlation?: RuntimeCorrelation,
  ): StoredWorldInstance;
  listInstances(correlation?: RuntimeCorrelation): StoredWorldInstance[];
  deleteInstance(id: string, expectedGeneration: number, correlation?: RuntimeCorrelation): void;
}
