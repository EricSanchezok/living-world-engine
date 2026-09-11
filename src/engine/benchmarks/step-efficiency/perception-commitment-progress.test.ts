import { noStimulusReportsForTargets } from "../../testing/model-provider";
import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { selectTemporalBoundary } from "../../mechanics/temporal";
import { TruthEngine } from "../../mechanics/truth-engine";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import type { StructuredModelProvider } from "../../models/model-provider";
import { createTestModelRegistry, ScriptedModelProvider } from "../../testing/model-provider";
import { recordedContext } from "./repair-tail";
import { perceptionCommitmentProgressRequest } from "./perception-commitment-progress";

it("preserves the initial HTTP input and delivers bound failed-check evidence through the real continuation", async () => {
  const fixture = new ScriptedModelProvider(() => { throw new Error("fixture must not call a model"); });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: fixture.catalog });
  const state = definition.initialState, before = contentHash(state);
  let http = 0;
  const gateway = createModelGateway(fixture.catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    registry: createTestModelRegistry(fixture.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      const body = JSON.parse(String(init?.body)), prompt = body.messages[1].content as string;
      const context = recordedContext(prompt).value as { state: { committedCheckRequests: unknown[]; checkResults: unknown[] } };
      http++;
      if (http === 1) {
        expect(prompt).not.toContain("Committed perception progress");
      } else {
        expect(http).toBe(2);
        const evidence = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
        expect(evidence.sourceContextHash).toBe(contentHash(context));
        expect(evidence.targets[0].committed).toEqual([{
          request: context.state.committedCheckRequests[0], result: context.state.checkResults[0],
        }]);
        expect(evidence.targets[0].committed[0].result.succeeded).toBe(false);
        expect(prompt).toContain("A failed roll is a resolved result");
      }
      const output = http === 1 ? { kind: "request_checks", requests: [{ proposalKey: "notice-key",
        actorRef: "ref:entity:keeper", targetRef: "ref:entity:player", ratingRef: null,
        difficulty: { kind: "environment", band: "hard", source: { kind: "law", ref: "ref:law:time-passes" } },
        mode: "normal", stakes: "Whether the keeper sees the player's concealed key at onset.", visibility: "full",
        causes: [{ kind: "action", ref: "ref:action:conceal-key" }, { kind: "law", ref: "ref:law:time-passes" }],
      }] } : { kind: "done", reports: noStimulusReportsForTargets({ state, perceptionTargets: [{ observerId: "keeper" }] }) };
      return new Response(JSON.stringify({ id: `progress-${http}`, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const provider: StructuredModelProvider = { catalog: gateway.catalog,
    availableProfileSummaries: role => gateway.availableProfileSummaries(role), assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
    generateStructured: request => {
      const candidate = perceptionCommitmentProgressRequest(request);
      expect(candidate.context).toBe(request.context); expect(candidate.schema).toBe(request.schema);
      expect(candidate.system).toBe(request.system); expect(candidate.userPrompt).toBe(request.userPrompt);
      if (http === 0) expect(candidate).toEqual({ ...request, promptVersion: candidate.promptVersion });
      else {
        expect(() => perceptionCommitmentProgressRequest(candidate)).toThrow("already has a postlude");
        for (const mode of ["missing", "duplicate", "mismatched"] as const) {
          const invalid = structuredClone(request.context) as { state: { checkResults: Array<{ checkRef: string }> } };
          if (mode === "missing") invalid.state.checkResults = [];
          else if (mode === "duplicate") invalid.state.checkResults.push(structuredClone(invalid.state.checkResults[0]!));
          else invalid.state.checkResults[0]!.checkRef = "ref:check:unrelated";
          expect(() => perceptionCommitmentProgressRequest({ ...request, context: invalid })).toThrow("binding differs");
        }
      }
      return gateway.generateStructured(candidate);
    } };
  const result = await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset({ definition, state,
    identityOwner: "progress-probe", groundings: [],
    actions: [{ id: "conceal-key", actorId: "player", baseRevision: state.revision, rawText: "Conceal the key in my sleeve.",
      goal: "Hide the key", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal-key" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }),
  }, { workloadId: "progress-probe", batchId: "step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  expect(http).toBe(2); expect(result.requests).toHaveLength(1); expect(result.checks[0]!.succeeded).toBe(false);
  expect(contentHash(state)).toBe(before);
});
