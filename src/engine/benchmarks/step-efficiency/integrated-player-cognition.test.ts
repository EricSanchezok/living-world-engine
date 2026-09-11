import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { parseModelCatalog } from "../../models/model-catalog";
import { createModelGateway } from "../../models/model-gateway";
import { ModelConfigurationError, type StructuredModelProvider } from "../../models/model-provider";
import { contentHash } from "../../models/model-audit";
import { UNMATCHED_CLOSER_RECOVERY } from "../../models/unmatched-closer-recovery";
import { loadWorldScript } from "../../../script/world-loader";
import { createActionCompilationRetrievalRuntimeProvider } from "../../../server/action-compilation-retrieval-runtime";
import { RecordingRuntimeObserver } from "../../runtime/observability";
import { integratedPlayerAlgorithmRef, integratedPlayerRequest, registerIntegratedPlayerAlgorithm } from "./integrated-player-algorithm";

it.each([false, true])("uses restricted recovery through registered bootstrap and preserves private reference rejection=%s", async invalidTarget => {
  const original = createTestModelCatalog();
  const catalog = parseModelCatalog({ schema_version: original.schemaVersion, scheduler: original.scheduler, registry: original.registry,
    accounts: original.accounts, model_overrides: original.modelOverrides,
    profiles: Object.fromEntries(Object.entries(original.profiles).map(([id, profile]) => [id,
      { ...profile, inference: { ...profile.inference, thinking: "disabled" } }])) });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 17, modelCatalog: catalog });
  const state = definition.initialState, before = contentHash(state);
  const text = '先查看门上的记号 "} ]"；若守门人愿意交谈，就询问路况，否则留在原处等待。';
  const targets = Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id)).map(agent =>
    `ref:local_entity:${Object.keys(agent.belief.localEntities).sort()[0]}`);
  const output = { slots: targets.map((target, slot) => ({ slot, beliefChanges: { operations: [] }, characterChanges: { operations: [] },
    nextActionIntent: { rawText: text, targetHandles: [invalidTarget && slot === 0 ? "ref:local_entity:absent" : target] } })) };
  // One extra closer between complete slots, outside the quoted delimiters.
  const raw = JSON.stringify(output).replace(']}},{"slot":1', ']}}},{"slot":1');
  expect(() => JSON.parse(raw)).toThrow();
  let http = 0, calls = 0;
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture-key" }, { registry: createTestModelRegistry(catalog), fetch: async (_url, init) => {
    http++;
    const body = JSON.parse(String(init?.body));
    expect(body.thinking).toEqual({ type: "disabled" });
    return Response.json({ id: "fixture", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: raw }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 } } });
  } });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: request => {
      if (++calls > 1) throw new ModelConfigurationError("Stop model repair after the retained private-reference failure");
      expect(request.role).toBe("agent-bootstrap");
      expect(request.jsonSyntaxRecovery).toBe(UNMATCHED_CLOSER_RECOVERY);
      return gateway.generateStructured(request);
    } };
  const ref = integratedPlayerAlgorithmRef(), retrieval = createActionCompilationRetrievalRuntimeProvider();
  const algorithm = registerIntegratedPlayerAlgorithm().create(ref, { provider,
    resources: { resolve: <T,>() => retrieval.runtime(ref) as T } });
  const pending = algorithm.bootstrap({ definition, state }, {
    modelScope: { workloadId: "cognition-test", batchId: "bootstrap", observer,
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } },
    instrumentation: { emit: () => undefined },
  });
  if (invalidTarget) {
    await expect(pending).rejects.toThrow("Stop model repair");
    const rejections = observer.snapshot().filter(event => event.event === "model.semantic.rejected");
    expect(rejections.length).toBeGreaterThan(0);
    expect(JSON.stringify(rejections.map(event => event.payload))).toContain("ref:local_entity:absent");
    expect(JSON.stringify(rejections.map(event => event.payload))).toContain("reference.unknown_handle");
  } else {
    const result = await pending;
    expect(result.agentCommits).toHaveLength(targets.length);
    for (const [index, commit] of result.agentCommits.entries()) {
      expect(commit.nextAction).toMatchObject({ actorId: commit.agentId, rawText: text, goal: text, means: null,
        targetIds: [targets[index]!.replace("ref:local_entity:", "")] });
      expect(commit.beliefPatch.operations).toEqual([]); expect(commit.characterPatch.operations).toEqual([]);
    }
    expect(result.modelAudits.flatMap(audit => audit.invocations)).toEqual([expect.objectContaining({
      jsonRecoveryEvidence: expect.objectContaining({ policy: UNMATCHED_CLOSER_RECOVERY, removed: [expect.objectContaining({ character: "}" })] }),
      tokenUsage: expect.objectContaining({ input: 20, output: 30 }),
    })]);
  }
  expect(http).toBe(1); expect(contentHash(state)).toBe(before);
  expect(algorithm.manifest.hash).toBe(ref.manifestHash);
});

it("selects cognition recovery for reactions without rewriting their action contract", () => {
  const request = { role: "agent-reaction" as const, workloadId: "world", batchId: "reaction", profileId: "agent-default",
    subjectId: "slots", promptVersion: "source", schemaName: "agent_reaction_batch_output", schema: z.unknown(),
    system: "React", userPrompt: "Use own stimulus", context: { slots: [] } };
  expect(integratedPlayerRequest(request)).toEqual({ ...request, jsonSyntaxRecovery: UNMATCHED_CLOSER_RECOVERY });
});
