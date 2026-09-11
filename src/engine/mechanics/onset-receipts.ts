import { z } from "zod";
import {
  onsetPerceptionReportSchema,
  persistedObservationSchema,
  type OnsetPerceptionReportDraft,
} from "../contracts/llm-schemas";
import type { AgentActionProposal, D20CheckRequest, D20CheckResult, SimulationState } from "../contracts/model";
import { projectPerceptionTargets, type PerceptionTarget } from "../contracts/perception-references";
import { createTruthReferenceResolver } from "../contracts/prompts";
import { contentHash } from "../models/model-audit";
import type { WorldDefinition } from "../runtime/world-definition";
import { materializePrivateStimuli } from "../cognition/observation-materialization";
import { validateObservations } from "../cognition/observation";
import { repeatedPerceptionChecks } from "./perception-commitments";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const receiptShape = {
  contentHash: digestSchema,
  sourceStateHash: digestSchema,
  sourceActionHash: digestSchema,
  targetIndex: z.number().int().nonnegative(),
  observerId: z.string().min(1),
  sourceActionId: z.string().min(1),
  reason: z.string().trim().min(1),
  evidence: z.array(z.strictObject({ kind: z.enum(["entity", "fact", "law"]), id: z.string().min(1) })).min(1),
  checkIds: z.array(z.string().min(1)),
};

export const onsetPerceptionReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...receiptShape, kind: z.literal("no_stimulus") }),
  z.strictObject({ ...receiptShape, kind: z.literal("perceived"), stimulus: persistedObservationSchema }),
]);
export type OnsetPerceptionReceipt = z.infer<typeof onsetPerceptionReceiptSchema>;

export interface OnsetReceiptInput {
  definition: WorldDefinition;
  state: SimulationState;
  actions: readonly AgentActionProposal[];
  targets: readonly PerceptionTarget[];
  requests: readonly D20CheckRequest[];
  checks: readonly D20CheckResult[];
}

/** Mechanical provenance validation does not certify the model's perception semantics. */
export function validateOnsetPerceptionReceipts(
  input: OnsetReceiptInput,
  values: readonly OnsetPerceptionReceipt[],
): void {
  if (repeatedPerceptionChecks([], input.requests).length) throw new Error("onset transcript repeats a perception check");
  const receipts = z.array(onsetPerceptionReceiptSchema).parse(values);
  const resolver = createTruthReferenceResolver({ ...input, checkRequests: input.requests, observerIds: input.targets.map(target => target.observerId) });
  projectPerceptionTargets(input.targets, input.state, input.actions, resolver);
  if (receipts.length !== input.targets.length) throw new Error("onset receipts must cover every assigned target exactly once");
  const sourceHash = contentHash(input.state);
  const actions = new Map(input.actions.map(action => [action.id, action]));
  const requests = new Map(input.requests.map(request => [request.id, request]));
  const checks = new Map(input.checks.map(check => [check.requestId, check]));
  const lawIds = new Set(input.definition.laws.map(law => law.id));
  const seen = new Set<number>();
  for (const receipt of receipts) {
    const target = input.targets[receipt.targetIndex];
    if (!target || seen.has(receipt.targetIndex) || target.observerId !== receipt.observerId ||
      target.sourceActionId !== receipt.sourceActionId) {
      throw new Error("onset receipt does not match a unique assigned target");
    }
    seen.add(receipt.targetIndex);
    const { contentHash: digest, ...body } = receipt;
    if (digest !== contentHash(body) || receipt.sourceStateHash !== sourceHash ||
      receipt.sourceActionHash !== contentHash(actions.get(receipt.sourceActionId))) {
      throw new Error("onset receipt content or source binding changed");
    }
    const evidenceIds = new Set<string>();
    for (const evidence of receipt.evidence) {
      const key = `${evidence.kind}:${evidence.id}`;
      const exists = evidence.kind === "entity" ? input.state.truth.entities[evidence.id]
        : evidence.kind === "fact" ? input.state.truth.facts[evidence.id] : lawIds.has(evidence.id);
      if (!exists || evidenceIds.has(key)) throw new Error("onset receipt cites unknown or repeated world evidence");
      evidenceIds.add(key);
    }
    if (new Set(receipt.checkIds).size !== receipt.checkIds.length) throw new Error("onset receipt repeats a check dependency");
    for (const id of receipt.checkIds) {
      const request = requests.get(id), result = checks.get(id);
      if (!request || !result || request.phase !== "perception" ||
        request.actorId !== input.state.agents[receipt.observerId]!.entityId ||
        !request.causes.some(cause => cause.kind === "action" && cause.id === receipt.sourceActionId) ||
        !request.causes.some(cause => cause.kind === "fact" || cause.kind === "law")) {
        throw new Error("onset receipt check dependency has no matching observer, source action and world basis");
      }
      if (receipt.kind === "perceived" && !result.succeeded) throw new Error("perceived onset depends on a failed check");
    }
    if (receipt.kind === "perceived") {
      const hasCommittedUncertainty = input.requests.some(request => request.phase === "perception" &&
        request.actorId === input.state.agents[receipt.observerId]!.entityId &&
        request.causes.some(cause => cause.kind === "action" && cause.id === receipt.sourceActionId));
      if (hasCommittedUncertainty && receipt.checkIds.length === 0) {
        throw new Error("perceived onset cannot bypass its committed perception checks");
      }
      if (receipt.stimulus.observerId !== receipt.observerId || receipt.stimulus.kind !== "stimulus" ||
        receipt.stimulus.sourceEventIds.length !== 0) throw new Error("onset receipt has invalid private stimulus provenance");
      validateObservations(input.state, [receipt.stimulus]);
    }
  }
  validateObservations(input.state, receipts.flatMap(receipt => receipt.kind === "perceived" ? [receipt.stimulus] : []));
}

