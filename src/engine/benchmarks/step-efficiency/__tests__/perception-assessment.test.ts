import { withNoStimulusCompletion } from "../../../testing/model-provider";
import path from "node:path";
import { expect, it } from "vitest";
import type { OnsetPerceptionInput } from "../../../algorithms/roles";
import type { FactValue } from "../../../contracts/model";
import { existingReferenceHandleSchema, proposalKeySchema } from "../../../contracts/model-context";
import { createTruthReferenceResolver } from "../../../contracts/prompts";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { successfulOnsetPerceptionChecks } from "../../../mechanics/onset-reaction-basis";
import type { StructuredModelRequest } from "../../../models/model-provider";
import { loadPromptAsset } from "../../../prompts";
import { contentHash } from "../../../models/model-audit";
import { ScriptedModelProvider, type ScriptedModelHandler } from "../../../testing/model-provider";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { loadWorldScript } from "../../../../script/world-loader";
import { validateSimulationState } from "../../../runtime/transaction";
import { perceptionAssessmentRequest, perceptionPlacementChain, validatePerceptionAssessment, validatePerceptionAssessmentInput, type PerceptionAssessmentDraft } from "../perception-assessment";

const h = (value: string) => existingReferenceHandleSchema.parse(value);
const key = (value: string) => proposalKeySchema.parse(value);

