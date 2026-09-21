import { describe, expect, it } from "vitest";
import {
  DEFAULT_EAGER_OUTPUT_RECOVERY,
  EagerSlotAttemptError,
  partitionEagerSlots,
  runEagerSlotBatches,
  type EagerSlot,
} from "../eager-slot-batching";
import { ModelConfigurationError, ModelTransportError } from "../../../models/model-provider";
import { createTestModelAudit } from "../../../testing/model-provider";
import { TEST_WORLD_HASH } from "../../../testing/world";

type Slot = EagerSlot<{ value: string }, string>;

function slots(count: number): Slot[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `slot-${index}`,
    payload: { value: `value-${index}` },
    issues: [],
  }));
}

function audit(ordinal: number) {
  return createTestModelAudit("action-compilation", `batch-${ordinal}`, TEST_WORLD_HASH, ordinal);
}

describe("eager slot batching", () => {
  it("drains in-flight batches and suppresses later repairs after a terminal sibling failure", async () => {
    let started!: () => void, release!: () => void;
    const siblingStarted = new Promise<void>(resolve => { started = resolve; });
    const siblingGate = new Promise<void>(resolve => { release = resolve; });
    const failure = new ModelTransportError("stopped dispatch");
    let calls = 0, failureThrown = false, settled = false;
    const pending = runEagerSlotBatches({ slots: slots(4), maxSlots: 2, maxInputBytes: 1000,
      requestBytes: batch => batch.length, label: "drain-test", issuesForError: () => ["invalid"],
      invoke: async batch => {
        calls++;
        if (batch[0]!.key === "slot-0") { await siblingStarted; failureThrown = true; throw failure; }
        started(); await siblingGate;
        return { audit: audit(calls), accepted: [], rejected: batch.map(slot => ({ slot, issues: ["invalid"] })) };
      },
    }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await expect.poll(() => failureThrown).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      release(); expect(await pending).toBe(failure);
      expect(calls).toBe(2);
    } finally { release(); await pending; }
  });

  it.each([1, 2, 3, 12, 64])("honors a max of %i slots and keeps a stable tail batch", (maxSlots) => {
    const batches = partitionEagerSlots({
      slots: slots(65),
      maxSlots,
      maxInputBytes: 10_000,
      requestBytes: (batch) => batch.length,
      label: "test",
    });

    expect(batches.flat().map((slot) => slot.key)).toEqual(slots(65).map((slot) => slot.key));
    expect(batches.every((batch) => batch.length <= maxSlots)).toBe(true);
    expect(batches.at(-1)).toHaveLength(65 % maxSlots || maxSlots);
  });

  it("shrinks batches by request bytes and rejects an oversized singleton", () => {
    expect(partitionEagerSlots({
      slots: slots(5),
      maxSlots: 12,
      maxInputBytes: 31,
      requestBytes: (batch) => 10 + batch.length * 10,
      label: "test",
    }).map((batch) => batch.length)).toEqual([2, 2, 1]);

    expect(() => partitionEagerSlots({
      slots: slots(1),
      maxSlots: 12,
      maxInputBytes: 19,
      requestBytes: (batch) => 10 + batch.length * 10,
      label: "test",
    })).toThrow(ModelConfigurationError);
  });

  it("retains valid slots and repairs only a localized semantic failure", async () => {
    let calls = 0;
    const result = await runEagerSlotBatches({
      slots: slots(3),
      maxSlots: 3,
      maxInputBytes: 10_000,
      requestBytes: (batch) => batch.length,
      label: "test",
      issuesForError: (error) => [String(error)],
      invoke: async (batch) => {
        calls += 1;
        if (calls === 1) {
          return {
            audit: audit(calls),
            accepted: [batch[0]!, batch[2]!].map((slot) => ({ key: slot.key, result: slot.payload.value })),
            rejected: [{ slot: batch[1]!, issues: ["repair this slot"] }],
          };
        }
        expect(batch.map((slot) => slot.key)).toEqual(["slot-1"]);
        expect(batch[0]!.issues).toEqual(["repair this slot"]);
        return {
          audit: audit(calls),
          accepted: [{ key: batch[0]!.key, result: batch[0]!.payload.value }],
          rejected: [],
        };
      },
    });

    expect([...result.results.keys()].sort()).toEqual(["slot-0", "slot-1", "slot-2"]);
    expect(result.audits).toHaveLength(2);
    expect(result.metrics).toMatchObject({
      submittedSlots: 4,
      repairCalls: 1,
      partialFailureSlots: 1,
      splitCount: 0,
      singletonFailures: 0,
    });
  });

  it("repairs structural failures, then recursively bisects the current batch", async () => {
    let calls = 0;
    const result = await runEagerSlotBatches({
      slots: slots(4),
      maxSlots: 4,
      maxInputBytes: 10_000,
      requestBytes: (batch) => batch.length,
      label: "test",
      issuesForError: () => ["invalid structure"],
      invoke: async (batch) => {
        calls += 1;
        if (batch.length > 1) {
          throw new EagerSlotAttemptError("invalid structure", audit(calls));
        }
        return {
          audit: audit(calls),
          accepted: [{ key: batch[0]!.key, result: batch[0]!.payload.value }],
          rejected: [],
        };
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.results).toHaveLength(4);
    expect(result.batchCount).toBe(13);
    expect(result.metrics).toMatchObject({ repairCalls: 6, splitCount: 3, singletonFailures: 0 });
  });

  it("reports singleton exhaustion and propagates terminal errors without splitting", async () => {
    const exhausted = await runEagerSlotBatches({
      slots: slots(1),
      maxSlots: 1,
      maxInputBytes: 10_000,
      requestBytes: (batch) => batch.length,
      label: "test",
      issuesForError: () => ["still invalid"],
      invoke: async (batch, attempt) => ({
        audit: audit(attempt + 1),
        accepted: [],
        rejected: [{ slot: batch[0]!, issues: ["still invalid"] }],
      }),
    });
    expect(exhausted.failures).toHaveLength(1);
    expect(exhausted.batchCount).toBe(3);
    expect(exhausted.metrics.singletonFailures).toBe(1);

    let terminalCalls = 0;
    await expect(runEagerSlotBatches({
      slots: slots(4),
      maxSlots: 4,
      maxInputBytes: 10_000,
      requestBytes: (batch) => batch.length,
      label: "test",
      issuesForError: () => ["transport"],
      invoke: async () => {
        terminalCalls += 1;
        throw new ModelTransportError("offline");
      },
    })).rejects.toBeInstanceOf(ModelTransportError);
    expect(terminalCalls).toBe(1);

    const cancellation = new Error("cancelled");
    cancellation.name = "AbortError";
    await expect(runEagerSlotBatches({
      slots: slots(2),
      maxSlots: 2,
      maxInputBytes: 10_000,
      requestBytes: (batch) => batch.length,
      label: "test",
      issuesForError: () => ["cancelled"],
      invoke: async () => { throw cancellation; },
    })).rejects.toBe(cancellation);
  });

  it("stops an equivalent repair fingerprint before sending a third identical request", async () => {
    let calls = 0;
    const result = await runEagerSlotBatches({
      slots: slots(1),
      maxSlots: 1,
      maxInputBytes: 10_000,
      requestBytes: (batch) => batch.length,
      label: "test",
      recovery: { ...DEFAULT_EAGER_OUTPUT_RECOVERY, maxRepairs: 5 },
      issuesForError: () => ["same deterministic failure"],
      issueFingerprint: (issue) => issue,
      invoke: async (batch, attempt) => {
        calls += 1;
        return {
          audit: audit(attempt + 1),
          accepted: [],
          rejected: [{ slot: batch[0]!, issues: ["same deterministic failure"] }],
        };
      },
    });

    expect(calls).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.metrics).toMatchObject({
      repairCalls: 1,
      repeatedFingerprints: 1,
      singletonFailures: 1,
    });
  });
});