/** Freeze one adjudicated local view per scheduled pair, without committing cognition or RNG. */
export function materializeOnsetPerceptionReceipts(
  input: OnsetReceiptInput,
  values: readonly OnsetPerceptionReportDraft[],
): OnsetPerceptionReceipt[] {
  const reports = z.array(onsetPerceptionReportSchema).parse(values);
  const resolver = createTruthReferenceResolver({ ...input, checkRequests: input.requests, observerIds: input.targets.map(target => target.observerId) });
  projectPerceptionTargets(input.targets, input.state, input.actions, resolver);
  const indices = new Set(reports.map(report => report.targetIndex));
  if (reports.length !== input.targets.length || indices.size !== reports.length ||
    reports.some(report => !input.targets[report.targetIndex])) {
    throw new Error("onset reports must cover every assigned target exactly once");
  }
  const ordered = [...reports].sort((a, b) => a.targetIndex - b.targetIndex);
  const perceived = ordered.filter(report => report.kind === "perceived");
  if (perceived.some(report => report.stimulus.sourceEventRefs.length !== 0)) {
    throw new Error("onset stimulus cannot cite events before action resolution");
  }
  const packets = materializePrivateStimuli(input.state, perceived.map(report => ({
    observerId: input.targets[report.targetIndex]!.observerId,
    stimulus: report.stimulus,
  })), resolver);
  const packetByTarget = new Map(perceived.map((report, index) => [report.targetIndex, packets[index]!]));
  const sourceStateHash = contentHash(input.state);
  const actions = new Map(input.actions.map(action => [action.id, action]));
  const receipts = ordered.map((report): OnsetPerceptionReceipt => {
    const target = input.targets[report.targetIndex]!;
    const common = {
      sourceStateHash,
      sourceActionHash: contentHash(actions.get(target.sourceActionId)),
      targetIndex: report.targetIndex,
      observerId: target.observerId,
      sourceActionId: target.sourceActionId,
      reason: report.reason,
      evidence: report.evidence.map(evidence => {
        if (typeof evidence.ref !== "string") throw new Error("onset evidence must select an existing reference");
        const resolved = resolver.resolve(evidence.ref, "assertion");
        if (resolved.kind !== evidence.kind) throw new Error("onset evidence reference kind mismatch");
        return { kind: evidence.kind, id: resolved.engineId };
      }),
      checkIds: report.checkRefs.map(ref => {
        if (typeof ref !== "string") throw new Error("onset check must select an existing reference");
        const resolved = resolver.resolve(ref, "assertion");
        if (resolved.kind !== "check") throw new Error("onset check reference kind mismatch");
        return resolved.engineId;
      }),
    };
    const body = report.kind === "perceived"
      ? { ...common, kind: "perceived" as const, stimulus: packetByTarget.get(report.targetIndex)! }
      : { ...common, kind: "no_stimulus" as const };
    return { ...body, contentHash: contentHash(body) };
  });
  validateOnsetPerceptionReceipts(input, receipts);
  return receipts;
}
