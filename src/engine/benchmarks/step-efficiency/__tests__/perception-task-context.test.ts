import path from "node:path";
import { expect, it } from "vitest";
import type { OnsetPerceptionInput } from "../../../algorithms/roles";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import type { StructuredModelProvider, StructuredModelRequest } from "../../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry, ScriptedModelProvider } from "../../../testing/model-provider";
import { loadWorldScript } from "../../../../script/world-loader";
import { buildPerceptionWorkItems, perceptionAssessmentRequest } from "../perception-assessment";
import { PERCEPTION_TASK_CONTEXT, perceptionTaskContextRequest } from "../perception-task-context";

const check = (ratingRef: string | null = "ref:rating:resolve:keeper") => ({ proposalKey: "notice-key", actorRef: "ref:entity:keeper", ratingRef,
  targetRef: "ref:entity:key", difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:time-passes" } },
  mode: "normal", visibility: "full", stakes: "Whether the keeper notices the key being concealed before reacting.",
  causes: [{ kind: "action", ref: "ref:action:conceal" }, { kind: "law", ref: "ref:law:time-passes" }] });

function fixture() {
  const catalog = createTestModelCatalog();
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: catalog });
  definition.modelProfiles.perception = "truth-deepseek";
  const state = structuredClone(definition.initialState);
  const input: OnsetPerceptionInput = { definition, state, identityOwner: "task-context-test", groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Conceal the key in my sleeve.",
      goal: "Hide the key", means: "Slide it into a sleeve", targetIds: ["copper-key"] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const scope = { workloadId: "task-context-world", batchId: "task-context-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  return { input, scope, catalog };
}

async function requestFixture() {
  const f = fixture(), provider = new ScriptedModelProvider(() => ({ kind: "done" }), f.catalog, false);
  let request!: StructuredModelRequest<unknown>;
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = r => { request = r; return generate(r); };
  await new TruthEngine(provider).perceiveOnset(f.input, f.scope);
  return { ...f, request };
}

it.each([null, "ref:rating:resolve:keeper"])("preserves real HTTP outputs, repair, committed checks, RNG and source with aptitude %s", async aptitude => {
  const runs: Array<{ result: Awaited<ReturnType<TruthEngine["perceiveOnset"]>>; requests: StructuredModelRequest<unknown>[] }> = [];
  for (const candidate of [false, true]) {
    const f = fixture(), before = contentHash(f.input), bodies: string[] = [], requests: StructuredModelRequest<unknown>[] = [], audits: unknown[] = [];
    const gateway = createModelGateway(f.catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(f.catalog), maxTransportAttempts: 1,
      fetchForAccount: () => async (_url, init) => {
        bodies.push(String(init?.body));
        const value = bodies.length === 3 ? { kind: "done" } : { kind: "request_checks", requests: [check(bodies.length === 1 ? "ref:rating:resolve:player" : aptitude)] };
        return new Response(JSON.stringify({ id: `task-${bodies.length}`, model: "scripted:truth-deepseek",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
      } });
    const provider: StructuredModelProvider = { catalog: gateway.catalog,
      availableProfileSummaries: role => gateway.availableProfileSummaries(role),
      assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: async r => {
      const adapted = candidate ? perceptionTaskContextRequest(r, f.input) : r; requests.push(adapted);
      const result = await gateway.generateStructured(adapted); audits.push(result.audit); return result;
    } };
    const result = await new TruthEngine(provider, { repairAttempts: 1 }).perceiveOnset(f.input, f.scope);
    expect(bodies).toHaveLength(3); expect(contentHash(f.input)).toBe(before);
    expect(audits).toHaveLength(3);
    if (candidate) {
      for (const body of bodies) expect(body).toContain("Assigned perception source context");
      for (const request of requests) expect(request.promptVersion).toContain(PERCEPTION_TASK_CONTEXT);
      expect(requests[1]!.context).toMatchObject({ repair: { issues: [{ code: "perception.actor_rating_owner" }] } });
      expect(requests[2]!.context).toMatchObject({ state: { committedCheckRequests: [expect.anything()], checkResults: [expect.anything()] } });
    }
    runs.push({ result, requests });
  }
  expect(runs[1]!.result.requests).toEqual(runs[0]!.result.requests);
  expect(runs[1]!.result.checks).toEqual(runs[0]!.result.checks);
  expect(runs[1]!.result.rng).toEqual(runs[0]!.result.rng);
  runs[1]!.requests.forEach((request, i) => {
    expect(request.context).toEqual(runs[0]!.requests[i]!.context);
    expect(request.schema).toBe(runs[0]!.requests[i]!.schema);
  });
});

it("reuses the assessment index exactly while keeping the complete canonical directive and explicit selections", async () => {
  const { input, request } = await requestFixture(), originalHash = contentHash(request.context);
  const candidate = perceptionTaskContextRequest(request, input);
  const workItems = buildPerceptionWorkItems(request, input);
  expect((perceptionAssessmentRequest(request, input).context as { perceptionWorkItems: unknown }).perceptionWorkItems).toEqual(workItems);
  expect(workItems[0]).toMatchObject({ observerRef: "ref:entity:keeper", sourceActorRef: "ref:entity:player",
    sourceAction: { rawText: input.actions[0]!.rawText, goal: input.actions[0]!.goal, means: input.actions[0]!.means },
    observerRatings: [{ ratingRef: "ref:rating:resolve:keeper", value: 3 }] });
  expect(workItems[0]!.sourceActorPlacementChain.map(row => row.entityRef)).toEqual(["ref:entity:player", "ref:entity:courtyard"]);
  const raw = { kind: "request_checks", requests: [check("ref:rating:resolve:player")] };
  expect(candidate.preprocessOutput!(raw)).toEqual({ value: raw, symbolRepairs: [] });
  expect(candidate.context).toBe(request.context); expect(contentHash(request.context)).toBe(originalHash);
  expect(candidate.schemaName).toBe(request.schemaName); expect(candidate.system).toBe(request.system);
  expect(candidate.wireJsonSchema).toBe(request.wireJsonSchema); expect(candidate.userPrompt).toBe(request.userPrompt);
});

it.each(["truth", "assignment", "action", "revision"])("refuses divergent %s source before dispatch", async field => {
  const { input, request } = await requestFixture();
  if (field === "truth") input.state.truth.ratings["resolve:keeper"]!.value++;
  if (field === "assignment") input.perceptionTargets = [];
  if (field === "action") input.actions[0]!.rawText = "Different attempt";
  if (field === "revision") input.state.revision++;
  expect(() => perceptionTaskContextRequest(request, input)).toThrow();
});

it.each(["input", "context"])("refuses %s drift after dispatch without rewriting a result", async field => {
  const { input, request } = await requestFixture(), candidate = perceptionTaskContextRequest(request, input);
  if (field === "input") input.state.truth.ratings["resolve:keeper"]!.value++;
  else (request.context as { repair: unknown }).repair = { altered: true };
  expect(() => candidate.preprocessOutput!({ kind: "done" })).toThrow("source changed");
});

it("rejects duplicate postludes and unfocused source, preserving empty assignments and unrelated roles", async () => {
  const { input, request } = await requestFixture();
  const candidate = perceptionTaskContextRequest(request, input);
  expect(() => perceptionTaskContextRequest(candidate, input)).toThrow("postlude");
  expect(() => perceptionTaskContextRequest({ ...request, jsonObjectPostlude: "existing" }, input)).toThrow("postlude");
  expect(perceptionTaskContextRequest({ ...request, role: "truth-resolution" }, input).jsonObjectPostlude).toBeUndefined();
  const context = structuredClone(request.context) as { task: { assignment: { perceptionTargets: unknown[] } } };
  context.task.assignment.perceptionTargets = []; input.perceptionTargets = [];
  expect(perceptionTaskContextRequest({ ...request, context }, input).jsonObjectPostlude).toContain('"workItems":[]');
  delete input.perceptionTargets;
  expect(() => perceptionTaskContextRequest(request, input)).toThrow("explicit pair assignments");
});
