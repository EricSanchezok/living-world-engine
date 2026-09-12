import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import { compileActions } from "../../algorithms/eager-reference/action-compiler";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { representedActionCompiler } from "../../algorithms/eager-reference/represented-action-compiler";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../testing/model-provider";
import { compilationReferenceUses, compilationReferenceUsesRequest } from "./compilation-reference-uses";

type Value = Record<string, unknown>;
const row = (candidateKey: string, kind: string, entityRef?: string, slot?: number) => ({ candidateKey, kind,
  label: "Same label", allowedUses: kind === "agent" ? ["audience", "target"] : ["conflict", "target"],
  scope: slot === undefined ? { kind: "shared" } : { kind: "slot", slot }, details: entityRef ? { entityRef } : null });
const context = () => ({ sourceText: "r004 is literal text", task: { slots: [0, 1].map(slot => ({ slot,
  action: { rawText: "Ask the target, then inspect the building.", goal: "Receive an answer", means: null },
  actionReferences: { actor: { status: "unique", agentCandidateKey: "r003", boundEntityCandidateKey: "r000" }, targets: [
    { targetIndex: 0, label: "Both possibilities", status: "ambiguous", candidateKeys: ["r001", "r002"] },
    { targetIndex: 1, label: "Unknown", status: "unresolved", candidateKeys: [] },
    { targetIndex: 2, label: "Old reference", status: "stale", candidateKeys: ["r999"] },
  ] }, afterReferences: { opaque: "r005" },
})) }, referenceCatalog: { candidates: [row("r000", "entity"), row("r001", "entity"), row("r002", "entity"),
  row("r003", "agent", "r000"), row("r004", "agent", "r001"), row("r005", "agent", "r002"),
  row("r006", "agent", "r001", 0), row("r007", "agent", "r001", 1), row("r008", "agent"), row("r009", "fact"),
] } });
const views = (projected: ReturnType<typeof compilationReferenceUses>) =>
  ((projected.context.task as Value).slots as Value[]).map(slot => slot.referenceUseBindings as {
    actor: { stateDependencyCandidateKey: string; audienceAgentCandidateKey: string };
    targets: Array<{ status: string; alternatives: Array<{ stateDependencyCandidateKey: string; audienceAgentCandidateKeys: string[] }>; unavailableCandidateKeys: string[] }>;
  });

it("preserves all declared alternatives, scope and source order without guessing missing Agent links", () => {
  const source = context(), before = JSON.stringify(source), projected = compilationReferenceUses(source);
  expect(JSON.stringify(source)).toBe(before);
  const [a, b] = views(projected);
  expect(a!.actor).toMatchObject({ stateDependencyCandidateKey: "r000", audienceAgentCandidateKey: "r003" });
  expect(a!.targets[0]!.alternatives).toEqual([
    { stateDependencyCandidateKey: "r001", audienceAgentCandidateKeys: ["r004", "r006"] },
    { stateDependencyCandidateKey: "r002", audienceAgentCandidateKeys: ["r005"] },
  ]);
  expect(b!.targets[0]!.alternatives[0]!.audienceAgentCandidateKeys).toEqual(["r004", "r007"]);
  expect(a!.targets[1]).toMatchObject({ status: "unresolved", alternatives: [] });
  expect(a!.targets[2]).toMatchObject({ status: "stale", alternatives: [], unavailableCandidateKeys: ["r999"] });
  const restored = structuredClone(projected.context);
  for (const slot of (restored.task as Value).slots as Value[]) delete slot.referenceUseBindings;
  expect(JSON.stringify(restored)).toBe(before);
  expect(() => compilationReferenceUses(projected.context)).toThrow("collision");
});

it("follows swapped exact links with identical names and inventory order, and preserves missing-detail uncertainty", () => {
  const source = context(), changed = structuredClone(source);
  changed.referenceCatalog.candidates[4]!.details = { entityRef: "r002" };
  changed.referenceCatalog.candidates[5]!.details = { entityRef: "r001" };
  expect(changed.referenceCatalog.candidates.map(row => [row.candidateKey, row.label])).toEqual(source.referenceCatalog.candidates.map(row => [row.candidateKey, row.label]));
  expect(views(compilationReferenceUses(changed))[0]!.targets[0]!.alternatives[0]!.audienceAgentCandidateKeys).toEqual(["r005", "r006"]);
  changed.referenceCatalog.candidates[5]!.details = null;
  expect(views(compilationReferenceUses(changed))[0]!.targets[0]!.alternatives[0]!.audienceAgentCandidateKeys).toEqual(["r006"]);
  changed.referenceCatalog.candidates[3]!.details = { entityRef: "r002" };
  expect(() => compilationReferenceUses(changed)).toThrow("links disagree");
});

it("retains the exact original output boundary and checks its source on primary and repair requests", () => {
  const source = context(), schema = z.object({ slots: z.array(z.unknown()) }).strict();
  const request = { workloadId: "world", batchId: "batch", profileId: "truth", subjectId: "slots", promptVersion: "source-v1",
    role: "action-compilation" as const, schemaName: "action_compilation_at_eligible_source_choice_v1", system: "source", userPrompt: "compile",
    schema, context: source, preprocessOutput: (raw: unknown) => ({ value: raw, symbolRepairs: [] }) };
  const adapted = compilationReferenceUsesRequest(request);
  expect(adapted.schema).toBe(schema); expect(adapted.wireJsonSchema).toBeUndefined();
  const invalid = { slots: [{ interactionDependency: { stateDependencies: { requiredExistingCandidateKeys: ["r003"], audienceAgentCandidateKeys: ["r001"] } } }] };
  expect(adapted.preprocessOutput!(invalid).value).toBe(invalid);
  const repair = compilationReferenceUsesRequest({ ...request, context: { ...source, task: { slots: [source.task.slots[1]!] } }, correlation: { semanticRepairAttempt: 1 } });
  expect((repair.context as typeof source).task.slots).toHaveLength(1);
  expect(() => compilationReferenceUsesRequest(adapted)).toThrow("already applied");
  source.referenceCatalog.candidates[4]!.details = { entityRef: "r002" };
  expect(() => adapted.preprocessOutput!(invalid)).toThrow("source binding changed");
  const unrelated = { ...request, role: "truth-resolution" as const };
  expect(compilationReferenceUsesRequest(unrelated)).toBe(unrelated);
});

it("preserves materialization through the real represented compiler", async () => {
  const baseline = new ScriptedModelProvider(({ profileId, context }) => deterministicActionCompilationBatch(profileId, context));
  const { initialState: state } = loadWorldScript("test/fixtures/open-world-script", { seed: 47, modelCatalog: baseline.catalog });
  const actions = [{ id: "inspect-key", actorId: "player", baseRevision: 0, rawText: "Examine the copper key.", goal: "Inspect the copper key", means: null, targetIds: ["copper-key"] }];
  const scope = { workloadId: "uses", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const original = await compileActions(baseline, state, actions, scope, "truth-engine", 12);
  const context = baseline.requests[0]!.context, raw = deterministicActionCompilationBatch("truth-engine", context);
  const wire = new ActionCompilationCodec("AT", context).encodeOutput(raw);
  const provider = new ScriptedModelProvider(() => wire), generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => generate(compilationReferenceUsesRequest(request));
  const result = await representedActionCompiler("AT", true, true, true)(provider, state, actions, scope, "truth-engine", 12);
  expect(provider.requests).toHaveLength(1);
  expect((provider.requests[0]!.context as { task: { slots: Value[] } }).task.slots[0]).toHaveProperty("referenceUseBindings");
  expect(result.compilations).toEqual(original.compilations);
});
