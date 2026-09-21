import { z } from "zod";
import type { ModelExecutionAudit } from "../../contracts/model";
import type { AlgorithmBatchMetrics, OutputRecoveryCapability } from "../roles";
import { contentHash } from "../../models/model-audit";
import {
  ModelConfigurationError,
  ModelOutputError,
  ModelTransportError,
} from "../../models/model-provider";
import { ModelOverloadedError } from "../../models/model-scheduler";
import { structuredPromptBytes } from "../../prompts";

export interface EagerSlot<TPayload, TIssue> {
  key: string;
  payload: TPayload;
  issues: TIssue[];
}

export interface EagerSlotAttemptResult<TResult, TPayload, TIssue> {
  audit: ModelExecutionAudit;
  accepted: Array<{ key: string; result: TResult }>;
  rejected: Array<{ slot: EagerSlot<TPayload, TIssue>; issues: TIssue[] }>;
}

export interface EagerSlotBatchFailure<TPayload, TIssue> {
  slot: EagerSlot<TPayload, TIssue>;
  error: unknown;
  audit?: ModelExecutionAudit;
}

export interface EagerSlotBatchResult<TResult, TPayload, TIssue> {
  results: Map<string, TResult>;
  audits: ModelExecutionAudit[];
  failures: Array<EagerSlotBatchFailure<TPayload, TIssue>>;
  batchCount: number;
  metrics: AlgorithmBatchMetrics;
}

export interface EagerSlotAttemptLineage {
  logicalInvocationId: string;
  semanticRepairAttempt: number;
  parentInvocationId?: string;
  repairOf?: string;
}

export const DEFAULT_EAGER_OUTPUT_RECOVERY: Readonly<OutputRecoveryCapability> = Object.freeze({
  maxRepairs: 2,
  exhaustion: "fail-step" as const,
  splitAt: (slotCount: number) => Math.ceil(slotCount / 2),
});

export class EagerSlotAttemptError extends Error {
  constructor(
    message: string,
    readonly audit: ModelExecutionAudit | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EagerSlotAttemptError";
  }
}

export function eagerRequestBytes(
  system: string,
  userPrompt: string,
  context: unknown,
  schema: z.ZodType,
): number {
  return structuredPromptBytes({ system, userPrompt, context, schema }).requestUtf8Bytes;
}

