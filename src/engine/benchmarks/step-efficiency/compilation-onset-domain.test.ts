import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import { compileActions } from "../../algorithms/eager-reference/action-compiler";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { representedActionCompiler } from "../../algorithms/eager-reference/represented-action-compiler";
import { actionCompilationCandidateKeyForHandle, referenceHandleFor } from "../../contracts/model-context";
import { actionGroundingReferenceResolver } from "../../mechanics/action-dependency";
import { evaluateCausalAssertion } from "../../mechanics/causality";
import { contentHash } from "../../models/model-audit";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../testing/model-provider";
import { compilationOnsetDomainProof, compilationOnsetDomainRequest, specializeCompilationOnsetSchema } from "./compilation-onset-domain";

type Output = { slots: Array<{ temporalPlan: { profileRef: string; continuationAssertions: unknown } }> };
const key = (kind: Parameters<typeof referenceHandleFor>[0], id: string) => actionCompilationCandidateKeyForHandle(referenceHandleFor(kind, id));
function conditionalOutput(profileId: string, context: unknown) {
    const raw = deterministicActionCompilationBatch(profileId, context) as Output;
    raw.slots[0]!.temporalPlan.profileRef = key("temporal_profile", "wait-condition");
    raw.slots[0]!.temporalPlan.continuationAssertions = [
      { kind: "fact_matches", factRef: key("fact", "signal-state"), expected: { kind: "none" } },
      { kind: "elapsed_seconds_compare", operator: "gte", value: 0 },
    ];
    return raw;
}
function fixture() {
  const provider = new ScriptedModelProvider(({ profileId, context }) => conditionalOutput(profileId, context));
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  state.truth.facts["signal-state"] = { ...Object.values(state.truth.facts)[0]!, id: "signal-state", value: { kind: "none" } };
  const actions = [{ id: "wait-signal", actorId: "player", baseRevision: 0, rawText: "Wait here while the signal remains unset.",
    goal: "Wait for the signal", means: null, targetIds: [] }];
  const scope = { workloadId: "onset", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  return { provider, state, actions, scope };
}

it("proves the whole actual resolver domain while retaining absence semantics after record removal", () => {
  const { state } = fixture(), hash = contentHash(state), proof = compilationOnsetDomainProof(state);
  expect(proof.stateHash).toBe(hash);
  expect(proof.facts).toBe(Object.keys(state.truth.facts).length);
  expect(proof.entities).toBe(Object.keys(state.truth.entities).length);
  expect(contentHash(state)).toBe(hash);
  expect(evaluateCausalAssertion(state, { kind: "fact_absent", factId: "signal-state" }).passed).toBe(false);
  expect(evaluateCausalAssertion(state, { kind: "fact_matches", factId: "signal-state", expected: { kind: "none" } }).passed).toBe(true);
  state.truth.entities.player!.lifecycle = "retired";
  expect(evaluateCausalAssertion(state, { kind: "entity_absent", entityId: "player" }).passed).toBe(false);
  delete state.truth.facts["signal-state"];
  expect(evaluateCausalAssertion(state, { kind: "fact_absent", factId: "signal-state" }).passed).toBe(true);
  expect(actionGroundingReferenceResolver(state).candidatesFor("assertion").some(row => row.handle === "ref:fact:signal-state")).toBe(false);
  expect(compilationOnsetDomainProof(state).facts).toBe(proof.facts - 1);
});

it("retains real conditional compilation and original output processing, including none-valued facts", async () => {
  const f = fixture(), original = await compileActions(f.provider, f.state, f.actions, f.scope, "truth-engine", 12);
  const root = f.provider.requests[0]!.context, raw = conditionalOutput("truth-engine", root);
  const at = new ActionCompilationCodec("AT", root), wire = at.encodeOutput(raw);
  const provider = new ScriptedModelProvider(() => wire), generate = provider.generateStructured.bind(provider);
  provider.generateStructured = async request => {
    const before = z.toJSONSchema(request.schema, { target: "draft-07" });
    const candidate = compilationOnsetDomainRequest(request, f.state);
    expect(candidate.context).toBe(request.context); expect(candidate.schema).toBe(request.schema);
    expect(candidate.preprocessOutput!(wire)).toEqual(request.preprocessOutput!(wire));
    const validation = z.fromJSONSchema(candidate.wireJsonSchema!).safeParse(wire);
    expect(validation.success, JSON.stringify(validation)).toBe(true);
    expect(z.toJSONSchema(request.schema, { target: "draft-07" })).toEqual(before);
    // Other-stage schemas keep the same absence vocabulary and opaque values.
    const other = { ...request, role: "truth-resolution" as const };
    expect(compilationOnsetDomainRequest(other, f.state)).toBe(other);
    expect(() => compilationOnsetDomainRequest(candidate, f.state)).toThrow("already applied");
    expect(() => specializeCompilationOnsetSchema(candidate.wireJsonSchema!)).toThrow("contract drift");
    const changed = structuredClone(f.state); changed.revision++;
    expect(() => compilationOnsetDomainRequest(request, changed)).toThrow("epoch");
    const response = await generate(candidate);
    f.state.truth.facts["signal-state"]!.description += " altered";
    expect(() => candidate.preprocessOutput!(wire)).toThrow("source binding changed");
    f.state.truth.facts["signal-state"]!.description = f.state.truth.facts["signal-state"]!.description.slice(0, -8);
    return response;
  };
  const actual = await representedActionCompiler("AT", true, true, true)(provider, f.state, f.actions, f.scope, "truth-engine", 12);
  expect(actual.compilations).toEqual(original.compilations);
  expect(provider.requests).toHaveLength(1);
});

it.each(["fact_absent", "entity_absent"] as const)("keeps the real onset rejection for %s despite narrower wire guidance", async kind => {
  const f = fixture();
  await compileActions(f.provider, f.state, f.actions, f.scope, "truth-engine", 12);
  const root = f.provider.requests[0]!.context, raw = conditionalOutput("truth-engine", root);
  raw.slots[0]!.temporalPlan.continuationAssertions = [kind === "fact_absent"
    ? { kind, factRef: key("fact", "signal-state") } : { kind, entityRef: key("entity", "player") }];
  const wire = new ActionCompilationCodec("AT", root).encodeOutput(raw);
  const provider = new ScriptedModelProvider(() => wire), generate = provider.generateStructured.bind(provider);
  provider.generateStructured = async request => {
    const candidate = compilationOnsetDomainRequest(request, f.state);
    expect(request.schema.safeParse(wire).success).toBe(true);
    expect(z.fromJSONSchema(candidate.wireJsonSchema!).safeParse(wire).success).toBe(false);
    return generate(candidate);
  };
  await expect(representedActionCompiler("AT", true, true, true)(provider, f.state, f.actions, f.scope, "truth-engine", 12))
    .rejects.toThrow(/continuation|compilation/u);
});
