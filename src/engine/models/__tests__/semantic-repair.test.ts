import { describe, expect, it } from "vitest";
import { createTestModelAudit } from "../../testing/model-provider";
import { ModelOutputError } from "../model-provider";
import {
  runSemanticRepairLoop,
  semanticIssue,
  semanticRepairFingerprint,
} from "../semantic-repair";

const scope = {
  workloadId: "repair-test",
  batchId: "repair-test",
  runtimeIdentity: {
    worldHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    revision: 0,
  },
} as const;

describe("semantic repair loop", () => {
  it("retains the exact rejected candidate before validation mutation, then clears unavailable evidence", async () => {
    const draft = { plans: [{ source: "original" }] };
    const audit = () => createTestModelAudit("truth-resolution", "action-a", scope.runtimeIdentity.worldHash);
    const result = await runSemanticRepairLoop({
      role: "truth-resolution", repairScope: "slot", targetIds: ["action-a"], maxRepairs: 3,
      invoke: async context => {
        if (context.attempt === 0) {
          expect(context).not.toHaveProperty("previousOutput");
          return { value: draft, audit: audit() };
        }
        if (context.attempt === 1) {
          expect(context.previousOutput).toEqual({ plans: [{ source: "original" }] });
          throw new ModelOutputError("JSON null is a known rejected candidate", audit(), { rawValue: null });
        }
        if (context.attempt === 2) {
          expect(context.previousOutput).toBeNull();
          throw new ModelOutputError("No recoverable candidate", audit());
        }
        expect(context).not.toHaveProperty("previousOutput");
        return { value: { plans: [] }, audit: audit() };
      },
      validate: (value, context) => {
        if (context.attempt === 0) {
          value.plans[0]!.source = "validation mutation";
          throw new ModelOutputError("reject generated candidate", undefined);
        }
      },
    });
    expect(result.repairs).toBe(3);
    expect(result.audit.invocations).toHaveLength(4);
  });

  it("keeps malformed provider candidates detached and local to concurrent repairs", async () => {
    await Promise.all(["a", "b"].map(async owner => {
      const raw = { plans: owner };
      await runSemanticRepairLoop({ role: "truth-resolution", repairScope: "slot", targetIds: [owner], maxRepairs: 1,
        invoke: async context => {
          const audit = createTestModelAudit("truth-resolution", owner, scope.runtimeIdentity.worldHash);
          if (context.attempt === 0) throw new ModelOutputError("invalid plans", audit, { rawValue: raw });
          expect(context.previousOutput).toEqual({ plans: owner });
          (context.previousOutput as { plans: string }).plans = "changed copy";
          expect(raw).toEqual({ plans: owner });
          return { value: "accepted", audit };
        },
      });
    }));
  });

  it.each(["generic-audit", "generic-classifier", "projected-audit"])("preserves exact rejected evidence with %s", async variant => {
    const precise = semanticIssue("invalid_type", "Expected string", {
      class: "structure", path: ["plans", 0, "causes", 0, "ref"], originalValue: { proposalKey: "plan-a" },
    });
    const generic = semanticIssue("schema_validation", "Invalid output", { class: "structure", path: [] });
    const audit = createTestModelAudit("truth-resolution", "action-a", scope.runtimeIdentity.worldHash);
    audit.invocations[0]!.issues = [variant === "generic-audit" ? { ...generic, allowedHandles: undefined } : {
      code: precise.code, class: precise.class, path: precise.path, message: precise.message,
      ...(variant === "generic-classifier" ? { originalValue: precise.originalValue } : {}),
    }];
    await expect(runSemanticRepairLoop({
      role: "truth-resolution", repairScope: "slot", targetIds: ["action-a"], maxRepairs: 0,
      invoke: async () => { throw new ModelOutputError("Invalid output", audit); },
      classify: () => [variant === "generic-classifier" ? { ...generic, code: "ModelOutputError" } : precise],
    })).rejects.toMatchObject({ issues: [precise], audit: { invocations: [{ issues: [precise] }] } });
  });

  it("retains substantive root issues alongside field diagnostics", async () => {
    const audit = createTestModelAudit("truth-resolution", "action-a", scope.runtimeIdentity.worldHash);
    const coverage = semanticIssue("missing_actions", "Incomplete action coverage", { class: "semantic", path: [] });
    const reference = semanticIssue("unknown_reference", "Unknown cause", { class: "reference", path: ["causes", 0] });
    audit.invocations[0]!.issues = [{ ...coverage, allowedHandles: undefined }];
    await expect(runSemanticRepairLoop({
      role: "truth-resolution", repairScope: "slot", targetIds: ["action-a"], maxRepairs: 0,
      invoke: async () => { throw new ModelOutputError("Invalid output", audit); }, classify: () => [reference],
    })).rejects.toMatchObject({ issues: [reference, coverage] });
  });

  it("fingerprints deterministic issue identity instead of wording or order", () => {
    const left = semanticRepairFingerprint([
      { code: "reference.unknown_handle", path: ["refs", 1], originalValue: "ref:fact:missing" },
      { code: "temporal.ineligible", path: ["profileRef"], originalValue: "ref:temporal_profile:rate" },
    ], 14);
    const reordered = semanticRepairFingerprint([
      { code: "temporal.ineligible", path: ["profileRef"], originalValue: "ref:temporal_profile:rate" },
      { code: "reference.unknown_handle", path: ["refs", 1], originalValue: "ref:fact:missing" },
    ], 14);

    expect(reordered).toBe(left);
    expect(semanticRepairFingerprint([
      { code: "reference.unknown_handle", path: ["refs", 1], originalValue: "ref:fact:other" },
    ], 14)).not.toBe(left);
    expect(semanticRepairFingerprint([
      { code: "reference.unknown_handle", path: ["refs", 1], originalValue: "ref:fact:missing" },
      { code: "temporal.ineligible", path: ["profileRef"], originalValue: "ref:temporal_profile:rate" },
    ], 15)).not.toBe(left);
  });

  it("retries one scoped issue and combines its audits", async () => {
    let calls = 0;
    const result = await runSemanticRepairLoop({
      role: "action-grounding",
      repairScope: "slot",
      targetIds: ["action-a"],
      maxRepairs: 2,
      invoke: async () => ({
        value: calls++ === 0 ? "bad" : "good",
        audit: createTestModelAudit("action-grounding", "action-a", scope.runtimeIdentity.worldHash),
      }),
      validate: (value) => {
        if (value === "bad") throw new Error("invalid reference");
      },
      classify: () => [semanticIssue("unknown_entity", "use a canonical entity id", {
        class: "reference",
        path: ["stateDependencies", "requiredExistingRefs", 0],
        targetIds: ["action-a"],
      })],
    });

    expect(result.value).toBe("good");
    expect(result.attempts).toBe(2);
    expect(result.repairs).toBe(1);
    expect(result.audit.invocations).toHaveLength(2);
  });

  it("throws a typed exhaustion without choosing a global fallback", async () => {
    await expect(runSemanticRepairLoop({
      role: "action-grounding",
      repairScope: "slot",
      targetIds: ["action-a"],
      maxRepairs: 1,
      invoke: async () => ({
        value: "bad",
        audit: createTestModelAudit("action-grounding", "action-a", scope.runtimeIdentity.worldHash),
      }),
      validate: () => { throw new Error("unknown private evidence"); },
      classify: () => [semanticIssue("private_reference", "private evidence is not canonical", {
        class: "reference",
        path: ["stateDependencies", "potentiallyAffectedExistingRefs", 0],
        originalValue: "rt:fact:private",
        allowedHandles: ["ref:fact:public"],
        targetIds: ["action-a"],
      })],
    })).rejects.toMatchObject({
      name: "SemanticRepairExhaustedError",
      repairScope: "slot",
      targetIds: ["action-a"],
      issues: [{
        code: "private_reference",
        class: "reference",
        originalValue: "rt:fact:private",
        allowedHandles: ["ref:fact:public"],
      }],
    });
  });
});
