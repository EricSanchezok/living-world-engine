import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bindFirstPassOracle, matchIntentVerdict } from "./first-pass-oracle";
import { firstPassSchedule, type FirstPassTrial } from "./first-pass-protocol";
import { confirmFirstPass, firstPassIntervals, selectFirstPassWinner, summarizeFirstPass, validateCompleteFirstPass, type FirstPassTrialScore } from "./first-pass-scoring";
import type { RawBenchmarkSource } from "../source-capture";
import { parseFirstPassArgs } from "../../../../scripts/experiments/action-compilation-first-pass";

function score(trial: FirstPassTrial): FirstPassTrialScore {
  const slots = trial.sourceId === "P04" ? 7 : 12;
  return { trial, slots, compilerAccepted: true, firstFormal: true, rawFirstFormal: true, firstFormalSlots: slots, finalFormalSlots: slots,
    firstSemantic: true, rawFirstSemantic: true, singleHttpSemantic: true, finalSemantic: true,
    firstSemanticSlots: slots, finalSemanticSlots: slots, unresolvedOutputs: 0, intentFailures: 0,
    logicalCalls: 1, repairCalls: 0, recoverySplits: 0, structuralCalls: 0, http: 1, transportRetries: 0,
    input: 80, output: 20, tokens: 100, cacheHit: 30, cacheMiss: 50, reasoning: null, cacheWrite: null, repairTokens: 0,
    wallMs: 1_000, providerMs: 900, queryEncodeMs: 50, passageEncodeMs: 0, cacheReadMs: 1,
    issueClasses: {}, rootSymbols: 375, outputReferenceCharacters: 80 };
}

describe("AC-FP1 sealed scoring", () => {
  it("binds all 43 pre-output oracle constraints to exact action identities", () => {
    const oracle = JSON.parse(readFileSync("experiments/action-compilation/ac-fp1/v1/intent-oracle.json", "utf8"));
    const sources = ["P01", "P02", "P03", "P04"].map((id) => ({ stateHash: "state", actions: oracle.actions.filter((rule: { source: string }) => rule.source === id)
      .map((rule: { actor: string }, slot: number) => ({ id: `${id}-${slot}`, actorId: rule.actor, rawText: "original action", baseRevision: 0, goal: "open", means: null, targetIds: [] })) })) as RawBenchmarkSource[];
    expect(bindFirstPassOracle(oracle, sources).actions).toHaveLength(43);
    const wrong = structuredClone(oracle); wrong.actions[0].actor = "missing";
    expect(() => bindFirstPassOracle(wrong, sources)).toThrow("omits");
    expect(matchIntentVerdict([], { oracleHash: "oracle", stateHash: "state", actionId: "action", canonicalCompilationHash: "output" })).toBe("unresolved");
  });

  it("keeps slot denominators, failures and unknown cache/reasoning distinct", () => {
    const scores = firstPassSchedule("discovery").filter((trial) => trial.arm === "B1").map(score);
    scores[0]!.compilerAccepted = false; scores[0]!.finalSemantic = false; scores[0]!.finalSemanticSlots = 0;
    const summary = summarizeFirstPass(scores);
    expect(summary).toMatchObject({ batches: 16, slots: 172, finalFormal: 15, finalSemantic: 15, tokens: 1600, cacheHit: 480, reasoning: null, cacheWrite: null });
    expect(summary.tokensPerSemanticAction).toBeGreaterThan(summary.tokensPerRequestedAction!);
  });

  it("rejects missing, duplicated and relabeled trial schedules", () => {
    const scores = firstPassSchedule("discovery").map(score);
    expect(() => validateCompleteFirstPass(scores.slice(1), "discovery")).toThrow("incomplete");
    expect(() => validateCompleteFirstPass([...scores.slice(1), scores[1]!], "discovery")).toThrow("incomplete");
    const changed = structuredClone(scores); changed[0]!.trial.sourceIndex = 99;
    expect(() => validateCompleteFirstPass(changed, "discovery")).toThrow("drifted");
  });

  it("does not select unresolved intent, unsafe outcomes or a no-gain arm", () => {
    const scores = firstPassSchedule("discovery").map(score);
    expect(selectFirstPassWinner(scores).status).toBe("no-gain");
    scores[0]!.unresolvedOutputs = 1;
    expect(selectFirstPassWinner(scores).status).toBe("unresolved");
    scores[0]!.unresolvedOutputs = 0; scores[0]!.intentFailures = 1;
    expect(selectFirstPassWinner(scores).status).toBe("semantic-review-required");
  });

  it("uses the registered ranking and simplicity tie-break, not the last tested arm", () => {
    const scores = firstPassSchedule("discovery").map(score);
    scores.filter((row) => row.trial.arm !== "B1").forEach((row) => { row.tokens = 70; });
    expect(selectFirstPassWinner(scores)).toMatchObject({ status: "eligible", arm: "A" });
    scores.find((row) => row.trial.arm === "A")!.firstSemantic = false;
    expect(selectFirstPassWinner(scores)).toMatchObject({ status: "eligible", arm: "T" });
  });

  it("reproduces paired intervals and enforces confirmation cost/semantic gates", () => {
    const scores = firstPassSchedule("confirmation", "A").map(score);
    scores.filter((row) => row.trial.arm === "A").forEach((row) => { row.tokens = 70; });
    const intervals = firstPassIntervals(scores, "A");
    expect(firstPassIntervals(scores, "A")).toEqual(intervals);
    expect(intervals).toMatchObject({ samples: 10000, firstSuccessDifference: [0, 0], tokenRatio: [.7, .7], httpRatio: [1, 1] });
    expect(confirmFirstPass(scores, "A").status).toBe("qualified-for-separate-controlled-validation");
    scores[0]!.unresolvedOutputs = 1;
    expect(confirmFirstPass(scores, "A").status).toBe("not-qualified");
    scores[0]!.unresolvedOutputs = 0;
    scores.filter((row) => row.trial.arm === "A").forEach((row) => { row.tokens = 90; });
    expect(confirmFirstPass(scores, "A").gates.tokens).toBe(false);
  });

  it("does not infer live authorization from an offline or scoring command", () => {
    expect(parseFirstPassArgs(["run"])).toMatchObject({ live: false, phase: "discovery" });
    expect(parseFirstPassArgs(["score", "--phase", "confirmation"]).command).toBe("score");
    expect(() => parseFirstPassArgs(["run", "--budget", "9999"])).toThrow("unsupported");
    expect(() => parseFirstPassArgs(["run", "--authorization"])).toThrow("requires");
  });
});
