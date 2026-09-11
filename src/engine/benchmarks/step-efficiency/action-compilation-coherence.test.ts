import { expect, it } from "vitest";
import { z } from "zod";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { representedActionCompilationPrompt } from "../../algorithms/eager-reference/represented-action-compiler";
import { composeJsonObjectPrompt } from "../../prompts";
import { contentHash } from "../../models/model-audit";
import { coherentTemporalDiagnosticBody } from "./action-compilation-coherence";
import { restoreActionContextLayout } from "./action-context-layout";
import { temporalProbeContext, type TemporalProbeBody } from "./temporal-diagnostic";

it("corrects only model instructions and reversibly lays out the same schema, actions and references", () => {
  const literal = "conditional profiles require a non-empty onset-true `continuationAssertions` array";
  const context = {
    referenceCatalog: { candidates: [
      { candidateKey: "candidate_000000000000", kind: "action", scope: { kind: "slot", slot: 0 } },
      { candidateKey: "candidate_000000000001", kind: "temporal_profile", details: { kind: "conditional" }, scope: { kind: "shared" } },
    ] },
    task: { slots: [{ slot: 0, action: { rawText: literal }, actionReferences: { actionCandidateKey: "candidate_000000000000" },
      temporalProfileEligibility: [{ profileRef: "candidate_000000000001", eligible: true }] }] },
  };
  const prompt = representedActionCompilationPrompt("T");
  const source: TemporalProbeBody = { model: "deepseek-v4-flash", max_tokens: 131072, thinking: { type: "disabled" }, response_format: { type: "json_object" }, messages: [
    { role: "system", content: prompt.system },
    { role: "user", content: composeJsonObjectPrompt({ userPrompt: prompt.userPrompt, contextJson: JSON.stringify(context),
      schemaJson: JSON.stringify(z.toJSONSchema(new ActionCompilationCodec("T", context).wireSchema(context), { target: "draft-07" })),
      exampleJson: '{"slots":[]}', discriminator: "" }) },
  ] };
  const before = structuredClone(source), corrected = coherentTemporalDiagnosticBody(source, false), layout = coherentTemporalDiagnosticBody(source, true);
  expect(temporalProbeContext(corrected)).toEqual(context);
  expect(contentHash(restoreActionContextLayout(temporalProbeContext(layout)))).toBe(contentHash(context));
  expect(corrected.messages[1]!.content.split("Runtime context below")[0]).not.toContain(literal);
  expect(temporalProbeContext(layout).task.slots[0]!.action.rawText).toBe(literal);
  expect(corrected.messages[1]!.content.split("\nJSON Schema: ")[1]).toBe(source.messages[1]!.content.split("\nJSON Schema: ")[1]);
  expect(layout.messages[0]).toEqual(corrected.messages[0]);
  expect(Buffer.byteLength(layout.messages[1]!.content)).toBe(Buffer.byteLength(corrected.messages[1]!.content));
  expect(source).toEqual(before);
});
