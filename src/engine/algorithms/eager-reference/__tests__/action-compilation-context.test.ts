import { describe, expect, it } from "vitest";
import {
  actionCompilationContextProjectionMetrics,
  projectActionCompilationContextForModel,
} from "../action-compilation-context";
import { actionCompilationCandidateKeyForHandle } from "../../../contracts/model-context";

function recordedContext(): Record<string, unknown> {
  const candidates = [
    {
      handle: "ref:action:a",
      candidateKey: "candidate_ffffffffffffffff",
      kind: "action",
      label: "Open the gate",
      meaning: "assigned action",
      allowedUses: ["cause"],
      scope: { kind: "slot", slot: 0 },
      details: { rawText: "Open the gate", goal: "Open the gate" },
    },
    {
      handle: "ref:agent:actor",
      kind: "agent",
      label: "Actor",
      meaning: "assigned actor",
      allowedUses: ["audience"],
      scope: { kind: "slot", slot: 0 },
      details: null,
    },
    {
      handle: "ref:entity:gate",
      kind: "entity",
      label: "Stone gate",
      meaning: "target",
      allowedUses: ["target", "conflict"],
      scope: { kind: "shared" },
      details: { name: "Stone gate", placementRef: "ref:placement:yard" },
    },
    {
      handle: "ref:placement:yard",
      kind: "placement",
      label: "Yard",
      meaning: "location",
      allowedUses: ["conflict"],
      scope: { kind: "shared" },
      details: null,
    },
    {
      handle: "ref:temporal_profile:brief",
      kind: "temporal_profile",
      label: "Brief action",
      meaning: "short fixed profile",
      allowedUses: ["profile"],
      scope: { kind: "shared" },
      details: null,
    },
    {
      handle: "ref:world:world",
      kind: "world",
      label: "World",
      meaning: "world clock",
      allowedUses: ["conflict"],
      scope: { kind: "shared" },
      details: null,
    },
  ];
  return {
    contractVersion: 17,
    task: {
      slots: [{
        slot: 0,
        assignment: { targetHandles: ["ref:action:a"], allowedProposalKinds: [] },
        constraints: [],
        repair: null,
      }],
    },
    state: {
      currentElapsedSeconds: 12,
      temporalProfiles: [{
        profileRef: "ref:temporal_profile:brief",
        kind: "fixed",
        name: "Brief action",
        selection: { evidenceRequirement: "none" },
      }],
      slots: [{
        slot: 0,
        action: {
          actionRef: "ref:action:a",
          actorRef: "ref:agent:actor",
          targetRefs: ["ref:entity:gate"],
          rawText: "Open the gate",
          goal: "Open the gate",
          means: "Push it",
        },
        existingActivities: [],
      }],
      canonicalTruth: {
        entities: [{ ref: "ref:entity:gate", name: "Stone gate", placementRef: "ref:placement:yard" }],
        placements: [{ ref: "ref:placement:yard", containerRef: "ref:entity:yard" }],
      },
    },
    referenceCatalog: { version: 2, hash: "recorded", candidates },
    referenceCatalogs: [{
      slot: 0,
      catalog: { version: 2, hash: "duplicate", candidates },
    }],
    repair: null,
  };
}

describe("production Action Compilation context projector", () => {
  it("keeps one complete namespace while selecting deterministic details", () => {
    const projected = projectActionCompilationContextForModel(recordedContext());
    expect(projected).not.toHaveProperty("referenceCatalogs");
    expect(JSON.stringify(projected)).not.toContain("availableHandles");
    expect(JSON.stringify(projected)).not.toContain("ref:");
    expect(actionCompilationContextProjectionMetrics(projected)).toMatchObject({ candidates: 6, slots: 1 });
    expect(projected.referenceCatalog.version).toBe(2);
    expect(projected.referenceCatalog.candidates.every((candidate) =>
      typeof candidate.candidateKey === "string" && /^candidate_[0-9a-f]{12}$/u.test(candidate.candidateKey))).toBe(true);
    expect(projected.referenceCatalog.candidates.map((candidate) => candidate.candidateKey)).toEqual(expect.arrayContaining([
      actionCompilationCandidateKeyForHandle("ref:action:a"),
      actionCompilationCandidateKeyForHandle("ref:agent:actor"),
      actionCompilationCandidateKeyForHandle("ref:entity:gate"),
      actionCompilationCandidateKeyForHandle("ref:placement:yard"),
      actionCompilationCandidateKeyForHandle("ref:temporal_profile:brief"),
      actionCompilationCandidateKeyForHandle("ref:world:world"),
    ]));
    expect(projected.referenceCatalog.candidates.map((candidate) => candidate.candidateKey))
      .toContain(actionCompilationCandidateKeyForHandle("ref:action:a"));
    expect(projected.referenceCatalog.candidates.map((candidate) => candidate.candidateKey))
      .not.toContain("candidate_ffffffffffffffff");
    expect(projected.referenceCatalog.candidates.find((candidate) => candidate.candidateKey === actionCompilationCandidateKeyForHandle("ref:action:a"))?.details)
      .toMatchObject({ rawText: "Open the gate" });
    expect(projected.referenceCatalog.candidates.find((candidate) => candidate.candidateKey === actionCompilationCandidateKeyForHandle("ref:temporal_profile:brief"))?.details)
      .toMatchObject({ kind: "fixed" });
  });

  it("preserves every repair issue and previous output in the compact slot envelope", () => {
    const context = recordedContext();
    const task = context.task as { slots: Array<Record<string, unknown>> };
    task.slots[0]!.repair = {
      fingerprint: "repair-fingerprint",
      previousOutput: { temporalPlan: { profileRef: "ref:temporal_profile:brief" } },
      issues: [{ code: "temporal.continuation_assertion_false", reason: "choose an onset-true assertion" },
        { code: "reference.disallowed_use", reason: "choose an allowed dependency" }],
    };
    const projected = projectActionCompilationContextForModel(context);
    expect(projected.task.slots[0]).toMatchObject({
      issues: [{ code: "temporal.continuation_assertion_false" }, { code: "reference.disallowed_use" }],
      previousAttempt: { temporalPlan: { profileRef: actionCompilationCandidateKeyForHandle("ref:temporal_profile:brief") } },
    });
  });
});