function fixture(handler: ScriptedModelHandler = () => ({ kind: "done" })) {
  const provider = new ScriptedModelProvider(withNoStimulusCompletion(handler), undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  state.truth.facts.route = { id: "route", subjectId: state.agents.player!.entityId, predicate: "access", value: { kind: "text", value: "open" },
    description: "The current access condition.", access: { kind: "private" }, provenance: [{ kind: "world_seed", id: state.worldHash }] };
  validateSimulationState(state, false, true);
  const input: OnsetPerceptionInput = { definition, state, identityOwner: "assessment-test", groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision,
      rawText: "Conceal the copper key and remain by the gate.", goal: "Hide the key", means: "Slide it into a sleeve", targetIds: ["copper-key"] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const scope = { workloadId: "assessment-world", batchId: "assessment-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  return { input, provider, scope, run: () => new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input, scope) };
}

function draft(verdict: PerceptionAssessmentDraft["assessments"][number]["verdict"] = "visible"): PerceptionAssessmentDraft {
  const checkRequired = verdict === "check_required";
  return { assessments: [{ observerRef: h("ref:entity:keeper"), sourceActionRef: h("ref:action:conceal"),
    evidence: [{ kind: "fact", ref: h("ref:fact:route"), value: { kind: "text", value: "open" } }],
    verdict, checkKeys: checkRequired ? [key("notice-key")] : [] }],
    requests: checkRequired ? [{ proposalKey: key("notice-key"), perceivedEntityRef: h("ref:entity:key"), ratingRef: h("ref:rating:resolve:keeper"),
      difficulty: { kind: "environment", band: "easy", source: { kind: "fact", ref: h("ref:fact:route") } }, mode: "normal", visibility: "result_only",
      basisRefs: [{ kind: "fact", ref: h("ref:fact:route") }] }] : [] };
}

it.each(["visible", "no_route", "insufficient_evidence"] as const)("retains %s without inventing a check or claiming a production result", verdict => {
  const { input } = fixture(), source = contentHash(input), value = draft(verdict);
  const admitted = validatePerceptionAssessment(input, value, contentHash(input.state));
  expect(admitted.draft).toEqual(value);
  expect(admitted.diagnosticDirective).toEqual({ kind: "done" });
  expect(admitted.hasUnknown).toBe(verdict === "insufficient_evidence");
  expect(contentHash(input)).toBe(source);
});

it.each<FactValue>([
  { kind: "text", value: "No light or sound reaches the keeper." }, { kind: "number", value: 0 },
  { kind: "boolean", value: false }, { kind: "entity", entityId: "key" }, { kind: "none" },
])("matches typed Fact evidence exactly: $kind", value => {
  const { input } = fixture(), response = draft();
  input.state.truth.facts.route!.value = value;
  response.assessments[0]!.evidence = [{ kind: "fact", ref: h("ref:fact:route"),
    value: value.kind === "entity" ? { kind: "entity", entityRef: h("ref:entity:key") } : value }];
  expect(validatePerceptionAssessment(input, response, contentHash(input.state)).hasUnknown).toBe(false);
  input.state.truth.facts.route!.value = { kind: "text", value: "different current state" };
  expect(() => validatePerceptionAssessment(input, response, contentHash(input.state))).toThrow("fact value mismatch");
});

it.each([
  ["missing pair", (v: PerceptionAssessmentDraft) => { v.assessments = []; }],
  ["duplicate pair", (v: PerceptionAssessmentDraft) => { v.assessments.push(structuredClone(v.assessments[0]!)); }],
  ["wrong observer", (v: PerceptionAssessmentDraft) => { v.assessments[0]!.observerRef = h("ref:entity:player"); }],
  ["wrong action", (v: PerceptionAssessmentDraft) => { v.assessments[0]!.sourceActionRef = h("ref:action:unassigned"); }],
  ["empty evidence", (v: PerceptionAssessmentDraft) => { v.assessments[0]!.evidence = []; }],
  ["invented fact", (v: PerceptionAssessmentDraft) => { v.assessments[0]!.evidence[0]!.ref = h("ref:fact:missing"); }],
  ["duplicated evidence", (v: PerceptionAssessmentDraft) => { v.assessments[0]!.evidence.push(structuredClone(v.assessments[0]!.evidence[0]!)); }],
  ["missing check", (v: PerceptionAssessmentDraft) => { v.requests = []; }],
  ["unused check", (v: PerceptionAssessmentDraft) => { v.requests.push({ ...v.requests[0]!, proposalKey: key("unused") }); }],
  ["duplicate check", (v: PerceptionAssessmentDraft) => { v.requests.push(structuredClone(v.requests[0]!)); }],
  ["duplicate key", (v: PerceptionAssessmentDraft) => { v.assessments[0]!.checkKeys.push(key("notice-key")); }],
  ["terminal with check", (v: PerceptionAssessmentDraft) => { v.assessments[0]!.verdict = "visible"; }],
  ["missing check world basis", (v: PerceptionAssessmentDraft) => { v.requests[0]!.basisRefs = []; }],
  ["basis absent from assessment", (v: PerceptionAssessmentDraft) => { v.requests[0]!.basisRefs = [{ kind: "fact", ref: h("ref:fact:missing") }]; }],
  ["duplicate check basis", (v: PerceptionAssessmentDraft) => { v.requests[0]!.basisRefs.push(v.requests[0]!.basisRefs[0]!); }],
] as const)("rejects %s before check materialization", (_label, change) => {
  const { input } = fixture(), response = draft("check_required"), source = contentHash(input);
  change(response);
  expect(() => validatePerceptionAssessment(input, response, contentHash(input.state))).toThrow();
  expect(contentHash(input)).toBe(source);
});

it("rejects a stale source binding without treating unchanged copied values as sufficient", () => {
  const { input } = fixture(), hash = contentHash(input.state);
  input.state.revision++;
  expect(() => validatePerceptionAssessment(input, draft(), hash)).toThrow("state binding");
});

it("indexes the full current containment chain without turning shared ancestry into visibility", () => {
  const { input } = fixture(), before = contentHash(input);
  const resolver = createTruthReferenceResolver({ ...input, checkRequests: [] });
  const chain = perceptionPlacementChain(input, "key", resolver);
  expect(chain.map(row => [row.entityRef, row.containerEntityRef])).toEqual([
    ["ref:entity:key", "ref:entity:player"], ["ref:entity:player", "ref:entity:courtyard"], ["ref:entity:courtyard", null],
  ]);
  expect(chain[0]).toMatchObject({ placementRef: "ref:placement:key", name: input.state.truth.entities.key!.name,
    kind: input.state.truth.entities.key!.kind, description: input.state.truth.entities.key!.description });
  expect(contentHash(input)).toBe(before);
});

it.each(["cycle", "missing entity", "missing edge"])("fails a malformed spatial source instead of returning a partial chain: %s", corruption => {
  const { input } = fixture(), resolver = createTruthReferenceResolver({ ...input, checkRequests: [] });
  if (corruption === "cycle") input.state.truth.placements.courtyard = "key";
  if (corruption === "missing entity") delete input.state.truth.entities.courtyard;
  if (corruption === "missing edge") delete input.state.truth.placements.courtyard;
  expect(() => perceptionPlacementChain(input, "key", resolver)).toThrow(/cycle|missing/);
});

it.each([
  ["canonical ID in local target field", (input: OnsetPerceptionInput) => { input.actions[0]!.targetIds = ["key"]; }],
  ["unknown actor", (input: OnsetPerceptionInput) => { input.actions[0]!.actorId = "traveler"; }],
  ["wrong revision", (input: OnsetPerceptionInput) => { input.actions[0]!.baseRevision++; }],
  ["duplicate source action", (input: OnsetPerceptionInput) => { input.actions.push(structuredClone(input.actions[0]!)); }],
] as const)("rejects invalid source input before HTTP: %s", (_label, change) => {
  const { input, provider } = fixture();
  change(input);
  expect(() => validatePerceptionAssessmentInput(input)).toThrow();
  expect(provider.requests).toHaveLength(0);
});

it.each([{ canonicalEntityIds: [] }, { canonicalEntityIds: ["key", "player"] }])("preserves local targets with canonical bindings $canonicalEntityIds", ({ canonicalEntityIds }) => {
  const { input } = fixture();
  input.state.agents.player!.bindings["copper-key"]!.canonicalEntityIds = canonicalEntityIds;
  const hash = contentHash(input);
  expect(() => validatePerceptionAssessmentInput(input)).not.toThrow();
  expect(input.actions[0]!.targetIds).toEqual(["copper-key"]);
  expect(contentHash(input)).toBe(hash);
});

it("allows a single grounded check to cover multiple source actions for the same observer", () => {
  const { input } = fixture(), response = draft("check_required");
  input.actions.push({ ...input.actions[0]!, id: "depart", rawText: "Leave through the gate." });
  input.perceptionTargets = [...input.perceptionTargets!, { observerId: "keeper", sourceActionId: "depart" }];
  response.assessments.push({ ...structuredClone(response.assessments[0]!), sourceActionRef: h("ref:action:depart") });
  const admitted = validatePerceptionAssessment(input, response, contentHash(input.state));
  expect(admitted.draft.requests).toHaveLength(1);
  expect(admitted.diagnosticDirective.kind === "request_checks" && admitted.diagnosticDirective.requests[0]!.causes)
    .toEqual([{ kind: "action", ref: "ref:action:conceal" }, { kind: "action", ref: "ref:action:depart" }, { kind: "fact", ref: "ref:fact:route" }]);
});

it("preserves the actual full context and exercises unchanged check numbers and RNG through the real perception entry", async () => {
  let calls = 0;
  const f = fixture(() => ++calls === 1
    ? validatePerceptionAssessment(f.input, draft("check_required"), contentHash(f.input.state)).diagnosticDirective
    : { kind: "done" });
  const source = contentHash(f.input);
  let captured: StructuredModelRequest<unknown> | undefined;
  const generate = f.provider.generateStructured.bind(f.provider);
  f.provider.generateStructured = async request => { captured ??= request; return generate(request); };
  const result = await f.run();
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({ actorId: "keeper", targetId: "key", dc: 10, modifier: 3 });
  expect(result.checks).toHaveLength(1);
  expect(result.rng.draws).toBe(f.input.state.truth.rng.draws + 1);
  expect(contentHash(f.input)).toBe(source);
  const actual = captured!, adapted = perceptionAssessmentRequest(actual, f.input);
  const originalData = { ...actual.context as Record<string, unknown> }, candidateData = { ...adapted.context as Record<string, unknown> };
  delete originalData.roleContract;
  delete candidateData.roleContract;
  expect(candidateData.perceptionWorkItems).toMatchObject([{ observerRef: "ref:entity:keeper", sourceActorRef: "ref:entity:player",
    sourceAction: { actionRef: "ref:action:conceal", rawText: f.input.actions[0]!.rawText, goal: f.input.actions[0]!.goal, means: f.input.actions[0]!.means,
      targetRefs: ["ref:local_entity:player::copper-key"] },
    observerRatings: [{ ratingRef: "ref:rating:resolve:keeper", value: 3 }] }]);
  delete candidateData.perceptionWorkItems;
  expect(candidateData).toEqual(originalData);
  expect(adapted.profileId).toBe(actual.profileId);
  expect(adapted.subjectId).toBe(actual.subjectId);
  expect(adapted.schemaName).toBe("truth_perception_assessment_probe");
  expect(adapted.system).toContain("insufficient_evidence");
  const sharedSystem = actual.system.replace(loadPromptAsset("system/truth-perception.md"), "");
  expect(sharedSystem).toContain("## Semantic protocol");
  expect(adapted.system.endsWith(sharedSystem)).toBe(true);
  const stale = structuredClone(f.input);
  stale.actions[0]!.rawText = "A different attempt";
  expect(() => perceptionAssessmentRequest(actual, stale)).toThrow("differs from the actual request");
  stale.actions = f.input.actions;
  stale.state.truth.elapsedSeconds++;
  expect(() => perceptionAssessmentRequest(actual, stale)).toThrow("differs from the actual request");
});

it("keeps source-action evidence distinct from the perceived entity and preserves every check field", () => {
  const { input } = fixture(), value = draft("check_required");
  value.assessments[0]!.evidence.push({ kind: "action", ref: h("ref:action:conceal") });
  const accepted = validatePerceptionAssessment(input, value, contentHash(input.state));
  const { perceivedEntityRef, basisRefs, ...check } = value.requests[0]!;
  if (accepted.diagnosticDirective.kind !== "request_checks") throw new Error("missing check");
  expect(accepted.diagnosticDirective.requests[0]).toMatchObject({ ...check, targetRef: perceivedEntityRef,
    actorRef: "ref:entity:keeper", causes: [{ kind: "action", ref: "ref:action:conceal" }, ...basisRefs] });
  expect(accepted.diagnosticDirective.requests[0]!.stakes).toContain("observer ref:entity:keeper");
  expect(accepted.diagnosticDirective.requests[0]!.stakes).toContain("onset of source action(s) ref:action:conceal at world time 0 seconds");
  value.requests[0]!.perceivedEntityRef = h("ref:action:conceal");
  expect(() => validatePerceptionAssessment(input, value, contentHash(input.state))).toThrow();
});

it.each([{ actorRef: "ref:entity:player" }, { stakes: "Whether the document is well written" },
  { causes: [{ kind: "action", ref: "ref:action:unassigned" }] }])("rejects a supplied duplicate check question field: %o", legacy => {
  const { input } = fixture(), value = draft("check_required");
  expect(() => validatePerceptionAssessment(input, { ...value, requests: [{ ...value.requests[0], ...legacy }] }, contentHash(input.state))).toThrow();
});

it("rejects one check shared across different observers without selecting a preferred observer", () => {
  const { input } = fixture(), value = draft("check_required");
  input.actions.push({ ...input.actions[0]!, id: "keeper-act", actorId: "keeper", targetIds: [] });
  input.perceptionTargets = [...input.perceptionTargets!, { observerId: "player", sourceActionId: "keeper-act" }];
  value.assessments.push({ ...structuredClone(value.assessments[0]!), observerRef: h("ref:entity:player"), sourceActionRef: h("ref:action:keeper-act") });
  expect(() => validatePerceptionAssessment(input, value, contentHash(input.state))).toThrow("different observers");
});

it("carries selected evidence into the actual onset consumer and respects failed or mismatched checks", async () => {
  let calls = 0;
  const f = fixture(() => ++calls === 1
    ? validatePerceptionAssessment(f.input, draft("check_required"), contentHash(f.input.state)).diagnosticDirective
    : { kind: "done" });
  const result = await f.run(), successful = { ...result, checks: result.checks.map(check => ({ ...check, succeeded: true })) };
  const basis = successfulOnsetPerceptionChecks("keeper", "conceal", successful);
  expect(basis.map(check => check.id)).toEqual(result.requests.map(check => check.id));
  expect(basis[0]!.causes).toEqual([{ kind: "action", id: "conceal" }, { kind: "fact", id: "route" }]);
  expect(successfulOnsetPerceptionChecks("player", "conceal", successful)).toEqual([]);
  expect(successfulOnsetPerceptionChecks("keeper", "different-action", successful)).toEqual([]);
  expect(successfulOnsetPerceptionChecks("keeper", "conceal", { ...successful,
    checks: result.checks.map(check => ({ ...check, succeeded: false })) })).toEqual([]);
  expect(successfulOnsetPerceptionChecks("keeper", "conceal", { ...successful, checks: [] })).toEqual([]);
  expect(successfulOnsetPerceptionChecks("keeper", "conceal", { ...successful,
    requests: result.requests.map(check => ({ ...check, causes: check.causes.filter(cause => cause.kind === "action") })) })).toEqual([]);
});

it("preserves null perceived entities and rejects the old ambiguous field", () => {
  const { input } = fixture(), value = draft("check_required");
  value.requests[0]!.perceivedEntityRef = null;
  const admitted = validatePerceptionAssessment(input, value, contentHash(input.state));
  expect(admitted.diagnosticDirective.kind === "request_checks" && admitted.diagnosticDirective.requests[0]!.targetRef).toBeNull();
  const { perceivedEntityRef: targetRef, ...check } = value.requests[0]!;
  expect(() => validatePerceptionAssessment(input, { ...value, requests: [{ ...check, targetRef }] }, contentHash(input.state))).toThrow();
});

it.each([true, false])("derives only the selected opposed Rating source, without repairing ownership: valid=%s", async valid => {
  const value = draft("check_required");
  value.requests[0]!.difficulty = { kind: "opposed", targetRef: h("ref:entity:player"),
    ratingRef: h(valid ? "ref:rating:resolve:player" : "ref:rating:resolve:keeper") };
  let calls = 0;
  const f = fixture(() => ++calls === 1
    ? validatePerceptionAssessment(f.input, value, contentHash(f.input.state)).diagnosticDirective
    : { kind: "done" });
  const hash = contentHash(f.input), admitted = validatePerceptionAssessment(f.input, value, contentHash(f.input.state));
  expect(admitted.diagnosticDirective.kind === "request_checks" && admitted.diagnosticDirective.requests[0]!.difficulty)
    .toEqual({ ...value.requests[0]!.difficulty, source: { kind: "rating", ref: value.requests[0]!.difficulty.ratingRef } });
  if (valid) {
    const result = await f.run();
    expect(result.requests[0]).toMatchObject({ actorId: "keeper", targetId: "key", dc: 12, modifier: 3 });
    expect(result.checks).toHaveLength(1);
  } else {
    await expect(f.run()).rejects.toThrow("rating");
    expect(f.provider.requests).toHaveLength(1);
  }
  expect(contentHash(f.input)).toBe(hash);
  const requests = [{ ...value.requests[0], difficulty: { ...value.requests[0]!.difficulty, source: { kind: "fact", ref: h("ref:fact:route") } } }];
  expect(() => validatePerceptionAssessment(f.input, { ...value, requests }, contentHash(f.input.state))).toThrow();
});

it("fails the real entry before any committed check when selected Fact evidence disagrees", async () => {
  const value = draft("check_required");
  value.assessments[0]!.evidence = [{ kind: "fact", ref: h("ref:fact:route"), value: { kind: "text", value: "invented" } }];
  const f = fixture(() => validatePerceptionAssessment(f.input, value, contentHash(f.input.state)).diagnosticDirective);
  const source = contentHash(f.input);
  await expect(f.run()).rejects.toThrow("fact value mismatch");
  expect(f.provider.requests).toHaveLength(1);
  expect(contentHash(f.input)).toBe(source);
});