export function partitionEagerSlots<TPayload, TIssue>(input: {
  slots: readonly EagerSlot<TPayload, TIssue>[];
  maxSlots: number;
  maxInputBytes: number;
  requestBytes(slots: readonly EagerSlot<TPayload, TIssue>[]): number;
  label: string;
}): Array<Array<EagerSlot<TPayload, TIssue>>> {
  const batches: Array<Array<EagerSlot<TPayload, TIssue>>> = [];
  let current: Array<EagerSlot<TPayload, TIssue>> = [];
  for (const slot of input.slots) {
    const proposed = [...current, slot];
    if (proposed.length <= input.maxSlots && input.requestBytes(proposed) <= input.maxInputBytes) {
      current = proposed;
      continue;
    }
    if (current.length === 0) {
      throw new ModelConfigurationError(
        `${input.label} slot ${slot.key} exceeds profile max_input_bytes ${input.maxInputBytes}`,
      );
    }
    batches.push(current);
    current = [slot];
    if (input.requestBytes(current) > input.maxInputBytes) {
      throw new ModelConfigurationError(
        `${input.label} slot ${slot.key} exceeds profile max_input_bytes ${input.maxInputBytes}`,
      );
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function splitEagerSlots<TPayload, TIssue>(
  slots: readonly EagerSlot<TPayload, TIssue>[],
  splitAt = Math.ceil(slots.length / 2),
): [Array<EagerSlot<TPayload, TIssue>>, Array<EagerSlot<TPayload, TIssue>>] {
  if (!Number.isSafeInteger(splitAt) || splitAt < 1 || splitAt >= slots.length) {
    throw new RangeError(`eager slot recovery split must be inside a ${slots.length}-slot batch`);
  }
  return [slots.slice(0, splitAt), slots.slice(splitAt)];
}

export function eagerSlotBatchOwner<TPayload, TIssue>(
  role: string,
  slots: readonly EagerSlot<TPayload, TIssue>[],
): string {
  return `${role}-slots-${contentHash(slots.map((slot) => slot.key)).slice("sha256:".length, 23)}`;
}

export function isTerminalEagerModelError(error: unknown): boolean {
  return error instanceof ModelConfigurationError || error instanceof ModelTransportError ||
    error instanceof ModelOverloadedError ||
    (error instanceof Error && error.name === "AbortError");
}

function errorAudit(error: unknown): ModelExecutionAudit | undefined {
  if (error instanceof EagerSlotAttemptError) return error.audit;
  if (error instanceof ModelOutputError) return error.audit;
  return undefined;
}

function mergeBatchResults<TResult, TPayload, TIssue>(
  entries: readonly EagerSlotBatchResult<TResult, TPayload, TIssue>[],
): EagerSlotBatchResult<TResult, TPayload, TIssue> {
  return {
    results: new Map(entries.flatMap((entry) => [...entry.results.entries()])),
    audits: entries.flatMap((entry) => entry.audits),
    failures: entries.flatMap((entry) => entry.failures),
    batchCount: entries.reduce((total, entry) => total + entry.batchCount, 0),
    metrics: {
      submittedSlots: entries.reduce((total, entry) => total + entry.metrics.submittedSlots, 0),
      repairCalls: entries.reduce((total, entry) => total + entry.metrics.repairCalls, 0),
      repeatedFingerprints: entries.reduce((total, entry) => total + entry.metrics.repeatedFingerprints, 0),
      splitCount: entries.reduce((total, entry) => total + entry.metrics.splitCount, 0),
      partialFailureSlots: entries.reduce((total, entry) => total + entry.metrics.partialFailureSlots, 0),
      singletonFailures: entries.reduce((total, entry) => total + entry.metrics.singletonFailures, 0),
    },
  };
}

/** Preserve the first failure, but retain ownership until every started branch
 * has finished emitting its execution evidence. */
export async function settleEagerWork<T>(work: readonly Promise<T>[]): Promise<T[]> {
  return Promise.all(work).finally(async () => { await Promise.allSettled(work); });
}

export async function runEagerSlotBatches<TPayload, TIssue, TResult>(input: {
  slots: readonly EagerSlot<TPayload, TIssue>[];
  maxSlots: number;
  maxInputBytes: number;
  requestBytes(slots: readonly EagerSlot<TPayload, TIssue>[]): number;
  invoke(
    slots: readonly EagerSlot<TPayload, TIssue>[],
    attempt: number,
    lineage: EagerSlotAttemptLineage,
  ): Promise<EagerSlotAttemptResult<TResult, TPayload, TIssue>>;
  issuesForError(error: unknown, slot: EagerSlot<TPayload, TIssue>): TIssue[];
  issueFingerprint?: (issue: TIssue) => string;
  label: string;
  recovery?: Readonly<OutputRecoveryCapability>;
}): Promise<EagerSlotBatchResult<TResult, TPayload, TIssue>> {
  const recovery = input.recovery ?? DEFAULT_EAGER_OUTPUT_RECOVERY;
  const maxRepairs = recovery.maxRepairs;
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0) {
    throw new RangeError("eager slot batch maxRepairs must be a non-negative integer");
  }
  if (recovery.exhaustion !== "fail-step" || typeof recovery.splitAt !== "function") {
    throw new Error("eager slot batch requires a fail-step output recovery capability");
  }
  type Lineage = { logicalInvocationId: string; baseAttempt: number; parentInvocationId?: string };
  let terminalFailure: { error: unknown } | undefined;
  const checkTerminalFailure = () => { if (terminalFailure) throw terminalFailure.error; };
  const recover = (sourceSlots: readonly EagerSlot<TPayload, TIssue>[], lineageState: Lineage) =>
    recoverBatch(sourceSlots, lineageState).catch(error => {
      terminalFailure ??= { error };
      throw terminalFailure.error;
    });
  const recoverBatch = async (
    sourceSlots: readonly EagerSlot<TPayload, TIssue>[],
    lineageState: Lineage,
  ): Promise<EagerSlotBatchResult<TResult, TPayload, TIssue>> => {
    checkTerminalFailure();
    const fitted = partitionEagerSlots({
      slots: sourceSlots,
      maxSlots: input.maxSlots,
      maxInputBytes: input.maxInputBytes,
      requestBytes: input.requestBytes,
      label: input.label,
    });
    if (fitted.length > 1) return mergeBatchResults(await settleEagerWork(fitted.map((batch) => recover(batch, lineageState))));

    let pending = fitted[0] ?? [];
    const results = new Map<string, TResult>();
    const audits: ModelExecutionAudit[] = [];
    let batchCount = 0;
    const metrics: AlgorithmBatchMetrics = {
      submittedSlots: 0,
      repairCalls: 0,
      repeatedFingerprints: 0,
      splitCount: 0,
      partialFailureSlots: 0,
      singletonFailures: 0,
    };
    let lastAudit: ModelExecutionAudit | undefined;
    let previousInvocationId = lineageState.parentInvocationId;
    let previousSemanticAttempt = lineageState.baseAttempt;
    let lastError: unknown = new Error(`${input.label} failed without a model attempt`);
    const seenFailureFingerprints = new Set<string>();
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      checkTerminalFailure();
      if (pending.length === 0) break;
      const semanticRepairAttempt = lineageState.baseAttempt + attempt;
      const repairedFit = partitionEagerSlots({
        slots: pending,
        maxSlots: input.maxSlots,
        maxInputBytes: input.maxInputBytes,
        requestBytes: input.requestBytes,
        label: input.label,
      });
      if (repairedFit.length > 1) {
        const recovered = mergeBatchResults(await settleEagerWork(repairedFit.map((batch) => recover(batch, {
          logicalInvocationId: lineageState.logicalInvocationId,
          // The current attempt already produced the last audit. A split
          // therefore starts with the next semantic repair number; otherwise
          // the child calls would be incorrectly projected as root attempts.
          baseAttempt: previousSemanticAttempt + 1,
          ...(previousInvocationId ? { parentInvocationId: previousInvocationId } : {}),
        }))));
        recovered.results.forEach((value, key) => results.set(key, value));
        return {
          results,
          audits: [...audits, ...recovered.audits],
          failures: recovered.failures,
          batchCount: batchCount + recovered.batchCount,
          metrics: {
            submittedSlots: metrics.submittedSlots + recovered.metrics.submittedSlots,
            repairCalls: metrics.repairCalls + recovered.metrics.repairCalls,
            repeatedFingerprints: metrics.repeatedFingerprints + recovered.metrics.repeatedFingerprints,
            splitCount: metrics.splitCount + recovered.metrics.splitCount + 1,
            partialFailureSlots: metrics.partialFailureSlots + recovered.metrics.partialFailureSlots,
            singletonFailures: metrics.singletonFailures + recovered.metrics.singletonFailures,
          },
        };
      }
      pending = repairedFit[0] ?? [];
      try {
        batchCount += 1;
        metrics.submittedSlots += pending.length;
        if (attempt > 0) metrics.repairCalls += 1;
        const attempted = await input.invoke(pending, attempt, {
          logicalInvocationId: lineageState.logicalInvocationId,
          semanticRepairAttempt,
          ...(previousInvocationId ? { parentInvocationId: previousInvocationId, repairOf: previousInvocationId } : {}),
        });
        audits.push(attempted.audit);
        lastAudit = attempted.audit;
        previousInvocationId = attempted.audit.invocations.at(-1)?.id ?? previousInvocationId;
        previousSemanticAttempt = semanticRepairAttempt;
        attempted.accepted.forEach((entry) => results.set(entry.key, entry.result));
        if (attempted.accepted.length > 0 && attempted.rejected.length > 0) {
          metrics.partialFailureSlots += attempted.rejected.length;
        }
        pending = attempted.rejected.map((entry) => ({
          ...entry.slot,
          issues: [...entry.issues],
        }));
        lastError = pending.length > 0
          ? new Error(`${input.label} rejected ${pending.length} slot(s): ${JSON.stringify(
              attempted.rejected.map((entry) => ({ key: entry.slot.key, issues: entry.issues })),
            )}`)
          : lastError;
      } catch (error) {
        if (isTerminalEagerModelError(error)) throw error;
        lastError = error;
        const audit = errorAudit(error);
        if (audit) {
          audits.push(audit);
          lastAudit = audit;
          previousInvocationId = audit.invocations.at(-1)?.id ?? previousInvocationId;
        }
        previousSemanticAttempt = semanticRepairAttempt;
        pending = pending.map((slot) => ({
          ...slot,
          issues: input.issuesForError(error, slot),
        }));
      }
      if (pending.length > 0 && input.issueFingerprint) {
        const issueFingerprint = input.issueFingerprint;
        const fingerprint = contentHash(pending.map((slot) => ({
          key: slot.key,
          issues: slot.issues.map(issueFingerprint),
        })));
        if (seenFailureFingerprints.has(fingerprint)) {
          metrics.repeatedFingerprints += pending.length;
          break;
        }
        seenFailureFingerprints.add(fingerprint);
      }
    }

    if (pending.length === 0) return { results, audits, failures: [], batchCount, metrics };
    if (pending.length === 1) {
      metrics.singletonFailures += 1;
      return {
        results,
        audits,
        failures: [{ slot: pending[0]!, error: lastError, audit: lastAudit }],
        batchCount,
        metrics,
      };
    }
    const recovered = mergeBatchResults(await settleEagerWork(splitEagerSlots(
      pending,
      recovery.splitAt(pending.length),
    ).map((batch) => recover(batch, {
      logicalInvocationId: lineageState.logicalInvocationId,
      baseAttempt: previousSemanticAttempt + 1,
      ...(previousInvocationId ? { parentInvocationId: previousInvocationId } : {}),
    }))));
    recovered.results.forEach((value, key) => results.set(key, value));
    return {
      results,
      audits: [...audits, ...recovered.audits],
      failures: recovered.failures,
      batchCount: batchCount + recovered.batchCount,
      metrics: {
        submittedSlots: metrics.submittedSlots + recovered.metrics.submittedSlots,
        repairCalls: metrics.repairCalls + recovered.metrics.repairCalls,
        repeatedFingerprints: metrics.repeatedFingerprints + recovered.metrics.repeatedFingerprints,
        splitCount: metrics.splitCount + recovered.metrics.splitCount + 1,
        partialFailureSlots: metrics.partialFailureSlots + recovered.metrics.partialFailureSlots,
        singletonFailures: metrics.singletonFailures + recovered.metrics.singletonFailures,
      },
    };
  };

  const initial = partitionEagerSlots({
    slots: input.slots,
    maxSlots: input.maxSlots,
    maxInputBytes: input.maxInputBytes,
    requestBytes: input.requestBytes,
    label: input.label,
  });
  return mergeBatchResults(await settleEagerWork(initial.map((batch) => recover(batch, {
    logicalInvocationId: `${input.label}:${contentHash(batch.map((slot) => slot.key))}`,
    baseAttempt: 0,
  }))));
}
