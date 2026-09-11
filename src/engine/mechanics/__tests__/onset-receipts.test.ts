import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { onsetPerceptionReportSchema, type OnsetPerceptionReportDraft } from "../../contracts/llm-schemas";
import { createAgentReferenceResolver, existingReferenceHandleSchema, proposalKeySchema } from "../../contracts/model-context";
import { createTruthReferenceResolver } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import { ScriptedModelProvider } from "../../testing/model-provider";
import { resolveD20Checks } from "../random";
import {
  materializeOnsetPerceptionReceipts, validateOnsetPerceptionReceipts,
  type OnsetReceiptInput, type OnsetPerceptionReceipt,
} from "../onset-receipts";

function fixture(): OnsetReceiptInput {
  const provider = new ScriptedModelProvider(() => { throw new Error("no model call in receipt materialization"); });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  return { definition, state, requests: [], checks: [], targets: [{ observerId: "keeper", sourceActionId: "player-onset" }],
    actions: [{ id: "player-onset", actorId: "player", baseRevision: state.revision,
      rawText: "I stand still, secretly think PASSWORD_ALPHA and plan a delivery tomorrow.",
      goal: "Recall my secret", means: null, targetIds: [] }] };
}

function report(kind: "perceived" | "no_stimulus" = "perceived"): OnsetPerceptionReportDraft {
  const base = { targetIndex: 0, reason: "The visible posture is established; the silent thought is not observable.",
    evidence: [{ kind: "entity" as const, ref: existingReferenceHandleSchema.parse("ref:entity:player") }], checkRefs: [] };
  return kind === "no_stimulus" ? { ...base, kind } : { ...base, kind, stimulus: {
    summary: "The traveler remains still.", introductions: [], apparentClaims: [], sourceEventRefs: [],
  } };
}

function reseal(receipt: OnsetPerceptionReceipt): void {
  const { contentHash: _digest, ...body } = receipt;
  void _digest;
  receipt.contentHash = contentHash(body);
}

it("retains the adjudicated private view when only the unobservable source intention changes", () => {
  const a = fixture(), b = structuredClone(a);
  b.actions = a.actions.map(action => ({ ...action, rawText: action.rawText.replace("ALPHA", "BETA") }));
  const beforeA = contentHash(a), beforeB = contentHash(b);
  const [left] = materializeOnsetPerceptionReceipts(a, [report()]);
  const [right] = materializeOnsetPerceptionReceipts(b, [report()]);
  expect(left!.kind).toBe("perceived"); expect(right!.kind).toBe("perceived");
  if (left!.kind !== "perceived" || right!.kind !== "perceived") throw new Error("missing stimulus");
  expect(left!.stimulus).toEqual(right!.stimulus);
  expect(JSON.stringify(left!.stimulus)).not.toMatch(/PASSWORD|delivery|tomorrow/);
  expect(left!.sourceActionHash).not.toBe(right!.sourceActionHash);
  expect(contentHash(a)).toBe(beforeA); expect(contentHash(b)).toBe(beforeB);
});

it("preserves explicit absence at a shared placement and supports authored remote perception without a roll", () => {
  const input = fixture();
  input.definition.laws.push({ id: "remote-onset", text: "The keeper can see the traveler's current posture through an active scrying channel, even from the gate. Silent thoughts remain imperceptible.", severity: "hard" });
  input.state.truth.placements.keeper = input.state.truth.placements.player!;
  const absent = materializeOnsetPerceptionReceipts(input, [report("no_stimulus")]);
  expect(absent[0]).not.toHaveProperty("stimulus");
  input.state.truth.placements.keeper = "gate";
  const remote = report();
  remote.reason = "An authored channel carries this onset to the observer.";
  remote.evidence = [{ kind: "law", ref: existingReferenceHandleSchema.parse("ref:law:remote-onset") }];
  const receipts = materializeOnsetPerceptionReceipts(input, [remote]);
  expect(receipts[0]).toMatchObject({ kind: "perceived", checkIds: [], evidence: [{ kind: "law", id: "remote-onset" }] });
  // Deterministic evidence transport is separate from live model semantic qualification.
});

it.each(["missing", "duplicate", "out-of-range"])("rejects %s assignments before changing the source", mode => {
  const input = fixture(), before = contentHash(input);
  const drafts = mode === "missing" ? [] : mode === "duplicate" ? [report(), report()] : [{ ...report(), targetIndex: 2 }];
  expect(() => materializeOnsetPerceptionReceipts(input, drafts)).toThrow("every assigned target exactly once");
  expect(contentHash(input)).toBe(before);
});

it("normalizes assignment order and validates every negative receipt as well as positive ones", () => {
  const input = fixture();
  input.actions = [...input.actions, { ...input.actions[0]!, id: "other-onset" }];
  input.targets = [...input.targets, { observerId: "keeper", sourceActionId: "other-onset" }];
  const receipts = materializeOnsetPerceptionReceipts(input, [{ ...report("no_stimulus"), targetIndex: 1 }, report()]);
  expect(receipts.map(value => value.targetIndex)).toEqual([0, 1]);
  const tampered = structuredClone(receipts);
  tampered[1]!.sourceActionId = "player-onset"; reseal(tampered[1]!);
  expect(() => validateOnsetPerceptionReceipts(input, tampered)).toThrow("unique assigned target");
});

