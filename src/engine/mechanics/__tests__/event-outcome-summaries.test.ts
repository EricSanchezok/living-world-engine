import { expect, it } from "vitest";
import { transitionProposalSchema, truthTransitionBatchSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { promptBundle } from "../../prompts";
import { PHYSICAL_BATCH_REPAIR_NOTICE } from "../../prompts/repair-layout";
import { createModelGateway } from "../../models/model-gateway";
import { parseModelCatalog } from "../../models/model-catalog";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { TEST_WORLD_HASH } from "../../testing/world";
import { canonicalSparseArraysRequest } from "../canonical-sparse-arrays";
import { canonicalTransitionEvidenceRequest } from "../transition-evidence-worklist";
import { indexedReviewedPlanningProvider } from "../indexed-reviewed-planning-pipeline";
import { eventOutcomeSummaryRequest } from "../event-outcome-summaries";
import { indexedTransitionRequest, SourceIndexedTransitionCodec } from "../source-indexed-transition";
import { factorSharedBatchContexts } from "../shared-batch-context";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../truth-batch-provider";

const assertion = { kind: "elapsed_seconds_compare" as const, operator: "eq" as const, value: 10 };
const causes = (ref: string) => [{ kind: "action" as const, ref }];
const event = (key: string, ref: string, description: string) => ({ proposalKey: key, description, impact: "ordinary" as const, causes: causes(ref), assertions: [assertion] });
const outcome = (ref: string) => ({ proposalKey: `outcome-${ref.at(-1)}`, actionRef: ref, status: "continuing" as const,
  summary: "Unbound outcome narration", causes: causes(ref), assertions: [assertion] });

function source(ref = "ref:action:a") {
  const action = { actionRef: ref, rawText: "请同伴送信，等回复后再付款；不要替对方答应。", goal: "Conditional delivery" };
  const plan = { actionRef: ref, actorRef: "ref:entity:player", targetRefs: [], causes: [] };
  return { task: { constraints: [] }, state: { actionSet: { assigned: [action] }, committedResolutionPlans: [plan],
    resolutionReceipts: [{ plan }], temporalExecution: { activities: {} },
    canonicalTruth: { facts: {}, entities: { "ref:entity:player": { placementRef: null } }, placements: {} } },
    referenceCatalog: { candidates: ["ref:action:a", "ref:action:b"].map(handle => ({ handle,
      kind: "action", label: handle, meaning: "Assigned source action", allowedUses: ["cause", "action"] })) }, repair: null };
}
function canonicalRequest() {
  const prompt = promptBundle("truth-transition");
  return { ...prompt, promptVersion: prompt.version, role: "truth-transition" as const, profileId: "truth-deepseek",
    workloadId: "event-world", batchId: "event-step", subjectId: "event-source", runtimeIdentity: { worldHash: TEST_WORLD_HASH, revision: 0 },
    context: source(), schemaName: "truth_transition", schema: transitionProposalSchema };
}

it("derives canonical summaries from explicit status and directly owned events through the actual gateway", async () => {
  const baseline = createTestModelCatalog(["truth-deepseek"]), profile = baseline.profile("truth-deepseek");
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: baseline.scheduler, registry: baseline.registry,
    accounts: baseline.accounts, model_overrides: {}, profiles: { "truth-deepseek": {
      ...profile, inference: { ...profile.inference, thinking: "disabled" },
    } } }), request = canonicalRequest();
  const wire = { outcomes: [{ proposalKey: "outcome-a", actionRef: "ref:action:a", status: "continuing", causes: causes("ref:action:a"), assertions: [assertion] }],
    events: [event("sent", "ref:action:a", "同伴接过封好的信；收件人尚未回复。"), event("other", "ref:action:b", "另一人拒绝了提议。"), event("waiting", "ref:action:a", "等待回信，没有付款。") ] };
  let calls = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({ type: "disabled" });
      const message = body.messages.find((m: { role: string }) => m.role === "user").content;
      const schema = JSON.parse(message.split("\nJSON Schema: ")[1].split("\n")[0]);
      expect(schema.properties.outcomes.items.properties).not.toHaveProperty("summary");
      return new Response(JSON.stringify({ id: "event", model: "scripted:truth-deepseek", choices: [{ index: 0,
        message: { role: "assistant", content: JSON.stringify(wire) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { headers: { "content-type": "application/json" } });
    } });
  const result = await indexedReviewedPlanningProvider(gateway, true).generateStructured(request);
  expect(calls).toBe(1);
  expect(result.value.events).toEqual(wire.events);
  expect(result.value.outcomes[0]!.summary).toBe("行动仍在继续。\n直接引用本行动的事件：\n同伴接过封好的信；收件人尚未回复。\n等待回信，没有付款。");
  const original = canonicalSparseArraysRequest(canonicalTransitionEvidenceRequest(request)), adapted = eventOutcomeSummaryRequest(original);
  expect(adapted.context).toBe(original.context);
  expect(adapted.system).toBe(original.system);
  const vocabulary = JSON.parse(adapted.userPrompt.split("Output assertion vocabulary (complete field types are in JSON Schema): ")[1]!);
  expect(vocabulary).toHaveLength(14);
  expect(vocabulary).toContainEqual({ kind: "elapsed_seconds_compare", requiredFields: ["operator", "value"] });
  expect(vocabulary.some((row: { kind: string }) => row.kind === "activity_checkpoint")).toBe(false);
  const invalidCheckpoint = { ...wire, outcomes: [{ ...wire.outcomes[0], assertions: [{ kind: "activity_checkpoint", toElapsedSeconds: 10 }] }] };
  expect(() => adapted.schema.parse(adapted.preprocessOutput!(invalidCheckpoint).value)).toThrow();
  expect(() => eventOutcomeSummaryRequest(adapted)).toThrow("one bound");
  const legacy = { ...wire, outcomes: [{ ...wire.outcomes[0], summary: "The recipient already agreed." }] };
  expect(() => adapted.schema.parse(adapted.preprocessOutput!(legacy).value)).toThrow();
  expect(adapted.schema.parse(adapted.preprocessOutput!({ outcomes: wire.outcomes }).value).outcomes[0]!.summary).toBe("行动仍在继续。");
});

it("keeps indexed slot ownership, every non-summary field and physical repair placement", () => {
  const contexts = [source("ref:action:a"), source("ref:action:b")];
  const context = { task: { slots: [{ slot: 0 }, { slot: 1 }] }, state: factorSharedBatchContexts(contexts, "shared-json-v3") };
  const request = { ...canonicalRequest(), schemaName: "truth_transition_batch", schema: truthTransitionBatchSchema, context,
    userPrompt: canonicalRequest().userPrompt + "\n\n" + SHARED_SLOT_RESULT_INSTRUCTION };
  const indexed = indexedTransitionRequest(request), codec = new SourceIndexedTransitionCodec(context);
  const selected = eventOutcomeSummaryRequest({ ...indexed, userPrompt: indexed.userPrompt + "\n\n" + PHYSICAL_BATCH_REPAIR_NOTICE });
  const canonical = { slots: [0, 1].map(slot => ({ slot, result: { outcomes: [outcome(slot ? "ref:action:b" : "ref:action:a")],
    events: [event(`e-${slot}`, "ref:action:a", `事件归属于槽 ${slot}`)], operations: [], mechanicInvocations: [], decisionRequests: [] } })) };
  const wire = codec.encode(canonical);
  for (const row of wire.outcomes as Record<string, unknown>[]) delete row.summary;
  const before = contentHash(wire), decoded = selected.schema.parse(selected.preprocessOutput!(wire).value);
  expect(selected.userPrompt.endsWith("\n\n" + PHYSICAL_BATCH_REPAIR_NOTICE)).toBe(true);
  expect(selected.context).toBe(indexed.context);
  expect(contentHash(wire)).toBe(before);
  expect(decoded.slots[0]!.result.outcomes[0]!.summary).toContain("事件归属于槽 0");
  expect(decoded.slots[0]!.result.outcomes[0]!.summary).not.toContain("事件归属于槽 1");
  expect(decoded.slots[1]!.result.outcomes[0]!.summary).toBe("行动仍在继续。");
  for (const [index, slot] of decoded.slots.entries()) {
    const withoutSummary = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "summary"));
    expect({ ...slot.result, outcomes: slot.result.outcomes.map(withoutSummary) })
      .toEqual({ ...canonical.slots[index]!.result, outcomes: canonical.slots[index]!.result.outcomes.map(withoutSummary) });
  }
  (wire.outcomes as Record<string, unknown>[])[0]!.summary = "Unbound legacy text";
  expect(() => selected.schema.parse(selected.preprocessOutput!(wire).value)).toThrow();
});
