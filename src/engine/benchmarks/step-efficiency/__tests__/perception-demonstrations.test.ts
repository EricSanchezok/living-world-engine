import path from "node:path";
import { expect, it } from "vitest";
import type { OnsetPerceptionInput } from "../../../algorithms/roles";
import { perceptionDirectiveSchema } from "../../../contracts/llm-schemas";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import { ModelSemanticRepairError, type StructuredModelProvider, type StructuredModelRequest } from "../../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry } from "../../../testing/model-provider";
import { loadWorldScript } from "../../../../script/world-loader";
import { PERCEPTION_DEMONSTRATIONS_TEXT, perceptionDemonstrationsRequest, verifyOnlyPerceptionDemonstrationsAdded } from "../perception-demonstrations";

it("keeps every authored demonstration in the original directive schema, with positive, mixed and required-check cases", () => {
  const outputs = [...PERCEPTION_DEMONSTRATIONS_TEXT.matchAll(/```json\n([^\n]+)\n```/gu)]
    .map(match => perceptionDirectiveSchema.parse(JSON.parse(match[1]!)));
  expect(outputs).toHaveLength(8);
  expect(outputs.filter(output => output.kind === "request_checks")).toHaveLength(1);
  expect(outputs.filter(output => output.kind === "done" && output.reports.some(row => row.kind === "perceived"))).toHaveLength(4);
  expect(outputs[0]).toMatchObject({ kind: "done", reports: [{ kind: "perceived" }, { kind: "no_stimulus" }] });
  expect(outputs[7]).toMatchObject({ kind: "done", reports: [{ kind: "no_stimulus", checkRefs: ["ref:check:notice-sleeve"] }] });
});

it.each(["no-stimulus", "perceived", "check", "failed-check-bypass", "foreign-local"])(
  "preserves the real gateway and TruthEngine boundary for %s", async mode => {
    const catalog = createTestModelCatalog();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: catalog });
    const state = structuredClone(definition.initialState);
    const input: OnsetPerceptionInput = { definition, state, identityOwner: "demonstrations-test", groundings: [],
      actions: [{ id: "speak", actorId: "player", baseRevision: state.revision, rawText: "Ask the keeper aloud about the key.", goal: "Ask about the key", means: null, targetIds: [] }],
      perceptionTargets: [{ observerId: "keeper", sourceActionId: "speak" }],
      temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
    const before = contentHash(input), bodies: unknown[][] = [];
    const outcomes: Array<Awaited<ReturnType<TruthEngine["perceiveOnset"]>> | null> = [];
    for (const candidate of [false, true]) {
      const physical: unknown[] = [], requests: StructuredModelRequest<unknown>[] = [];
      const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
        fetchForAccount: () => async (_url, init) => {
          physical.push(JSON.parse(String(init?.body)));
          const current = requests.at(-1)!.context as { state: { committedCheckRequests: Array<{ checkRef: string }> } };
          const checks = current.state.committedCheckRequests.map(check => check.checkRef);
          const report = { targetIndex: 0, reason: "The observer's present access is supported by this source.",
            evidence: [{ kind: "entity", ref: "ref:entity:player" }], checkRefs: mode === "failed-check-bypass" ? [] : checks };
          const stimulus = { summary: "You hear a question about the key.", introductions: [], sourceEventRefs: [],
            apparentClaims: mode === "foreign-local" ? [{ subjectRef: "ref:local_entity:player::self", predicate: "speaking",
              value: { kind: "text", value: "asking a question" }, description: "The speaker asks about the key." }] : [] };
          const output = ["check", "failed-check-bypass"].includes(mode) && physical.length === 1
            ? { kind: "request_checks", requests: [{ proposalKey: "notice-question", actorRef: "ref:entity:keeper", targetRef: "ref:entity:player", ratingRef: null,
              difficulty: { kind: "environment", band: mode === "check" ? "trivial" : "extreme", source: { kind: "law", ref: "ref:law:time-passes" } },
              mode: "normal", stakes: "Whether the keeper notices the quiet question at onset.", visibility: "full",
              causes: [{ kind: "action", ref: "ref:action:speak" }, { kind: "law", ref: "ref:law:time-passes" }] }] }
            : { kind: "done", reports: [{ ...report, kind: mode === "no-stimulus" ? "no_stimulus" : "perceived",
              ...(mode === "no-stimulus" ? {} : { stimulus }) }] };
          perceptionDirectiveSchema.parse(output);
          return new Response(JSON.stringify({ id: "demonstrations-test", model: "scripted:truth-deepseek",
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json" } });
        } });
      const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role), assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
        generateStructured: request => {
          requests.push(request);
          const adapted = candidate ? perceptionDemonstrationsRequest(request) : request;
          expect(adapted.context).toBe(request.context); expect(adapted.schema).toBe(request.schema);
          expect(adapted.wireJsonSchema).toBe(request.wireJsonSchema); expect(adapted.userPrompt).toBe(request.userPrompt);
          expect(adapted.preprocessOutput).toBe(request.preprocessOutput);
          if (candidate) expect(() => perceptionDemonstrationsRequest(adapted)).toThrow("unadapted");
          return gateway.generateStructured(adapted);
        } };
      const run = new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
        { workloadId: "demonstrations-world", batchId: "demonstrations-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
      if (mode === "failed-check-bypass" || mode === "foreign-local") {
        const error = await run.then(() => null, error => error);
        expect(error).toBeInstanceOf(ModelSemanticRepairError);
        expect(error.audit.invocations).toHaveLength(1);
        expect(error.audit.invocations[0].tokenUsage).toMatchObject({ input: 100, output: 20 });
        expect(String(error)).toContain(mode === "failed-check-bypass" ? "cannot bypass its committed perception checks" : "reference.unknown_handle");
        outcomes.push(null);
      } else {
        const result = await run; outcomes.push(result);
        expect(result.receipts[0]!.kind).toBe(mode === "no-stimulus" ? "no_stimulus" : "perceived");
        expect(result.rng.draws).toBe(state.truth.rng.draws + (mode === "check" ? 1 : 0));
        if (mode === "check") expect(result.checks[0]!.succeeded).toBe(true);
      }
      expect(physical).toHaveLength(["check", "failed-check-bypass"].includes(mode) ? 2 : 1);
      expect(contentHash(input)).toBe(before); bodies.push(physical);
    }
    expect(outcomes[1]?.requests).toEqual(outcomes[0]?.requests);
    expect(outcomes[1]?.checks).toEqual(outcomes[0]?.checks);
    expect(outcomes[1]?.receipts).toEqual(outcomes[0]?.receipts);
    for (let i = 0; i < bodies[0]!.length; i++) {
      expect(() => verifyOnlyPerceptionDemonstrationsAdded(bodies[0]![i], bodies[1]![i])).not.toThrow();
      const damaged = structuredClone(bodies[1]![i]) as { model: string };
      damaged.model = "another-model";
      expect(() => verifyOnlyPerceptionDemonstrationsAdded(bodies[0]![i], damaged)).toThrow("more than");
    }
  });

it("does not adapt other roles", () => {
  const request = { role: "truth-resolution", schemaName: "truth_resolution" } as StructuredModelRequest<unknown>;
  expect(perceptionDemonstrationsRequest(request)).toBe(request);
});
