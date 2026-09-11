import { expect, it } from "vitest";
import { z } from "zod";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { contentHash } from "../../models/model-audit";
import { SemanticProfileSelectors, scoreSemanticProfileDiagnostic } from "./semantic-profile-selectors";

const action = "candidate_000000000000", fixed = "candidate_000000000001", conditional = "candidate_000000000002";
const context = {
  referenceCatalog: { candidates: [
    { candidateKey: action, kind: "action", scope: { kind: "slot" as const, slot: 0 }, details: { opaque: { profileRef: fixed } } },
    { candidateKey: fixed, kind: "temporal_profile", label: "相同可见名称", details: { kind: "fixed" }, scope: { kind: "shared" as const } },
    { candidateKey: conditional, kind: "temporal_profile", label: "相同可见名称", details: { kind: "conditional" }, scope: { kind: "shared" as const } },
  ] },
  temporalCalibrations: [{ profileRef: fixed, explanation: `Literal ${conditional}` }],
  task: { slots: [{ slot: 0, action: { rawText: `Read literal ${fixed}` }, actionReferences: { actionCandidateKey: action },
    issue: null, previousAttempt: null, temporalProfileEligibility: [fixed, conditional].map((profileRef) => ({ profileRef, eligible: true })) }] },
};
const output = { slots: [{ slot: 0, temporalPlan: { profileRef: fixed, basis: { kind: "profile" }, description: fixed, continuationAssertions: [], causes: [{ kind: "action", ref: action }] },
  interactionDependency: { stateDependencies: { requiredExistingCandidateKeys: [], potentiallyAffectedCandidateKeys: [] }, audienceAgentCandidateKeys: [], sharedResourceClaims: [] },
}] };

it("round trips typed profile selectors and their real wire schema without touching opaque data", () => {
  const codec = new SemanticProfileSelectors(context), encoded = codec.context(context), wire = codec.output(output, false);
  expect(contentHash(codec.context(encoded, true))).toBe(contentHash(context));
  expect(codec.output(wire)).toEqual(output);
  const converted = encoded as typeof context;
  const keys = converted.referenceCatalog.candidates.filter((entry) => entry.kind === "temporal_profile").map((entry) => entry.candidateKey);
  expect(new Set(keys).size).toBe(2);
  expect(keys.every((key) => key.includes("相同可见名称"))).toBe(true);
  expect(converted.referenceCatalog.candidates[0]).toEqual(context.referenceCatalog.candidates[0]);
  expect(converted.task.slots[0]!.action).toEqual(context.task.slots[0]!.action);
  expect(converted.temporalCalibrations[0]!.explanation).toBe(context.temporalCalibrations[0]!.explanation);
  const original = new ActionCompilationCodec("T", context).wireSchema(context);
  const schema = z.toJSONSchema(original, { target: "draft-07" }), mapped = codec.schema(schema);
  expect(codec.schema(mapped, true)).toEqual(schema);
  expect(z.fromJSONSchema(mapped as Parameters<typeof z.fromJSONSchema>[0]).safeParse(wire).success).toBe(true);
  expect(original.safeParse(codec.output(wire)).success).toBe(true);
  expect(scoreSemanticProfileDiagnostic(JSON.stringify(wire), context, [])).toMatchObject({ rawJson: true, schemaAndReferences: true });
});

it("rejects selector drift, canonical bypass and repair input instead of guessing", () => {
  const codec = new SemanticProfileSelectors(context);
  expect(() => codec.output(output)).toThrow("unknown temporal selector");
  expect(scoreSemanticProfileDiagnostic(JSON.stringify(output), context, []).schemaAndReferences).toBe(false);
  const changed = structuredClone(context) as unknown as Record<string, unknown>;
  (changed.task as { slots: Array<{ issue: unknown }> }).slots[0]!.issue = { reason: "repair" };
  expect(() => codec.context(changed)).toThrow("initial slots");
  const wire = codec.output(output, false) as typeof output;wire.slots[0]!.temporalPlan.profileRef = "temporal_999:invented";
  expect(() => codec.output(wire)).toThrow("unknown temporal selector");
});

it("renders execution contracts while preserving the same profile identities, fields and schema after inversion", () => {
  const full = structuredClone(context);
  full.referenceCatalog.candidates[1]!.details = { kind: "fixed", durationSeconds: 10, selection: { evidenceRequirement: "none" } } as typeof full.referenceCatalog.candidates[1]["details"];
  full.referenceCatalog.candidates[2]!.details = { kind: "conditional", checkEverySeconds: 300, selection: { evidenceRequirement: "none" } } as typeof full.referenceCatalog.candidates[2]["details"];
  const codec = new SemanticProfileSelectors(full, "execution_contract");
  const encoded = codec.context(full);
  expect(contentHash(codec.context(encoded, true))).toBe(contentHash(full));
  const json = JSON.stringify(encoded);
  expect(json).toContain("whole_action_total_10s");
  expect(json).toContain("until_success_check_every_300s");
  expect(json).toContain("相同可见名称");
  const schema = z.toJSONSchema(new ActionCompilationCodec("T", full).wireSchema(full), { target: "draft-07" });
  expect(codec.schema(codec.schema(schema), true)).toEqual(schema);
  const wire = codec.output(output, false);
  expect(z.fromJSONSchema(codec.schema(schema) as Parameters<typeof z.fromJSONSchema>[0]).safeParse(wire).success).toBe(true);
  expect(codec.output(wire)).toEqual(output);
});