it.each(["source-state", "source-action", "stimulus", "observer", "evidence", "kind", "step"])(
  "rejects a persisted receipt changed at %s", mode => {
    const input = fixture(), receipts = materializeOnsetPerceptionReceipts(input, [report()]);
    const receipt = receipts[0]!;
    if (receipt.kind !== "perceived") throw new Error("missing stimulus");
    if (mode === "source-state") { input.state.truth.elapsedSeconds++; reseal(receipt); }
    if (mode === "source-action") input.actions = input.actions.map(action => ({ ...action, goal: "Changed intent" }));
    if (mode === "stimulus") receipt.stimulus.summary = "A forged secret";
    if (mode === "observer") { receipt.stimulus.observerId = "player"; reseal(receipt); }
    if (mode === "evidence") { receipt.evidence[0]!.id = "ghost"; reseal(receipt); }
    if (mode === "kind") { receipt.stimulus.kind = "outcome"; reseal(receipt); }
    if (mode === "step") { receipt.stimulus.step++; reseal(receipt); }
    const before = contentHash(input);
    expect(() => validateOnsetPerceptionReceipts(input, receipts)).toThrow();
    expect(contentHash(input)).toBe(before);
  },
);

it("materializes introductions and claims in the observer's identity namespace", () => {
  const input = fixture(), draft = report();
  if (draft.kind !== "perceived") throw new Error("missing stimulus");
  draft.stimulus.introductions = [{ canonicalEntityRef: existingReferenceHandleSchema.parse("ref:entity:player"), localEntity: {
    proposalKey: proposalKeySchema.parse("traveler"), name: "A traveler", description: "Standing still nearby", status: "observed",
  } }];
  draft.stimulus.apparentClaims = [{ subjectRef: { proposalKey: proposalKeySchema.parse("traveler") }, predicate: "posture",
    value: { kind: "text", value: "standing still" }, description: "The traveler is standing still." }];
  const before = contentHash(input);
  const [receipt] = materializeOnsetPerceptionReceipts(input, [draft]);
  if (receipt!.kind !== "perceived") throw new Error("missing stimulus");
  const introduction = receipt!.stimulus.introductions[0]!;
  expect(introduction.canonicalEntityId).toBe("player");
  expect(introduction.localEntity.id).not.toBe("player");
  expect(receipt!.stimulus.apparentClaims[0]!.subjectId).toBe(introduction.localEntity.id);
  expect(contentHash(input)).toBe(before);
});

it("rejects another observer's local alias and future event provenance", () => {
  const input = fixture(), draft = report();
  if (draft.kind !== "perceived") throw new Error("missing stimulus");
  input.state.agents.player!.belief.localEntities["private-alias"] = {
    id: "private-alias", name: "Only known to player", description: "Private", status: "observed",
  };
  draft.stimulus.apparentClaims = [{ subjectRef: createAgentReferenceResolver(input.state.agents.player!, []).handleFor("local_entity", "private-alias"),
    predicate: "posture", value: { kind: "text", value: "standing" }, description: "Standing" }];
  expect(() => materializeOnsetPerceptionReceipts(input, [draft])).toThrow("not a handle from this request");
  draft.stimulus.apparentClaims = [];
  draft.stimulus.sourceEventRefs = [existingReferenceHandleSchema.parse("ref:event:future-delivery")];
  expect(() => materializeOnsetPerceptionReceipts(input, [draft])).toThrow("before action resolution");
});

it.each(["success", "failure", "dropped-success", "dropped-failure", "other-observer", "other-action", "no-world-basis", "uncommitted"])(
  "validates fixed check provenance (%s) without drawing again", mode => {
    const input = fixture();
    input.requests = [{ id: "onset-check", actorId: mode === "other-observer" ? "player" : "keeper", targetId: "player", ratingId: null,
      dc: mode === "failure" || mode === "dropped-failure" ? 100 : 0, modifier: 0, modifierSources: [], phase: "perception", mode: "normal", visibility: "full",
      stakes: "Notice the present movement", causes: [{ kind: "action", id: mode === "other-action" ? "other-onset" : "player-onset" },
        ...(mode === "no-world-basis" ? [] : [{ kind: "law" as const, id: "time-passes" }])] }];
    input.checks = mode === "uncommitted" ? [] : resolveD20Checks(input.state.truth.rng, input.requests).results;
    const draft = report();
    draft.checkRefs = [createTruthReferenceResolver({ ...input, checkRequests: input.requests }).handleFor("check", "onset-check")];
    if (mode.startsWith("dropped-")) draft.checkRefs = [];
    const before = contentHash(input);
    if (mode === "success") expect(materializeOnsetPerceptionReceipts(input, [draft])[0]).toMatchObject({ checkIds: ["onset-check"] });
    else expect(() => materializeOnsetPerceptionReceipts(input, [draft])).toThrow();
    if (mode === "failure") expect(materializeOnsetPerceptionReceipts(input, [{ ...report("no_stimulus"), checkRefs: draft.checkRefs }])[0]!.kind).toBe("no_stimulus");
    expect(contentHash(input)).toBe(before);
  },
);

it("requires an explicit outcome and forbids smuggling a stimulus into a negative report", () => {
  expect(onsetPerceptionReportSchema.safeParse({ ...report("no_stimulus"), stimulus: {} }).success).toBe(false);
  expect(onsetPerceptionReportSchema.safeParse({ targetIndex: 0, kind: "done" }).success).toBe(false);
  expect(() => materializeOnsetPerceptionReceipts({ ...fixture(), targets: [] }, [])).not.toThrow();
});
