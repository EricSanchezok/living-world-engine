import { withNoStimulusCompletion } from "../../testing/model-provider";
import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { OnsetPerceptionInput } from "../../algorithms/roles";
import { stepEfficiencyAlgorithmRef } from "../../../../scripts/operations/step-efficiency-playtest";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import type { StructuredModelRequest } from "../../models/model-provider";
import { ScriptedModelProvider, createTestModelCatalog, createTestModelRegistry, type ScriptedModelHandlerRequest } from "../../testing/model-provider";
import { selectTemporalBoundary } from "../temporal";
import { TruthEngine } from "../truth-engine";
import { PERCEPTION_RATING_CHOICES, PerceptionRatingChoiceCodec, perceptionRatingChoiceProvider, perceptionRatingChoiceRequest } from "../perception-rating-choices";

type Context = { perceptionRatingChoices: {
  ownedRatings: Array<{ key: string; actorRef: string; ratingRef: string }>;
  unmodifiedObservers: Array<{ key: string; actorRef: string }>;
}; state: { canonicalTruth: { entities: Record<string, { lifecycle: string }>; ratings: Record<string, { entityRef: string }> } } };

function canonicalCheck() {
  return { proposalKey: "notice-key", actorRef: "ref:entity:keeper", ratingRef: "ref:rating:resolve:keeper", targetRef: "ref:entity:key",
    difficulty: { kind: "opposed", targetRef: "ref:entity:player", ratingRef: "ref:rating:resolve:player", source: { kind: "rating", ref: "ref:rating:resolve:player" } },
    mode: "normal", stakes: "Whether the keeper notices the key concealed by the player before reacting.", visibility: "full",
    causes: [{ kind: "action", ref: "ref:action:conceal" }, { kind: "law", ref: "ref:law:time-passes" }] };
}

function wireCheck(context: unknown, unmodified = false) {
  const choices = (context as Context).perceptionRatingChoices;
  const c = canonicalCheck();
  const observerChoice = unmodified
    ? choices.unmodifiedObservers.find(row => row.actorRef === c.actorRef)!.key
    : choices.ownedRatings.find(row => row.actorRef === c.actorRef && row.ratingRef === c.ratingRef)!.key;
  const opposedChoice = choices.ownedRatings.find(row => row.actorRef === c.difficulty.targetRef && row.ratingRef === c.difficulty.ratingRef)!.key;
  const rest = Object.fromEntries(Object.entries(c).filter(([key]) => !["actorRef", "ratingRef", "difficulty"].includes(key)));
  return { ...rest, observerChoice, difficulty: { kind: "opposed", opposedChoice } };
}

