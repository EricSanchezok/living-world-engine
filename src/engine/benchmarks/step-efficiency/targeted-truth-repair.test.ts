import { expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { factorSharedBatchContexts } from "../../mechanics/shared-batch-context";
import { ActionOwnedPlanCodec } from "./action-owned-plan";
import { FlatTruthBatchCodec } from "./flat-truth-batch";
import { applyTruthReplacements, observeTruthRepairTargets, observeOwnedPlanRepairUnits } from "./targeted-truth-repair";
import { scoreRepairTail } from "./repair-tail";
import { targetedRepairBody, coupledRepairBody, assertOwnedRepairProposalKeys } from "../../../../scripts/experiments/step-targeted-repair-probe";

const contexts = ["a", "b"].map(id => ({ referenceCatalog: { candidates: [{ handle: `ref:action:${id}` }, { handle: `ref:fact:${id}` }] }, state: { actionSet: { assigned: [{ actionRef: `ref:action:${id}` }] } } }));
const plan = (id: string) => ({ proposalKey: `plan-${id}`, actionRef: `ref:action:${id}`, targetRefs: [], means: [], factors: [], risk: "safe", baseEffect: "none", primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: `ref:action:${id}` }], mode: "automatic", difficulty: null, actorRatingRef: null });

it("traces an invalid causal pair through reordered owned slots and preserves every unrequested field", () => {
  const codec = new ActionOwnedPlanCodec({ state: factorSharedBatchContexts(contexts) }, true);
  const wire = codec.encode({ slots: [{ slot: 1, result: { kind: "commit_plans", plans: [plan("b")] } }, { slot: 0, result: { kind: "commit_plans", plans: [plan("a")] } }] });
  const plans = wire.plans as Record<string, { causes: unknown[] }>;
  plans.action_1!.causes[0] = { kind: "entity", ref: "ref:entity:actor-b" };
  const before = structuredClone(wire);
  const targets = observeTruthRepairTargets(wire, codec, "plan", contexts);
  expect(targets.map(t => t.pointer)).toEqual(["/plans/action_1/causes/0"]);
  const fixed = applyTruthReplacements(wire, targets, { replacements: [{ path: targets[0]!.pointer, value: { kind: "action", ref: "ref:action:b" } }] });
  expect(scoreRepairTail(JSON.stringify(codec.decode(fixed)), "plan", contexts).schemaCoverageReferences).toBe(true);
  expect((fixed as typeof wire).plans).toMatchObject({ action_0: plans.action_0 });
  const restored = structuredClone(fixed) as typeof wire;
  (restored.plans as typeof plans).action_1!.causes[0] = before.plans && (before.plans as typeof plans).action_1!.causes[0];
  expect(restored).toEqual(before);
  expect(wire).toEqual(before);
  expect(() => applyTruthReplacements(wire, targets, { replacements: [{ path: "/plans/action_0/causes/0", value: null }] })).toThrow(/unrequested/u);
  expect(() => applyTruthReplacements(wire, targets, { replacements: [{ path: targets[0]!.pointer }] })).toThrow();
  const stale = structuredClone(wire);(stale.plans as typeof plans).action_1!.causes[0] = { kind: "event", ref: "changed" };
  expect(() => applyTruthReplacements(stale, targets, { replacements: [{ path: targets[0]!.pointer, value: null }] })).toThrow(/snapshot/u);
});

it("locates a cross-slot assertion reference and rejects a formally shaped but still illegal repair", () => {
  const codec = new FlatTruthBatchCodec("transition", 2);
  const wire = codec.encode({ slots: [0, 1].map(slot => ({ slot, result: { outcomes: [{ proposalKey: `outcome-${slot}`, actionRef: `ref:action:${slot ? "b" : "a"}`, status: "continuing", summary: "Still working", causes: [{ kind: "action", ref: `ref:action:${slot ? "b" : "a"}` }], assertions: [{ kind: "fact_absent", factRef: `ref:fact:${slot ? "b" : "a"}` }] }], mechanicInvocations: [], operations: [], events: [], decisionRequests: [] } })) });
  const outcomes = wire.outcomes as Array<{ assertions: Array<{ factRef: string }> }>;
  outcomes[1]!.assertions[0]!.factRef = "ref:fact:a";
  const targets = observeTruthRepairTargets(wire, codec, "transition", contexts);
  expect(targets.map(t => t.pointer)).toEqual(["/outcomes/1/assertions/0/factRef"]);
  const unchanged = contentHash(outcomes[0]);
  const invalid = applyTruthReplacements(wire, targets, { replacements: [{ path: targets[0]!.pointer, value: "ref:fact:invented" }] });
  expect(observeTruthRepairTargets(invalid, codec, "transition", contexts)).toHaveLength(1);
  const fixed = applyTruthReplacements(wire, targets, { replacements: [{ path: targets[0]!.pointer, value: "ref:fact:b" }] });
  expect(observeTruthRepairTargets(fixed, codec, "transition", contexts)).toEqual([]);
  expect(contentHash((fixed as typeof wire).outcomes && ((fixed as typeof wire).outcomes as unknown[])[0])).toBe(unchanged);
});

