import { expect, it } from "vitest";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { parseModelCatalog } from "../../models/model-catalog";
import { createModelGateway } from "../../models/model-gateway";
import { promptBundle } from "../../prompts";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { RESOLUTION_SOURCE_ROLE_INSTRUCTION, resolutionSourceRoleRequest } from "../resolution-source-role-contract";

it.each(["truth_resolution_plan_commit", "truth_resolution_plan_repair"])("preserves the whole request and result at actual transport: %s", async schemaName => {
  const base = createTestModelCatalog(["truth-deepseek"]), profile = base.profile("truth-deepseek");
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: base.scheduler, registry: base.registry, accounts: base.accounts,
    model_overrides: {}, profiles: { "truth-deepseek": { ...profile, inference: { ...profile.inference, thinking: "disabled" } } } });
  const expected = { kind: "commit_plans", plans: [{ proposalKey: "observe", actionRef: "ref:action:a", targetRefs: ["ref:entity:guard"],
    means: [{ description: "Observe the gate", source: { kind: "action", ref: "ref:action:a" } }], mode: "automatic", difficulty: null,
    actorRatingRef: null, factors: [], risk: "safe", baseEffect: "none", primaryEffect: null, secondaryEffect: null, threatenedEffect: null,
    visibility: "full", causes: [{ kind: "action", ref: "ref:action:a" }] }] };
  const context = { state: { originalAction: "Wait until the gate opens, then approach the guard", evidence: "The gate is currently closed" },
    repair: schemaName.endsWith("repair") ? { issues: ["Preserve the time condition"], previousOutput: expected } : null };
  const prompt = promptBundle("truth-resolution"), request = { ...prompt, role: "truth-resolution" as const, profileId: "truth-deepseek",
    workloadId: "source-role-test", batchId: "original-batch", subjectId: "original-action", runtimeIdentity: { worldHash: `sha256:${"1".repeat(64)}`, revision: 0 },
    promptVersion: prompt.version, context, schemaName, schema: resolutionPlanCommitDirectiveSchema };
  const candidate = resolutionSourceRoleRequest(request);
  expect(candidate.system.split(RESOLUTION_SOURCE_ROLE_INSTRUCTION)).toHaveLength(2);
  expect(promptBundle("resolution-plan-verifier").system).toContain(RESOLUTION_SOURCE_ROLE_INSTRUCTION);
  expect(candidate.context).toBe(context);
  expect(candidate.schema).toBe(request.schema);
  expect(candidate.userPrompt).toBe(request.userPrompt);
  expect(() => resolutionSourceRoleRequest(candidate)).toThrow("twice");
  let calls = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      calls++; const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.messages[0].content).toContain(RESOLUTION_SOURCE_ROLE_INSTRUCTION);
      expect(body.messages[1].content).toContain(context.state.originalAction);
      expect(body.messages[1].content).toContain(context.state.evidence);
      return new Response(JSON.stringify({ id: "test", model: "scripted:truth-deepseek", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(expected) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  expect((await gateway.generateStructured(candidate)).value).toEqual(expected);
  expect(calls).toBe(1);
});
