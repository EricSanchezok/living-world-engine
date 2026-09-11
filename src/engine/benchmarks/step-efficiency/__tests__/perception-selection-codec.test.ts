import { withNoStimulusCompletion } from "../../../testing/model-provider";
import path from "node:path";
import { expect, it } from "vitest";
import type { OnsetPerceptionInput } from "../../../algorithms/roles";
import type { FactValue } from "../../../contracts/model";
import { existingReferenceHandleSchema, proposalKeySchema } from "../../../contracts/model-context";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { successfulOnsetPerceptionChecks } from "../../../mechanics/onset-reaction-basis";
import { contentHash } from "../../../models/model-audit";
import type { StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider } from "../../../testing/model-provider";
import { loadWorldScript } from "../../../../script/world-loader";
import { perceptionAssessmentRequest, validatePerceptionAssessment, type PerceptionAssessmentDraft } from "../perception-assessment";
import { PerceptionSelectionCodec } from "../perception-selection-codec";

const h = (value: string) => existingReferenceHandleSchema.parse(value);
const k = (value: string) => proposalKeySchema.parse(value);
async function fixture(options: { value?: FactValue; shared?: boolean; literalText?: boolean } = {}) {
  const provider = new ScriptedModelProvider(withNoStimulusCompletion(() => ({ kind: "done" })), undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  state.truth.facts.route = { id: "route", subjectId: "player", predicate: "access", value: options.value ?? { kind: "text", value: "open" },
    description: "Current access condition", access: { kind: "private" }, provenance: [{ kind: "world_seed", id: state.worldHash }] };
  const input: OnsetPerceptionInput = { definition, state, identityOwner: "selection-test",
    groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: options.literalText ? "ref:entity:keeper" : "Conceal the copper key.",
      goal: "Keep the key hidden", means: "Slide it into a sleeve", targetIds: ["copper-key"] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  if (options.shared) {
    input.actions.push({ ...input.actions[0]!, id: "depart", rawText: "Leave through the gate." });
    input.perceptionTargets = [...input.perceptionTargets!, { observerId: "keeper", sourceActionId: "depart" }];
  }
  const scope = { workloadId: "selection-world", batchId: "selection-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  let captured: StructuredModelRequest<unknown> | undefined;
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = async request => { captured ??= request; return generate(request); };
  await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input, scope);
  const original = perceptionAssessmentRequest(captured!, input);
  const codec = new PerceptionSelectionCodec(original, input);
  const value = state.truth.facts.route.value;
  const draft: PerceptionAssessmentDraft = { assessments: input.perceptionTargets!.map(pair => ({ observerRef: h("ref:entity:keeper"), sourceActionRef: h(`ref:action:${pair.sourceActionId}`),
    evidence: [{ kind: "fact", ref: h("ref:fact:route"), value: value.kind === "entity" ? { kind: "entity", entityRef: h(`ref:entity:${value.entityId}`) } : value },
      { kind: "action", ref: h(`ref:action:${pair.sourceActionId}`) }], verdict: "check_required", checkKeys: [k("notice-key")] })),
    requests: [{ proposalKey: k("notice-key"), perceivedEntityRef: h("ref:entity:key"), ratingRef: h("ref:rating:resolve:keeper"),
      difficulty: { kind: "environment", band: "easy", source: { kind: "fact", ref: h("ref:fact:route") } }, mode: "normal", visibility: "result_only",
      basisRefs: [{ kind: "fact", ref: h("ref:fact:route") }] }] };
  return { input, scope, original, codec, draft };
}

it.each<FactValue>([{ kind: "text", value: "ref:entity:keeper" }, { kind: "number", value: 0 }, { kind: "boolean", value: false },
  { kind: "entity", entityId: "key" }, { kind: "none" }])("preserves every Fact value and complete original context: $kind", async value => {
  const { input, original, codec, draft } = await fixture({ value, literalText: true });
  const before = contentHash(input), wire = codec.encodeOutput(draft);
  expect(codec.decodeOutput(wire, codec.bindingHash)).toEqual(draft);
  expect(codec.restoreContext()).toEqual(original.context);
  expect(JSON.stringify(codec.request.context)).toContain('"rawText":"ref:entity:keeper"');
  expect(JSON.stringify(codec.request.context)).toContain('"targetRefs":["ref:local_entity:player::copper-key"]');
  expect(codec.request.profileId).toBe(original.profileId);
  expect(contentHash(input)).toBe(before);
});

it.each(["visible", "no_route", "insufficient_evidence"] as const)("preserves terminal %s without a fabricated check", async verdict => {
  const { codec, draft } = await fixture();
  draft.assessments[0]!.verdict = verdict; draft.assessments[0]!.checkKeys = []; draft.requests = [];
  expect(codec.decodeOutput(codec.encodeOutput(draft), codec.bindingHash)).toEqual(draft);
});

it("keeps shared-check associations and original output order while binding task identities", async () => {
  const { codec, draft } = await fixture({ shared: true });
  draft.assessments.reverse();
  expect(codec.decodeOutput(codec.encodeOutput(draft), codec.bindingHash)).toEqual(draft);
});

it.each([true, false])("preserves independent perceived entity and opponent, including null: %s", async hasTarget => {
  const { codec, draft } = await fixture();
  draft.requests[0]!.perceivedEntityRef = hasTarget ? h("ref:entity:key") : null;
  draft.requests[0]!.difficulty = { kind: "opposed", targetRef: h("ref:entity:player"), ratingRef: h("ref:rating:resolve:player") };
  expect(codec.decodeOutput(codec.encodeOutput(draft), codec.bindingHash)).toEqual(draft);
});

it.each([
  ["unknown key", (wire: Record<string, unknown>) => { (wire.requests as Array<Record<string, unknown>>)[0]!.ratingKey = "kunknown"; }],
  ["legacy handle", (wire: Record<string, unknown>) => { (wire.requests as Array<Record<string, unknown>>)[0]!.ratingKey = "ref:rating:resolve:keeper"; }],
  ["missing task", (wire: Record<string, unknown>) => { wire.assessments = {}; }],
  ["wrong task", (wire: Record<string, unknown>) => { wire.assessments = { q999: Object.values(wire.assessments as object)[0] }; }],
  ["duplicate identity field", (wire: Record<string, unknown>) => { Object.assign(Object.values(wire.assessments as object)[0], { observerRef: "ref:entity:player" }); }],
  ["legacy evidence object", (wire: Record<string, unknown>) => { (Object.values(wire.assessments as object)[0] as { evidenceKeys: unknown[] }).evidenceKeys[1] = { key: "action_0", kind: "actor" }; }],
  ["separate copied value", (wire: Record<string, unknown>) => { Object.assign(Object.values(wire.assessments as object)[0], { value: { kind: "text", value: "closed" } }); }],
] as const)("rejects %s instead of normalizing it", async (_label, mutate) => {
  const { codec, draft } = await fixture(), wire = codec.encodeOutput(draft) as Record<string, unknown>;
  mutate(wire);
  expect(() => codec.decodeOutput(wire, codec.bindingHash)).toThrow();
});

it("rejects wrong reference uses, including an entity used as world evidence or a Rating", async () => {
  const { codec, draft } = await fixture();
  const wire = codec.encodeOutput(draft) as { requests: Array<{ basisKeys: string[]; ratingKey: string | null }> };
  wire.requests[0]!.basisKeys = [codec.keyFor("ref:entity:keeper")];
  expect(() => codec.decodeOutput(wire, codec.bindingHash)).toThrow();
  wire.requests[0]!.basisKeys = [codec.keyFor("ref:rating:resolve:keeper")];
  expect(() => codec.decodeOutput(wire, codec.bindingHash)).toThrow();
  wire.requests[0]!.basisKeys = [codec.keyFor("ref:fact:route")];
  wire.requests[0]!.ratingKey = codec.keyFor("ref:entity:keeper");
  expect(() => codec.decodeOutput(wire, codec.bindingHash)).toThrow();
});

it("rejects old output, wrong binding and mutated source even when all short keys exist", async () => {
  const { codec, draft, input } = await fixture(), wire = codec.encodeOutput(draft);
  expect(() => codec.decodeOutput(draft, codec.bindingHash)).toThrow();
  expect(() => codec.decodeOutput(wire, "different-request")).toThrow("binding changed");
  input.state.truth.facts.route!.value = { kind: "text", value: "closed" };
  expect(() => codec.decodeOutput(wire, codec.bindingHash)).toThrow("binding changed");
});

it("rejects a changed source request context", async () => {
  const { codec, draft, original } = await fixture(), wire = codec.encodeOutput(draft);
  (original.context as Record<string, unknown>).repair = { issues: ["different"] };
  expect(() => codec.decodeOutput(wire, codec.bindingHash)).toThrow("binding changed");
});

it("rejects a false canonical value and a changed physical snapshot even when each key is valid", async () => {
  const { codec, draft } = await fixture();
  const wire = codec.encodeOutput(draft);
  Object.assign(draft.assessments[0]!.evidence[0]!, { value: { kind: "text", value: "closed" } });
  expect(() => codec.encodeOutput(draft)).toThrow("value");
  const context = codec.request.context as { state: { canonicalTruth: { facts: Record<string, { snapshotKey: string; value: unknown }> } } };
  const snapshot = context.state.canonicalTruth.facts["ref:fact:route"]!;
  expect(snapshot.snapshotKey).toBe(codec.keyFor("ref:fact:route"));
  expect(snapshot.snapshotKey).toMatch(/^fact_/);
  snapshot.value = { kind: "text", value: "closed" };
  expect(() => codec.decodeOutput(wire, codec.bindingHash)).toThrow("binding changed");
});

it("rejects a displayed snapshot that differs from canonical state before a request is built", async () => {
  const { original, input } = await fixture();
  const context = original.context as { state: { canonicalTruth: { facts: Record<string, { value: unknown }> } } };
  context.state.canonicalTruth.facts["ref:fact:route"]!.value = { kind: "text", value: "closed" };
  expect(() => new PerceptionSelectionCodec(original, input)).toThrow("snapshot value differs");
});

it("rejects an incomplete source projection instead of exposing an undisplayed Fact or narrowing choices", async () => {
  const { original, input } = await fixture();
  const context = original.context as { state: { canonicalTruth: { facts: Record<string, unknown> } } };
  delete context.state.canonicalTruth.facts["ref:fact:route"];
  expect(() => new PerceptionSelectionCodec(original, input)).toThrow("fact snapshot absent from request");
});

it("rejects duplicate snapshot selection instead of silently deduplicating evidence", async () => {
  const { codec, draft } = await fixture();
  const wire = codec.encodeOutput(draft) as { assessments: Record<string, { evidenceKeys: string[] }> };
  wire.assessments.q0!.evidenceKeys.push(codec.keyFor("ref:fact:route"));
  expect(() => codec.decodeOutput(wire, codec.bindingHash)).toThrow("duplicate perception evidence");
});

it("preserves materialization, RNG and actual reaction-consumer eligibility through the real entry", async () => {
  const { codec, draft, input, scope } = await fixture();
  const decoded = codec.decodeOutput(codec.encodeOutput(draft), codec.bindingHash);
  const run = async (value: PerceptionAssessmentDraft) => {
    let calls = 0;
    const provider = new ScriptedModelProvider(withNoStimulusCompletion(() => ++calls === 1 ? validatePerceptionAssessment(input, value, contentHash(input.state)).diagnosticDirective : { kind: "done" }), undefined, false);
    const { modelAudit, ...result } = await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input, scope);
    expect(provider.requests).toHaveLength(2);
    expect(modelAudit.invocations).toHaveLength(2);
    return result;
  };
  const before = contentHash(input), original = await run(draft), selected = await run(decoded);
  expect(selected).toEqual(original);
  expect(successfulOnsetPerceptionChecks("keeper", "conceal", selected)).toEqual(successfulOnsetPerceptionChecks("keeper", "conceal", original));
  expect(contentHash(input)).toBe(before);
});
