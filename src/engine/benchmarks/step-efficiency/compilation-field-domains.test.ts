import { expect, it } from "vitest";
import { z } from "zod";
import { compilationFieldDomains, compilationFieldDomainsRequest, specializeCompilationFieldSchema } from "./compilation-field-domains";

const ref = z.string().regex(/^r[0-9]{3,}$/u);
const schema = z.object({ slots: z.array(z.object({ slot: z.number().int(), interactionDependency: z.object({
  stateDependencies: z.object({ requiredExistingCandidateKeys: z.array(ref), potentiallyAffectedCandidateKeys: z.array(ref) }).strict(),
  audienceAgentCandidateKeys: z.array(ref),
  sharedResourceClaims: z.array(z.object({ resourcePoolCandidateKey: ref, basis: z.object({ kind: z.literal("default") }).strict() }).strict()),
}).strict() }).strict()) }).strict();
const row = (candidateKey: string, kind: string, allowedUses: string[], slot?: number) => ({ candidateKey, kind, allowedUses,
  scope: slot === undefined ? { kind: "shared" } : { kind: "slot", slot } });
const context = () => ({ task: { slots: [{ slot: 0 }, { slot: 1 }] }, referenceCatalog: { candidates: [
  row("r000", "entity", ["conflict"]), row("r001", "agent", ["audience"], 0), row("r002", "agent", ["audience"], 1),
  row("r003", "shared_resource_pool", ["conflict"]), row("r004", "agent", ["conflict"]),
  row("r005", "entity", ["audience"]), row("r006", "fact", ["assertion"]), row("r007", "agent", ["audience"], 2),
] } });
const value = () => ({ slots: [{ slot: 0, interactionDependency: { stateDependencies: {
  requiredExistingCandidateKeys: ["r000"], potentiallyAffectedCandidateKeys: [],
}, audienceAgentCandidateKeys: ["r001"], sharedResourceClaims: [{ resourcePoolCandidateKey: "r003", basis: { kind: "default" } }] } }] });

it("retains the whole eligible union across slots and distinguishes type from use", () => {
  const source = context(), before = structuredClone(source);
  expect(compilationFieldDomains(source)).toEqual({ dependency: ["r000", "r003"], audience: ["r001", "r002"], resource: ["r003"] });
  expect(source).toEqual(before);
  source.task.slots = [{ slot: 1 }];
  expect(compilationFieldDomains(source).audience).toEqual(["r002"]);
  source.referenceCatalog.candidates.push(source.referenceCatalog.candidates[0]!);
  expect(() => compilationFieldDomains(source)).toThrow("binding");
});

it("preserves the schema predicates and sibling shape while rejecting the observed cross-field choices", () => {
  const source = z.toJSONSchema(schema, { target: "draft-07" }), before = structuredClone(source);
  const candidate = specializeCompilationFieldSchema(source, compilationFieldDomains(context()));
  const wire = z.fromJSONSchema(candidate);
  expect(wire.safeParse(value()).success).toBe(true);
  for (const alter of [
    (v: ReturnType<typeof value>) => { v.slots[0]!.interactionDependency.audienceAgentCandidateKeys = ["r000"]; },
    (v: ReturnType<typeof value>) => { v.slots[0]!.interactionDependency.stateDependencies.requiredExistingCandidateKeys = ["r001"]; },
    (v: ReturnType<typeof value>) => { v.slots[0]!.interactionDependency.sharedResourceClaims[0]!.resourcePoolCandidateKey = "r000"; },
    (v: ReturnType<typeof value>) => { Object.assign(v.slots[0]!.interactionDependency.stateDependencies, { audienceAgentCandidateKeys: ["r001"] }); },
  ]) { const raw = value(); alter(raw); expect(wire.safeParse(raw).success).toBe(false); }
  expect(source).toEqual(before);
  expect(JSON.stringify(candidate)).toContain('"pattern":"^r[0-9]{3,}$"');
  expect(() => specializeCompilationFieldSchema(candidate, compilationFieldDomains(context()))).toThrow("collision");
});

it("allows empty arrays with an empty domain without adding a null or guessed selector", () => {
  const candidate = specializeCompilationFieldSchema(z.toJSONSchema(schema, { target: "draft-07" }), { dependency: [], audience: [], resource: [] });
  const definitions = candidate.definitions as Record<string, unknown>;
  expect(definitions).toEqual({ compilation_dependency_domain: { not: {} }, compilation_audience_domain: { not: {} }, compilation_resource_domain: { not: {} } });
  // The array predicates are untouched: zero items never visit the impossible item domain.
  const empty = value(); empty.slots[0]!.interactionDependency = { stateDependencies: { requiredExistingCandidateKeys: [], potentiallyAffectedCandidateKeys: [] }, audienceAgentCandidateKeys: [], sharedResourceClaims: [] };
  expect(schema.safeParse(empty).success).toBe(true);
});

it("leaves output processing authoritative and binds the unchanged source on primary and repair requests", () => {
  const request = { workloadId: "world", batchId: "batch", profileId: "truth", subjectId: "slots", promptVersion: "source-v1",
    role: "action-compilation" as const, schemaName: "action_compilation_at_eligible_source_choice_v1", system: "source", userPrompt: "compile",
    schema, context: context(), preprocessOutput: (raw: unknown) => ({ value: raw, symbolRepairs: [] }) };
  const candidate = compilationFieldDomainsRequest(request), raw = value();
  expect(candidate.context).toBe(request.context); expect(candidate.schema).toBe(request.schema);
  expect(candidate.preprocessOutput!(raw).value).toBe(raw);
  const repair = compilationFieldDomainsRequest({ ...request, context: { ...context(), task: { slots: [{ slot: 1 }] } },
    correlation: { semanticRepairAttempt: 1 } });
  expect(repair.promptVersion).not.toBe(candidate.promptVersion);
  expect(() => compilationFieldDomainsRequest(candidate)).toThrow("already applied");
  request.context.referenceCatalog.candidates.pop();
  expect(() => candidate.preprocessOutput!(raw)).toThrow("source binding changed");
  const other = { ...request, role: "truth-resolution" as const };
  expect(compilationFieldDomainsRequest(other)).toBe(other);
});
