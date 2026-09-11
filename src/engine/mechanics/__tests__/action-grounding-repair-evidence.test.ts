import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { recordedContext } from "../../benchmarks/step-efficiency/repair-tail";
import type { AgentActionProposal } from "../../contracts/model";
import { referenceHandleFor } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import { createTestModelRegistry, ScriptedModelProvider } from "../../testing/model-provider";
import { generateInteractionDependency, materializeModelInteractionDependency } from "../action-dependency";

it.each(["uses", "unknown"] as const)("preserves exact grounding repair evidence for %s at the HTTP boundary", async failure => {
  const fixture = new ScriptedModelProvider(() => { throw new Error("fixture must not call a model"); });
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: fixture.catalog });
  const action: AgentActionProposal = { id: "inspect-gate", actorId: "keeper", baseRevision: state.revision,
    rawText: "Inspect the gate without moving it.", goal: "Inspect the gate", means: null, targetIds: [] };
  const agent = referenceHandleFor("agent", "keeper"), entity = referenceHandleFor("entity", "keeper");
  const source = referenceHandleFor("action", action.id), missing = referenceHandleFor("entity", "missing-object");
  const valid = { stateDependencies: { requiredExistingRefs: [entity], potentiallyAffectedExistingRefs: [] },
    audienceAgentRefs: [agent], sharedResourceClaims: [] };
  const invalid = failure === "uses"
    ? { stateDependencies: { requiredExistingRefs: [agent], potentiallyAffectedExistingRefs: [source] },
      audienceAgentRefs: [entity], sharedResourceClaims: [{ resourcePoolRef: entity, basis: { kind: "default" } }] }
    : { ...valid, stateDependencies: { requiredExistingRefs: [missing], potentiallyAffectedExistingRefs: [] } };
  const expected = materializeModelInteractionDependency(state, action, valid), before = contentHash(state);
  let http = 0;
  let firstContext: { state: unknown; referenceCatalog: unknown } | undefined;
  const gateway = createModelGateway(fixture.catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    registry: createTestModelRegistry(fixture.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      const body = JSON.parse(String(init?.body)); http++;
      const context = recordedContext(body.messages[1].content).value as { state: unknown; referenceCatalog: unknown;
        repair: null | { previousOutputAvailable: boolean; previousOutput: unknown;
          issues: Array<{ code: string; path: Array<string | number>; originalValue: unknown; allowedHandles: string[] }> } };
      if (http === 1) {
        expect(context.repair).toBeNull();
        firstContext = { state: context.state, referenceCatalog: context.referenceCatalog };
      }
      else {
        expect(http).toBe(2);
        expect({ state: context.state, referenceCatalog: context.referenceCatalog }).toEqual(firstContext);
        expect(context.repair?.previousOutputAvailable).toBe(true);
        expect(context.repair?.previousOutput).toEqual(invalid);
        const issues = context.repair!.issues;
        expect(issues.map(issue => issue.path)).toEqual(failure === "uses" ? [
          ["stateDependencies", "requiredExistingRefs", 0],
          ["stateDependencies", "potentiallyAffectedExistingRefs", 0],
          ["audienceAgentRefs", 0],
          ["sharedResourceClaims", 0, "resourcePoolRef"],
        ] : [["stateDependencies", "requiredExistingRefs", 0]]);
        for (const issue of issues) {
          const selected = issue.path.reduce<unknown>((value, key) => (value as Record<string | number, unknown>)[key], context.repair!.previousOutput);
          expect(issue.originalValue).toEqual(selected);
          expect(issue.allowedHandles).not.toContain(selected);
          if (issue.path[0] !== "sharedResourceClaims") expect(issue.allowedHandles.length).toBeGreaterThan(0);
        }
      }
      return new Response(JSON.stringify({ id: `grounding-evidence-${http}`, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(http === 1 ? invalid : valid) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const actual = await generateInteractionDependency(gateway, state, action,
    { workloadId: "grounding-evidence", batchId: "root", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }, "truth-engine");
  expect(http).toBe(2);
  expect(actual.dependency).toEqual(expected);
  expect(contentHash(state)).toBe(before);
});