function fixture(handler: (request: ScriptedModelHandlerRequest, call: number) => unknown, encoded = true, repairAttempts = 0) {
  let calls = 0;
  const provider = new ScriptedModelProvider(withNoStimulusCompletion(request => handler(request, ++calls)), undefined, false);
  const physical: StructuredModelRequest<unknown>[] = [];
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => { physical.push(request); return generate(request); };
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  const input: OnsetPerceptionInput = { definition, state, identityOwner: "perception-component", groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Conceal the key in my sleeve before the keeper sees it.",
      goal: "Hide the key", means: "Slip the key into my sleeve", targetIds: ["copper-key"] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const scope = { workloadId: "choice-world", batchId: "choice-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  return { provider, physical, input, scope, run: () => new TruthEngine(encoded ? perceptionRatingChoiceProvider(provider) : provider, { repairAttempts }).perceiveOnset(input, scope) };
}

it.each([false, true])("preserves actual checks, independent perceived target, RNG and source state (null=%s)", async unmodified => {
  const baseline = fixture((_r, call) => call === 1 ? { kind: "request_checks", requests: [{ ...canonicalCheck(), ...(unmodified ? { ratingRef: null } : {}) }] } : { kind: "done" }, false);
  const encoded = fixture((r, call) => call === 1 ? { kind: "request_checks", requests: [wireCheck(r.context, unmodified)] } : { kind: "done" });
  const before = contentHash(encoded.input);
  const b = await baseline.run(), c = await encoded.run();
  expect(c.requests).toEqual(b.requests);
  expect(c.checks).toEqual(b.checks);
  expect(c.rng).toEqual(b.rng);
  expect(c.requests[0]).toMatchObject({ actorId: "keeper", targetId: "key", ratingId: unmodified ? null : "resolve:keeper", dc: 12, modifier: unmodified ? 0 : 3 });
  expect(contentHash(encoded.input)).toBe(before);
  expect(encoded.provider.requests).toHaveLength(2);
  for (let i = 0; i < 2; i++) {
    const physical = encoded.physical[i]!, original = baseline.physical[i]!;
    const context = structuredClone(physical.context) as Record<string, unknown>;
    delete context.perceptionRatingChoices;
    expect(context).toEqual(original.context);
    expect(physical.schema).toBe(original.schema);
    expect(physical.promptVersion).toContain(PERCEPTION_RATING_CHOICES);
    expect(physical.wireJsonSchema).toBeDefined();
  }
});

it("enumerates every legal observer tuple, preserves null and round-trips every owned Rating", async () => {
  const f = fixture(() => ({ kind: "done" }), false); await f.run();
  const original = f.physical[0]!;
  const codec = new PerceptionRatingChoiceCodec(original.context);
  const choices = (codec.context as unknown as Context).perceptionRatingChoices;
  const truth = (original.context as Context).state.canonicalTruth;
  expect(choices.ownedRatings.map(row => [row.actorRef, row.ratingRef]).sort())
    .toEqual(Object.entries(truth.ratings).map(([ref, row]) => [row.entityRef, ref]).sort());
  expect(choices.unmodifiedObservers.map(row => row.actorRef).sort())
    .toEqual(Object.entries(truth.entities).filter(([, row]) => row.lifecycle === "active").map(([ref]) => ref).sort());
  for (const row of [...choices.ownedRatings, ...choices.unmodifiedObservers.map(row => ({ ...row, ratingRef: null }))]) {
    const check = { ...canonicalCheck(), actorRef: row.actorRef, ratingRef: row.ratingRef,
      difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:time-passes" } } };
    const output = { kind: "request_checks", requests: [check] };
    expect(codec.decodeOutput(codec.encodeOutput(output))).toEqual(output);
  }
  expect(codec.restoreContext()).toEqual(original.context);
  expect(() => codec.encodeOutput({ kind: "request_checks", requests: [{ ...canonicalCheck(), actorRef: "ref:entity:player" }] })).toThrow();
});

it.each(["forged", "legacy-fields", "numeric-injection"])("rejects %s without a check or source mutation", async mode => {
  const f = fixture(r => {
    const check = wireCheck(r.context);
    return { kind: "request_checks", requests: [{ ...check, ...(mode === "forged" ? { observerChoice: "aptitude_nonexistent" }
      : mode === "legacy-fields" ? { actorRef: "ref:entity:player", ratingRef: "ref:rating:resolve:keeper" } : { dc: 0 }) }] };
  });
  const before = contentHash(f.input);
  await expect(f.run()).rejects.toThrow();
  expect(f.provider.requests).toHaveLength(1);
  expect(contentHash(f.input)).toBe(before);
});

it("repairs a bad choice through the real loop with unchanged identities and no rejected draws", async () => {
  const clean = fixture((r, n) => n === 1 ? { kind: "request_checks", requests: [wireCheck(r.context)] } : { kind: "done" });
  const repaired = fixture((r, n) => n < 3 ? { kind: "request_checks", requests: [{ ...wireCheck(r.context), ...(n === 1 ? { observerChoice: "missing" } : {}) }] } : { kind: "done" }, true, 1);
  const a = await clean.run(), b = await repaired.run();
  expect(b.requests).toEqual(a.requests); expect(b.checks).toEqual(a.checks); expect(b.rng).toEqual(a.rng);
  const first = repaired.provider.requests[0]!.context as Context, second = repaired.provider.requests[1]!.context as Context;
  expect(second.perceptionRatingChoices.ownedRatings).toEqual(first.perceptionRatingChoices.ownedRatings);
  expect(second.state.canonicalTruth).toEqual(first.state.canonicalTruth);
});

it.each(["missing-rating", "inactive-observer", "source-drift", "encoded-drift", "wrong-binding"])("rejects incomplete or stale binding: %s", async mode => {
  const f = fixture(() => ({ kind: "done" }), false); await f.run();
  const source = structuredClone(f.physical[0]!.context) as Context;
  if (mode === "missing-rating") {
    delete source.state.canonicalTruth.ratings["ref:rating:resolve:keeper"];
    expect(() => new PerceptionRatingChoiceCodec(source)).toThrow(); return;
  }
  if (mode === "inactive-observer") source.state.canonicalTruth.entities["ref:entity:keeper"]!.lifecycle = "retired";
  const codec = new PerceptionRatingChoiceCodec(source);
  if (mode === "inactive-observer") {
    expect(() => codec.encodeOutput({ kind: "request_checks", requests: [canonicalCheck()] })).toThrow(); return;
  }
  if (mode === "source-drift") source.state.canonicalTruth.entities["ref:entity:keeper"]!.lifecycle = "retired";
  if (mode === "encoded-drift") (codec.context.state as Context["state"]).canonicalTruth.entities["ref:entity:keeper"]!.lifecycle = "retired";
  expect(() => codec.decodeOutput({ kind: "done" }, mode === "wrong-binding" ? "wrong" : codec.bindingHash)).toThrow("binding changed");
});

it("uses the real HTTP codec boundary and retains usage, raw choice and canonical output", async () => {
  const f = fixture(() => ({ kind: "done" }), false); await f.run();
  const source = f.physical[0]!, codec = new PerceptionRatingChoiceCodec(source.context);
  const raw = { kind: "request_checks", requests: [wireCheck(codec.context)] };
  const catalog = createTestModelCatalog(["truth-deepseek"]);
  let body = "";
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ id: "rating-choice-test", model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(raw) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const result = await perceptionRatingChoiceProvider(gateway).generateStructured({ ...source, profileId: "truth-deepseek" });
  expect(result.value).toEqual({ kind: "request_checks", requests: [canonicalCheck()] });
  expect(body).toContain("observerChoice"); expect(body).toContain("opposedChoice");
  expect(result.audit.invocations[0]!.rawOutputHash).toBe(contentHash(raw));
  expect(result.audit.invocations[0]!.normalizedOutputHash).toBe(contentHash(result.value));
  expect(result.audit.invocations[0]!.tokenUsage).toMatchObject({ input: 100, output: 20 });
  expect(perceptionRatingChoiceRequest({ ...source, role: "truth-resolution" })).toEqual({ ...source, role: "truth-resolution" });
});

it("pins only the optional perception configuration and preserves the default", () => {
  const baseline = stepEfficiencyAlgorithmRef(), candidate = stepEfficiencyAlgorithmRef({ perceptionRatingChoices: true });
  expect(baseline.children.reactionResolution!.children.onsetPerception!.config.ratingChoices).toBeUndefined();
  expect(candidate.children.reactionResolution!.children.onsetPerception!.config.ratingChoices).toBe(PERCEPTION_RATING_CHOICES);
  expect(candidate.manifestHash).not.toBe(baseline.manifestHash);
  expect(candidate.children.actionCompilation).toEqual(baseline.children.actionCompilation);
});
