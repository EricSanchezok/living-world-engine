import path from "node:path";
import { expect, it } from "vitest";
import type { OnsetPerceptionInput } from "../../../algorithms/roles";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import type { StructuredModelProvider, StructuredModelRequest } from "../../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry } from "../../../testing/model-provider";
import { loadWorldScript } from "../../../../script/world-loader";
import { perceptionNoExampleRequest } from "../perception-example-policy";
import { perceptionDerivedSourceRequest, perceptionDerivedSourceSchema } from "../perception-derived-source";

it.each(["opposed", "null-aptitude", "environment", "repair", "wrong-owner", "wrong-opponent", "unknown-rating", "reused-rating", "extra-source", "missing-environment-source"])(
  "preserves real perception checks, validation and RNG for %s", async mode => {
    const catalog = createTestModelCatalog();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: catalog });
    const state = structuredClone(definition.initialState);
    const input: OnsetPerceptionInput = { definition, state, identityOwner: "source-derivation-test", groundings: [],
      actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Conceal the key in my sleeve.", goal: "Hide the key", means: null, targetIds: [] }],
      perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
      temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
    const before = contentHash(input), outcomes: Array<Awaited<ReturnType<TruthEngine["perceiveOnset"]>>> = [];
    const accepted = ["opposed", "null-aptitude", "environment", "repair"].includes(mode);
    for (const candidate of [false, true]) {
      let http = 0;
      const requests: StructuredModelRequest<unknown>[] = [];
      const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
        fetchForAccount: () => async (_url, init) => {
          http++;
          const physical = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
          expect(physical.messages.some(message => message.content.includes("Example JSON output shape:"))).toBe(false);
          const repaired = mode === "repair" && http === 2;
          const environment = mode === "environment" || mode === "missing-environment-source";
          const opposingRating = mode === "unknown-rating" ? "ref:rating:resolve:missing" : "ref:rating:resolve:player";
          const difficulty = environment
            ? { kind: "environment", band: "easy", ...(mode === "missing-environment-source" ? {} : { source: { kind: "law", ref: "ref:law:time-passes" } }) }
            : { kind: "opposed", targetRef: mode === "wrong-opponent" ? "ref:entity:keeper" : "ref:entity:player", ratingRef: opposingRating,
              ...(!candidate || mode === "extra-source" ? { source: mode === "extra-source" ? { kind: "law", ref: "ref:law:time-passes" } : { kind: "rating", ref: opposingRating } } : {}) };
          const output = http > (mode === "repair" ? 2 : 1) ? { kind: "done" } : { kind: "request_checks", requests: [{
            proposalKey: "notice-key", actorRef: mode === "reused-rating" ? "ref:entity:player" : "ref:entity:keeper", targetRef: "ref:entity:key",
            ratingRef: mode === "null-aptitude" ? null : mode === "wrong-owner" || mode === "reused-rating" || mode === "repair" && !repaired ? "ref:rating:resolve:player" : "ref:rating:resolve:keeper",
            difficulty, mode: "normal", stakes: "Whether the keeper notices the key's concealment at onset.", visibility: "full",
            causes: [{ kind: "action", ref: "ref:action:conceal" }, { kind: "law", ref: "ref:law:time-passes" }],
          }] };
          return new Response(JSON.stringify({ id: "source-test", model: "scripted:truth-deepseek",
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
        } });
      const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role), assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
        generateStructured: request => {
          const baseline = perceptionNoExampleRequest(request), adapted = candidate ? perceptionDerivedSourceRequest(baseline) : baseline;
          requests.push(adapted);
          if (candidate) {
            const original = request.context as Record<string, unknown>, changed = adapted.context as Record<string, unknown>;
            expect({ ...changed, roleContract: original.roleContract }).toEqual(original);
            expect(adapted.schema).toBe(request.schema);
            expect(adapted.system).toContain("Do not output its source field");
            expect(adapted.system).not.toContain("and cites that same Rating as its source");
            expect(adapted.userPrompt).not.toContain("citing that same Rating as its difficulty source");
          }
          return gateway.generateStructured(adapted);
        } };
      const run = new TruthEngine(provider, { repairAttempts: mode === "repair" ? 1 : 0 }).perceiveOnset(input,
        { workloadId: "source-world", batchId: "source-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
      if (accepted) outcomes.push(await run);
      else await expect(run).rejects.toThrow();
      expect(contentHash(input)).toBe(before);
      expect(http).toBe(accepted ? mode === "repair" ? 3 : 2 : 1);
      if (mode === "repair") expect(requests[1]?.correlation?.semanticRepairAttempt).toBe(1);
      if (candidate) {
        expect(() => perceptionDerivedSourceRequest(requests[0]!)).toThrow("no other codec");
        const changed = requests[0]!.context as Record<string, unknown>;
        changed.state = {};
        expect(() => requests[0]!.preprocessOutput!({ kind: "done" })).toThrow("binding changed");
      }
    }
    if (accepted) {
      expect(outcomes[1]!.requests).toEqual(outcomes[0]!.requests);
      expect(outcomes[1]!.checks).toEqual(outcomes[0]!.checks);
      expect(outcomes[1]!.rng).toEqual(outcomes[0]!.rng);
      expect(outcomes[1]!.requests).toHaveLength(1);
      expect(outcomes[1]!.requests[0]).toMatchObject({ actorId: "keeper", targetId: "key", modifier: mode === "null-aptitude" ? 0 : 3, dc: mode === "environment" ? 10 : 12 });
    }
  });

it("leaves other roles alone and rejects incompatible policy or layout", () => {
  const other = { role: "truth-resolution", schemaName: "truth_resolution" } as StructuredModelRequest<unknown>;
  expect(perceptionDerivedSourceRequest(other)).toBe(other);
  const perception = { ...other, role: "truth-perception", schemaName: "truth_perception_directive" } as StructuredModelRequest<unknown>;
  expect(() => perceptionDerivedSourceRequest(perception)).toThrow("requires example omission");
  expect(() => perceptionDerivedSourceRequest({ ...perception, jsonExamplePolicy: "omit", jsonObjectPostlude: "another experiment" })).toThrow("no other codec or layout");
  expect(perceptionDerivedSourceSchema.parse({ kind: "done" })).toEqual({ kind: "done" });
});
