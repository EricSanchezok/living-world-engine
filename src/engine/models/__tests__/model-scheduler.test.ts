import { describe, expect, it } from "vitest";
import { FairModelScheduler, ModelOverloadedError } from "../model-scheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("FairModelScheduler", () => {
  it("dispatches queued foreground work before background memory without interrupting an active call", async () => {
    const scheduler = new FairModelScheduler({ globalConcurrency: 1, maxQueuedRequests: 10,
      queueTimeoutMs: 10000, providerConcurrency: { provider: 1 } });
    const gate = deferred<void>(), started: string[] = [];
    const active = scheduler.schedule({ providerId: "provider", workloadId: "active", priority: "background",
      execute: async () => { started.push("active"); await gate.promise; } });
    const submit = (label: string, priority: "foreground" | "background") => scheduler.schedule({
      providerId: "provider", workloadId: "same-instance", priority, execute: async () => { started.push(label); },
    });
    const queued = [submit("memory", "background"), submit("action", "foreground"), submit("reply", "foreground")];
    expect(started).toEqual(["active"]);
    gate.resolve(); await Promise.all([active, ...queued]);
    expect(started).toEqual(["active", "action", "reply", "memory"]);
  });
  it("keeps a burst of 48 requests at or below the configured global limit of 16", async () => {
    const scheduler = new FairModelScheduler({
      globalConcurrency: 16,
      maxQueuedRequests: 1024,
      queueTimeoutMs: 10_000,
      providerConcurrency: { provider: 32 },
    });
    const release = deferred<void>();
    const capacityReached = deferred<void>();
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 48 }, (_, index) => scheduler.schedule({
      providerId: "provider",
      workloadId: `session-${index % 6}`,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (active === 16) capacityReached.resolve();
        await release.promise;
        active -= 1;
        return index;
      },
    }));

    await capacityReached.promise;
    expect(scheduler.activeCount).toBe(16);
    expect(scheduler.queuedCount).toBe(32);
    expect(peak).toBe(16);
    release.resolve();
    await Promise.all(jobs);
    expect(peak).toBe(16);
  });

  it("enforces global and provider concurrency while rotating fairly between sessions", async () => {
    const scheduler = new FairModelScheduler({
      globalConcurrency: 2,
      maxQueuedRequests: 20,
      queueTimeoutMs: 10_000,
      providerConcurrency: { a: 1, b: 2 },
    });
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const thirdStarted = deferred<void>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const submit = (providerId: string, workloadId: string, label: string, index: number) => scheduler.schedule({
      providerId,
      workloadId,
      execute: async () => {
        started.push(label);
        if (started.length === 3) thirdStarted.resolve();
        active += 1;
        peak = Math.max(peak, active);
        await gates[index].promise;
        active -= 1;
        return label;
      },
    });

    const jobs = [
      submit("a", "session-a", "a1", 0),
      submit("a", "session-a", "a2", 1),
      submit("b", "session-b", "b1", 2),
      submit("b", "session-b", "b2", 3),
      submit("b", "session-c", "c1", 4),
    ];
    await Promise.resolve();
    expect(started).toEqual(["a1", "b1"]);
    expect(peak).toBe(2);

    gates[2].resolve();
    await thirdStarted.promise;
    expect(started[2]).toBe("c1");

    gates[0].resolve();
    gates[4].resolve();
    await Promise.resolve();
    await Promise.resolve();
    gates[1].resolve();
    gates[3].resolve();
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(2);
    expect(started.indexOf("a2")).toBeGreaterThan(started.indexOf("a1"));
  });

  it("preserves FIFO within each lane and round-robins across lanes", async () => {
    const scheduler = new FairModelScheduler({
      globalConcurrency: 1,
      maxQueuedRequests: 10,
      queueTimeoutMs: 10_000,
      providerConcurrency: { provider: 1 },
    });
    const started: string[] = [];
    const submit = (workloadId: string, label: string) => scheduler.schedule({
      providerId: "provider",
      workloadId,
      execute: async () => { started.push(label); },
    });

    await Promise.all([
      submit("session-a", "a1"),
      submit("session-a", "a2"),
      submit("session-b", "b1"),
      submit("session-b", "b2"),
      submit("session-c", "c1"),
    ]);

    expect(started).toEqual(["a1", "b1", "c1", "a2", "b2"]);
  });

  it("rejects overflow, queue timeout and cancellation without running discarded work", async () => {
    const scheduler = new FairModelScheduler({
      globalConcurrency: 1,
      maxQueuedRequests: 1,
      queueTimeoutMs: 20,
      providerConcurrency: { provider: 1 },
    });
    const gate = deferred<void>();
    const active = scheduler.schedule({
      providerId: "provider",
      workloadId: "active",
      execute: async () => { await gate.promise; },
    });
    const timedOut = scheduler.schedule({
      providerId: "provider",
      workloadId: "waiting",
      execute: async () => undefined,
    });
    await expect(scheduler.schedule({
      providerId: "provider",
      workloadId: "overflow",
      execute: async () => undefined,
    })).rejects.toBeInstanceOf(ModelOverloadedError);
    await expect(timedOut).rejects.toThrow("queue wait timeout");

    const controller = new AbortController();
    const cancelled = scheduler.schedule({
      providerId: "provider",
      workloadId: "cancelled",
      abortSignal: controller.signal,
      execute: async () => { throw new Error("must not run"); },
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await active;
  });
});
