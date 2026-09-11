import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { representedActionCompilationPrompt } from "../../algorithms/eager-reference/represented-action-compiler";
import { composeJsonObjectPrompt } from "../../prompts";
import { referenceDiagnosticBody } from "./reference-diagnostic";
import { scoreTemporalDiagnostic, temporalDiagnosticBody, temporalProbeContext, type TemporalProbeBody, type TemporalProbeContext } from "./temporal-diagnostic";

const profile = "candidate_000000000000", first = "candidate_000000000001", second = "candidate_000000000002";
const context: TemporalProbeContext = {
  referenceCatalog: { candidates: [
    { candidateKey: profile, kind: "temporal_profile", details: { kind: "fixed" }, scope: { kind: "shared" } },
    ...[first, second].map((candidateKey, slot) => ({ candidateKey, kind: "action", scope: { kind: "slot" as const, slot } })),
  ] },
  task: { slots: [first, second].map((candidateKey, slot) => ({ slot, action: { rawText: `Read literal ${candidateKey}` },
    actionReferences: { actionCandidateKey: candidateKey }, temporalProfileEligibility: [{ profileRef: profile, eligible: true }],
  })) },
};
const codec = new ActionCompilationCodec("AT", context);
const source = (): TemporalProbeBody => ({ model: "deepseek-v4-flash", max_tokens: 131072, thinking: { type: "enabled" },
  reasoning_effort: "low", response_format: { type: "json_object" }, messages: [
    { role: "system", content: representedActionCompilationPrompt("T").system + "\nRole contract unchanged" },
    { role: "user", content: composeJsonObjectPrompt({ userPrompt: "Compile the full action batch.", contextJson: JSON.stringify(context),
      schemaJson: JSON.stringify(z.toJSONSchema(new ActionCompilationCodec("T", context).wireSchema(context), { target: "draft-07" })),
      exampleJson: '{"slots":[]}', discriminator: "" }) },
  ] });

describe("frozen reference representation diagnostic", () => {
  it("preserves literal action text, slot permissions and the baseline request outside the codec", () => {
    const original = source();
    expect(referenceDiagnosticBody(original, "T", "Scope")).toEqual(temporalDiagnosticBody(original, "Scope"));
    const alias = referenceDiagnosticBody(original, "AT", "Scope");
    expect(temporalProbeContext(alias)).toEqual(codec.encodeContext(context));
    expect(temporalProbeContext(alias).task.slots.map((slot) => slot.action)).toEqual(context.task.slots.map((slot) => slot.action));
    expect(alias.messages[0]!.content).toBe(representedActionCompilationPrompt("AT").system + "\nRole contract unchanged\n\nScope");
    expect(alias.thinking.type).toBe("disabled");
    expect(alias.reasoning_effort).toBeUndefined();
    const canonical = { slots: [first, second].map((ref, slot) => ({ slot,
      temporalPlan: { profileRef: profile, basis: { kind: "profile" }, description: "Read source literal", continuationAssertions: [], causes: [{ kind: "action", ref }] },
      interactionDependency: { stateDependencies: { requiredExistingCandidateKeys: [], potentiallyAffectedCandidateKeys: [] }, audienceAgentCandidateKeys: [], sharedResourceClaims: [] },
    })) };
    const wire = codec.encodeOutput(canonical);
    expect(scoreTemporalDiagnostic(JSON.stringify(wire), context, [], "AT").schemaAndReferences).toBe(true);
    canonical.slots[0]!.temporalPlan.causes[0]!.ref = second;
    expect(scoreTemporalDiagnostic(JSON.stringify(codec.encodeOutput(canonical)), context, [], "AT").schemaAndReferences).toBe(false);
    expect(scoreTemporalDiagnostic(JSON.stringify(wire).replace('"r001"', '"r999"'), context, [], "AT").schemaAndReferences).toBe(false);
  });

  it("stops at prompt/schema drift before any paid request", () => {
    const prompt = source();prompt.messages[0]!.content = "A different compiler";
    expect(() => referenceDiagnosticBody(prompt, "AT")).toThrow("prompt drift");
    const schema = source();schema.messages[1]!.content = schema.messages[1]!.content.replace('"draft', '"changed-draft');
    schema.messages[1]!.content = schema.messages[1]!.content.replace('"slots":{', '"differentSlots":{');
    expect(() => referenceDiagnosticBody(schema, "AT")).toThrow("schema drift");
  });
});
