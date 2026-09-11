import { expect, it } from "vitest";
import { contentHash } from "../models/model-audit";
import { logicalRepairContext, LOGICAL_CANDIDATE_REPAIR_VERSION } from "./logical-repair-context";

it("leaves first requests untouched and binds only the current rejected candidate", () => {
  const context = { task: { constraints: ["original requirement"] }, state: { revision: 4 }, repair: null };
  const repair = { attempt: 0, scope: "slot" as const, targetIds: ["a"], issues: [], logicalInvocationId: "logical-a" };
  const original = structuredClone(context), sourceHash = contentHash(context);
  expect(logicalRepairContext(context, repair, sourceHash, "schema")).toBe(context);
  const candidate = { plans: ["uncommitted"] };
  const next = logicalRepairContext(context, { ...repair, attempt: 1, previousOutput: candidate, repairOf: "rejected-1" }, sourceHash, "schema");
  expect(next).toMatchObject({ state: original.state, repair: { previousOutputAvailable: true, previousOutput: candidate,
    candidateBinding: { contractVersion: LOGICAL_CANDIDATE_REPAIR_VERSION, sourceContextHash: sourceHash,
      canonicalOutputHash: contentHash(candidate), schemaName: "schema", logicalInvocationId: "logical-a", previousInvocationId: "rejected-1" } } });
  candidate.plans.push("later mutation");
  expect(next).toMatchObject({ repair: { previousOutput: { plans: ["uncommitted"] } } });
  expect(context).toEqual(original);
  expect(logicalRepairContext(context, { ...repair, attempt: 2 }, sourceHash, "schema"))
    .toMatchObject({ repair: { previousOutputAvailable: false, previousOutput: null, candidateBinding: { canonicalOutputHash: null } } });
  expect(logicalRepairContext(context, { ...repair, attempt: 2, previousOutput: null }, sourceHash, "schema"))
    .toMatchObject({ repair: { previousOutputAvailable: true, previousOutput: null, candidateBinding: { canonicalOutputHash: contentHash(null) } } });
});