it("retains the complete recorded request prefix and raw draft when constructing bounded repair HTTP", () => {
  const source = { model: "deepseek-v4-flash" as const, max_tokens: 131072 as const, thinking: { type: "disabled" as const }, response_format: { type: "text" as const },
    messages: [{ role: "system" as const, content: "Full system policy" }, { role: "user" as const, content: "Complete original context and schema" }] };
  const targets = [{ path: ["plans", "action_0", "causes", 0], pointer: "/plans/action_0/causes/0", valueHash: "original", reason: "Invalid causal kind" }];
  const draft = "kind: commit_plans\nplans:\n  action_0: {}\n";
  const body = targetedRepairBody(source, draft, targets, []);
  expect(body.messages.slice(0, 2)).toEqual(source.messages);
  expect(body.messages[2]).toEqual({ role: "assistant", content: draft });
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(body.thinking).toEqual(source.thinking);
  expect(body.max_tokens).toBe(source.max_tokens);
  expect(body.messages[3]!.content).toContain(JSON.stringify(targets));
  const feedback = [{ output: "malformed", error: "invalid JSON" }];
  expect(targetedRepairBody(source, draft, targets, feedback).messages[3]!.content).toContain(JSON.stringify(feedback));
  expect(() => targetedRepairBody(source, draft, targets, [...feedback, ...feedback])).toThrow(/bounded/u);
  expect(source.response_format.type).toBe("text");
  const record = [{ key: "action_0", slot: 0, proposalKey: "original", action: { rawText: "Complete source action" } }];
  const coupled = coupledRepairBody(source, draft, targets, feedback, record);
  expect(coupled.messages.slice(0, 3)).toEqual(body.messages.slice(0, 3));
  expect(coupled.messages[3]!.content).toContain(JSON.stringify(record));
  expect(coupled.response_format.type).toBe("text");
});

it("reports unavailable references even when another action has an invalid factor, allowing coupled difficulty repair", () => {
  const codec = new ActionOwnedPlanCodec({ state: factorSharedBatchContexts(contexts) }, true);
  const wire = codec.encode({ slots: ["a", "b"].map((id, slot) => ({ slot, result: { kind: "commit_plans", plans: [plan(id)] } })) });
  const plans = wire.plans as Record<string, Record<string, unknown>>;
  plans.action_0!.factors = [{ source: { kind: "quantity", ref: "ref:quantity:missing" }, role: "permission" }];
  plans.action_1!.actorRatingRef = "ref:rating:insight:b";
  const targets = observeOwnedPlanRepairUnits(wire, codec, contexts);
  expect(targets.map(t => t.pointer)).toEqual(["/plans/action_0", "/plans/action_1"]);
  expect(targets[0]!.reason).toContain("factor selector");
  expect(targets[0]!.reason).toContain("ref:quantity:missing");
  expect(targets[1]!.reason).toContain("ref:rating:insight:b");
  const valid = codec.encode({ slots: ["a", "b"].map((id, slot) => ({ slot, result: { kind: "commit_plans", plans: [plan(id)] } })) });
  const fixed = applyTruthReplacements(wire, targets, { replacements: targets.map(t => ({ path: t.pointer, value: (valid.plans as Record<string, unknown>)[String(t.path[1])] })) });
  expect(observeOwnedPlanRepairUnits(fixed, codec, contexts)).toEqual([]);
  expect(codec.decode(fixed)).toEqual(codec.decode(valid));
  expect(() => assertOwnedRepairProposalKeys(wire, fixed, targets)).not.toThrow();
  const renamed = structuredClone(fixed) as { plans: Record<string, Record<string, unknown>> };renamed.plans.action_0!.proposalKey = "changed";
  expect(() => assertOwnedRepairProposalKeys(wire, renamed, targets)).toThrow(/identity/u);
  const ambiguous = structuredClone(wire);(ambiguous.plans as Record<string, Record<string, unknown>>).action_0!.slot = 0;
  expect(() => observeOwnedPlanRepairUnits(ambiguous, codec, contexts)).toThrow(/identity/u);
});
