import { describe, expect, it } from "vitest";
import {
  createRelationalRrfPhysicalBatchRetriever,
  type RelationalRrfGraphTrace,
  type RelationalRrfGraphTraversal,
} from "./relational-rrf";

const key = (id: number): string => `candidate_${id.toString(16).padStart(12, "0")}`;

function context(role: "actor" | "target") {
  const candidate = (id: number, kind: string, allowedUses: string[], details?: unknown) => ({
    candidateKey: key(id), kind, label: `record ${id}`, meaning: kind,
    allowedUses, details, scope: { kind: "shared" as string, slot: undefined as number | undefined },
  });
  const candidates = [
    candidate(0, "action", ["cause"]),
    candidate(1, "entity", ["subject", "target"]),
    candidate(2, "quantity", ["assertion", "conflict"], { holderRef: key(1), amount: 7 }),
    candidate(3, "rating", ["assertion", "conflict", "modifier"], { entityRef: key(1), value: 4 }),
    candidate(4, "meter", ["assertion", "conflict"], { entityRef: key(1), value: 3 }),
    candidate(5, "placement", ["assertion", "conflict"], { entityRef: key(1), containerRef: key(6) }),
    candidate(6, "entity", ["subject", "target"]),
    candidate(7, "quantity", ["assertion", "conflict"], { holderRef: key(6), amount: 7 }),
    candidate(8, "quantity", ["assertion", "conflict"], { holderRef: key(1), amount: 9 }),
    candidate(9, "quantity", ["unsupported"], { holderRef: key(1), amount: 9 }),
    candidate(10, "temporal_profile", ["profile"]),
    candidate(11, "fact", ["assertion", "target"], { subjectRef: key(10), value: "profile-adjacent" }),
    // An unsupported reference relation cannot masquerade as an entity-state edge.
    candidate(12, "quantity", ["assertion", "conflict"], { sourceRef: key(1), amount: 9 }),
  ];
  candidates[8].scope = { kind: "slot", slot: 1 };
  return {
    referenceCatalog: { hash: "state-path-fixture", candidates },
    task: { slots: [{ slot: 0, action: { rawText: "inspect current records" },
      actionReferences: { actionCandidateKey: key(0),
        ...(role === "actor" ? { actor: { status: "unique", boundEntityCandidateKey: key(1) } }
          : { targets: [{ status: "unique", candidateKeys: [key(1)] }] }),
      }, temporalProfileEligibility: [{ eligible: true, profileRef: key(10) }],
    }] },
  };
}

async function run(role: "actor" | "target", policy?: RelationalRrfGraphTraversal, mutateSnapshot = false) {
  const input = context(role), before = structuredClone(input);
  const traces: RelationalRrfGraphTrace[] = [];
  const encoder = { modelId: "fixture", modelHash: "fixture", dimensions: 1,
    async encodeBatch(texts: readonly string[]) { return texts.map(() => [1]); } };
  const physical = createRelationalRrfPhysicalBatchRetriever({
    encoder, graphTraversal: policy, maxPathDepth: 1,
    passageEncoder: { encoder, encoderFingerprint: "fixture", close() {},
      async encodePassages(input) { return { vectors: input.passages.map(() => [1]), hits: input.passages.length, misses: 0, written: 0 }; },
    },
    onGraphTrace: trace => {
      traces.push(structuredClone(trace));
      if (mutateSnapshot) trace.paths.forEach(path => { path.priority = -1000; path.candidateKey = "mutated"; });
    },
  });
  const result = await physical({ worldContentHash: "world", context: input, slotIndices: [0] });
  expect(input).toEqual(before);
  return { result, trace: traces[0] };
}

describe.each(["actor", "target"] as const)("%s state evidence paths", role => {
  it("exposes absent attached state paths under the default and recovers only matching relations", async () => {
    const baseline = await run(role), candidate = await run(role, "typed-state-support");
    for (const id of [2, 3, 4, 5]) {
      expect(baseline.trace.paths.some(path => path.candidateKey === key(id))).toBe(false);
      expect(candidate.trace.paths.find(path => path.candidateKey === key(id))).toMatchObject({ depth: 1 });
      const score = (value: typeof baseline) => value.result.perSlot.get(0)!.candidates.find(row => row.candidateKey === key(id))!.score;
      expect(score(candidate)).toBeGreaterThan(score(baseline));
    }
    for (const id of [7, 8, 9, 11, 12]) {
      expect(candidate.trace.paths.some(path => path.candidateKey === key(id))).toBe(false);
    }
    const ranked = candidate.result.perSlot.get(0)!.candidates.map(row => row.candidateKey);
    expect(ranked).not.toContain(key(8));
    expect(ranked).not.toContain(key(9));
    expect(ranked).toContain(key(7));
    expect(candidate.trace.anchors.find(anchor => anchor.candidateKey === key(10))?.roles).toEqual(["profile"]);
  });
  it("keeps the explicit baseline and protects live ranking from trace mutation", async () => {
    const implicit = await run(role), explicit = await run(role, "field-use-constrained", true);
    expect(explicit.result.perSlot).toEqual(implicit.result.perSlot);
    const ordinary = await run(role, "typed-state-support"), mutated = await run(role, "typed-state-support", true);
    expect(mutated.result.perSlot).toEqual(ordinary.result.perSlot);
  });
});

it("rejects an unknown graph policy before encoding", () => {
  const encoder = { modelId: "fixture", modelHash: "fixture", dimensions: 1, async encodeBatch() { throw new Error("unexpected encoding"); } };
  expect(() => createRelationalRrfPhysicalBatchRetriever({ encoder,
    graphTraversal: "unknown" as RelationalRrfGraphTraversal,
    passageEncoder: { encoder, encoderFingerprint: "fixture", close() {}, async encodePassages() { throw new Error("unexpected encoding"); } },
  })).toThrow("unsupported relational RRF graph traversal");
});
