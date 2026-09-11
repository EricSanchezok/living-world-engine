import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { AgentActionProposal } from "../../contracts/model";
import { referenceHandleFor } from "../../contracts/model-context";
import { actionGroundingContext, generateInteractionDependency, materializeModelInteractionDependency } from "../../mechanics/action-dependency";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../mechanics/shared-batch-context";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import { createTestModelRegistry, ScriptedModelProvider } from "../../testing/model-provider";
import { recordedContext } from "./repair-tail";
import { sharedGroundingProbeProvider } from "./shared-grounding-probe";

it.each([false, true])("shares complete grounding inputs at HTTP and retains local repair ownership: %s", async repair => {
  const fixture = new ScriptedModelProvider(() => { throw new Error("fixture must not call a model"); });
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: fixture.catalog });
  const actions: AgentActionProposal[] = ["keeper", "player"].map(actorId => ({ id: `inspect-${actorId}`, actorId,
    baseRevision: state.revision, rawText: `Inspect the gate as ${actorId}, without opening it.`, goal: "Inspect the gate", means: null, targetIds: [] }));
  const scope = { workloadId: "shared-grounding", batchId: "root", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const logical = actions.map(action => actionGroundingContext(state, action, [], scope));
  const outputs = actions.map(action => ({ stateDependencies: { requiredExistingRefs: [referenceHandleFor("entity", action.actorId)], potentiallyAffectedExistingRefs: [] },
    audienceAgentRefs: [referenceHandleFor("agent", action.actorId)], sharedResourceClaims: [] }));
  const bad = { ...outputs[1]!, audienceAgentRefs: [referenceHandleFor("entity", "player")] };
  const expected = actions.map((action, index) => materializeModelInteractionDependency(state, action, outputs[index]!));
  const sourceHash = contentHash(state);
  let http = 0;
  const gateway = createModelGateway(fixture.catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    registry: createTestModelRegistry(fixture.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      const body = JSON.parse(String(init?.body)); http++;
      const context = recordedContext(body.messages[1].content).value as Record<string, unknown>;
      let output: unknown;
      if (http === 1) {
        expect(expandSharedBatchContexts(context.state as SharedBatchContext)).toEqual(logical);
        const schema = JSON.parse(body.messages[1].content.split("JSON Schema: ")[1]);
        expect(schema.properties.slots).toMatchObject({ minItems: 2, maxItems: 2 });
        output = { slots: outputs.map((result, slot) => ({ slot, result: repair && slot === 1 ? bad : result })) };
      } else {
        expect(repair).toBe(true);
        expect(http).toBe(2);
        expect(context.state).toEqual(logical[1]!.state);
        expect(context.referenceCatalog).toEqual(logical[1]!.referenceCatalog);
        expect(context.repair).toMatchObject({ target: referenceHandleFor("action", actions[1]!.id), previousOutputAvailable: true, previousOutput: bad,
          issues: [{ path: ["audienceAgentRefs", 0], originalValue: referenceHandleFor("entity", "player") }] });
        output = outputs[1];
      }
      return new Response(JSON.stringify({ id: `shared-grounding-${http}`, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const provider = sharedGroundingProbeProvider(gateway);
  const results = await Promise.all(actions.map(action => generateInteractionDependency(provider, state, action, scope, "truth-engine")));
  expect(http).toBe(repair ? 2 : 1);
  expect(results.map(result => result.dependency)).toEqual(expected);
  expect(contentHash(state)).toBe(sourceHash);
});
