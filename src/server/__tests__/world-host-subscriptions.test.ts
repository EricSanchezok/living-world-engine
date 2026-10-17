import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { contentHash } from "../../engine/models/model-audit";
import { directTestProvider, nativeAnswer } from "../../engine/testing/direct-provider";
import { defineEngineOperationManifest } from "../../engine/runtime/execution";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import { summarizeRuntimeEvent } from "../world-inspector";
import { materializeRuntimeEvent } from "../../engine/runtime/observability";
import type { WorldInspectorRuntimeEventSummary } from "../../shared/world-inspector-api";

const manifest = defineEngineOperationManifest({ id: "subscription-test", version: "1", config: {} });

describe("WorldHost event subscriptions", () => {
  it("projects a full Inspector event without copying its discarded payload", () => {
    const event = materializeRuntimeEvent({ event: "model.context.normalized", correlation: { instanceId: "original" },
      payload: { fullContext: ["retained for explicit queries"] } }, 1, new Date(), "full");
    const originalClone = globalThis.structuredClone;
    let copiedPayload = false;
    const spy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      if (value && typeof value === "object" && "payload" in value) copiedPayload = true;
      return originalClone(value, options);
    });
    try {
      const summary = summarizeRuntimeEvent(event);
      expect(copiedPayload).toBe(false);
      expect(summary).toMatchObject({ event: event.event, sequence: 1, hasPayload: true });
      expect(summary).not.toHaveProperty("payload");
      summary.correlation!.instanceId = "changed";
      expect(event.correlation!.instanceId).toBe("original");
      expect(event.payload).toEqual({ fullContext: ["retained for explicit queries"] });
    } finally { spy.mockRestore(); }
  });

  it("isolates six live instance streams without cloning unused full event payloads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-host-subscriptions-"));
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const fixture = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q, "none")])));
    await fixture.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: fixture.catalog });
    const unsubscribe: Array<() => void> = [];
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: fixture.gateway });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push((await host.createInstance({ worldId: world.id, start: { kind: "observer" } })).summary.id);
      const truths = ids.map(id => contentHash(database.readInstance(id).document.state));
      const summaries = ids.map(() => [] as WorldInspectorRuntimeEventSummary[]), changes = ids.map(() => 0);
      for (const [index, id] of ids.entries()) {
        unsubscribe.push(host.subscribeInspectorEvents(id, event => summaries[index]!.push(event)));
        unsubscribe.push(host.subscribeInstanceChanges(id, () => changes[index]++));
      }
      const payload = { retained: world.initialState, detail: "full diagnostic content" };
      const originalClone = globalThis.structuredClone;
      let fullEventClones = 0, instanceClones = 0;
      const spy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
        const item = value as Record<string, unknown> | null;
        if (item?.schemaVersion === 4 && item?.event && item.payload !== undefined) fullEventClones++;
        if (item?.world && item?.state && item?.participants) instanceClones++;
        return originalClone(value, options);
      });
      try {
        for (const [index, id] of ids.entries()) {
          const trace = database.beginExecution({ id: `stream-${index}`, kind: "diagnostic", instanceId: id, manifest,
            worldHash: world.contentHash, codeRevision: "test", codeDirty: false, modelCatalogHash: fixture.catalog.hash, seed: 1, runtimeConfig: {} });
          trace.emit({ event: "stream.payload", correlation: { instanceId: id }, payload });
          trace.emit({ event: "stream.marker", correlation: { instanceId: id } });
          trace.flush();
        }
      } finally { spy.mockRestore(); }
      expect(instanceClones).toBe(0);
      expect(fullEventClones).toBe(0);
      expect(changes).toEqual([2, 2, 2, 2, 2, 2]);
      for (const [index, id] of ids.entries()) {
        expect(summaries[index]!.map(event => [event.event, event.hasPayload])).toEqual([["stream.payload", true], ["stream.marker", false]]);
        expect(summaries[index]!.every(event => event.correlation?.instanceId === id && !("payload" in event))).toBe(true);
        expect(summaries[index]![0]!.sequence).toBeLessThan(summaries[index]![1]!.sequence);
        expect(database.executionEvents(`stream-${index}`)[0]!.payload).toEqual(payload);
        expect(contentHash(database.readInstance(id).document.state)).toBe(truths[index]);
      }
      unsubscribe.forEach(stop => stop());
      database.appendExecutionEvent("stream-0", { event: "after-unsubscribe", correlation: { instanceId: ids[0] } });
      expect(changes).toEqual([2, 2, 2, 2, 2, 2]);
    } finally { unsubscribe.forEach(stop => stop()); database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
