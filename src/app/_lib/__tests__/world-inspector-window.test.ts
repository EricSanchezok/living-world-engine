import { describe, expect, it } from "vitest";
import type { WorldInspectorWindow } from "../../../shared/world-inspector-api";
import { DEFAULT_ALGORITHM_REF } from "../../../engine/algorithms/registry";
import { mergeWorldInspectorWindows } from "../world-inspector-window";

function inspectorWindow(
  revisions: number[],
  input: { hasOlder: boolean; worldHash?: string },
): WorldInspectorWindow {
  const oldestRevision = revisions[0];
  const newestRevision = revisions.at(-1);
  return {
    apiVersion: 13,
    algorithmComposition: {
      root: DEFAULT_ALGORITHM_REF,
      nodeCount: 1,
    },
    instance: {
      id: "instance-1",
      title: "存档",
      worldId: "world-1",
      worldName: "世界",
      worldHash: input.worldHash ?? "hash-1",
      revision: newestRevision ?? 0,
      step: newestRevision ?? 0,
      elapsedSeconds: newestRevision ?? 0,
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
    actors: [],
    steps: revisions.map((revision) => ({
      revision,
      step: revision,
      contentHash: `hash-${revision}`,
      elapsedSeconds: revision,
      primaryAction: `action-${revision}`,
      actorIds: [],
      counts: {
        actions: 0,
        reactions: 0,
        checks: 0,
        random: 0,
        mechanics: 0,
        operations: 0,
        events: 0,
        observations: 0,
        mindUpdates: 0,
        modelInvocations: 0,
      },
      tokenUsage: { input: 0, output: 0, total: 0, unknown: false },
      nodeIds: [`commit:${revision}`],
    })),
    nodes: revisions.map((revision) => ({
      id: `commit:${revision}`,
      revision,
      laneId: "world",
      kind: "commit",
      label: `Revision ${revision}`,
      description: `goal-${revision}`,
    })),
    edges: revisions.slice(1).map((revision) => ({
      id: `temporal:${revision - 1}:${revision}`,
      source: `commit:${revision - 1}`,
      target: `commit:${revision}`,
      kind: "temporal",
    })),
    semanticNodes: [],
    semanticEdges: [],
    attempts: [],
    trace: { mode: "full", degraded: false, retainedEventCount: 0, hasFullPayload: true },
    pagination: {
      limit: 24,
      hasOlder: input.hasOlder,
      ...(oldestRevision !== undefined ? { oldestRevision } : {}),
      ...(newestRevision !== undefined ? { newestRevision } : {}),
    },
  };
}

describe("mergeWorldInspectorWindows", () => {
  it("keeps the full loaded range and its boundary edges across overlap and live refresh", () => {
    const older = inspectorWindow([1, 2], { hasOlder: false });
    const latest = inspectorWindow([2, 3], { hasOlder: true });
    const merged = mergeWorldInspectorWindows(latest, older);

    expect(merged.steps.map((step) => step.revision)).toEqual([1, 2, 3]);
    expect(merged.edges.map((edge) => edge.id)).toEqual([
      "temporal:1:2",
      "temporal:2:3",
    ]);
    expect(merged.pagination).toMatchObject({
      hasOlder: false,
      oldestRevision: 1,
      newestRevision: 3,
    });

    const refreshed = mergeWorldInspectorWindows(merged, inspectorWindow([3, 4], { hasOlder: true }));
    expect(refreshed.steps.map((step) => step.revision)).toEqual([1, 2, 3, 4]);
    expect(refreshed.pagination).toMatchObject({
      hasOlder: false,
      oldestRevision: 1,
      newestRevision: 4,
    });
  });

  it("does not combine windows from different world contracts", () => {
    const current = inspectorWindow([1], { hasOlder: false, worldHash: "old" });
    const incoming = inspectorWindow([1], { hasOlder: false, worldHash: "new" });

    expect(mergeWorldInspectorWindows(current, incoming)).toBe(incoming);
  });

  it("returns the current window when a refresh contains no changes and shares changed collections", () => {
    const current = inspectorWindow([1, 2], { hasOlder: false });
    const unchanged = mergeWorldInspectorWindows(current, inspectorWindow([1, 2], { hasOlder: false }));
    expect(unchanged).toBe(current);

    const incoming = inspectorWindow([1, 2], { hasOlder: false });
    incoming.steps[1] = { ...incoming.steps[1]!, elapsedSeconds: 99 };
    const merged = mergeWorldInspectorWindows(current, incoming);
    expect(merged).not.toBe(current);
    expect(merged.steps[0]).toBe(current.steps[0]);
    expect(merged.steps[1]).toBe(incoming.steps[1]);
    expect(merged.nodes[0]).toBe(current.nodes[0]);
    expect(merged.edges[0]).toBe(current.edges[0]);
  });
});
