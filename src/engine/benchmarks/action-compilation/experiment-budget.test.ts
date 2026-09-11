import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deepSeekExperimentUsage, ExperimentBudget } from "./experiment-budget";
import { AC_FP2_BUDGET } from "./constrained-first-pass-protocol";
import { AC_FP3_BUDGET } from "./semantic-first-pass-protocol";
import type { ExperimentBudgetPolicy } from "./experiment-budget";
import { contentHash } from "../../models/model-audit";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function journal(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ac-fp1-budget-"));
  roots.push(root);
  return path.join(root, "usage.jsonl");
}
const reservation = { id: "http-1", trialId: "P01-B1-0", phase: "discovery" as const, inputCeiling: 1_000_000, outputCeiling: 131_072 };

describe("provider model cohorts in one budget", () => {
  const old = { accountId: "account", modelId: "retired", inputMissNanoCnyPerToken: 4, inputHitNanoCnyPerToken: 2,
    outputNanoCnyPerToken: 8, pricingSource: "https://example.org/tariff", pricingCheckedAt: "2026-09-09" };
  const price = { ...old, modelId: "served", inputMissNanoCnyPerToken: 2, inputHitNanoCnyPerToken: 1, outputNanoCnyPerToken: 4 };
  const policy: ExperimentBudgetPolicy = { ...old, maximumNanoCny: 200, prices: { old }, maxConcurrentRequests: 2,
    maxHttpRequests: { discovery: 20 }, maxKnownTokens: { discovery: 1000 }, phaseBudgets: [{ phases: ["discovery"], maximumNanoCny: 300 }] };
  const evidence = { reason: "Official retirement and rates bound to the complete response and usage", evidenceHash: "a".repeat(64) };
  const registration = { priceId: "new", price, ...evidence };
  const review = { id: "routed", priceId: "new", requestedModelId: "retired", servedModelId: "served",
    usage: { input: 10, cacheHit: 4, output: 2 }, ...evidence };
  function setup() {
    const file = journal(), budget = new ExperimentBudget(file, policy);
    budget.authorizeTranche({ id: "existing-grant", amountNanoCny: 100, priorExposureNanoCny: 0, ...evidence });
    budget.reserve({ ...reservation, id: "unknown", trialId: "unknown-source", inputCeiling: 5, outputCeiling: 1, priceId: "old" });
    budget.markUnknown("unknown"); budget.quarantineUnknown("unknown", evidence);
    budget.reserve({ ...reservation, id: "routed", trialId: "routed-source", inputCeiling: 10, outputCeiling: 2, priceId: "old" });
    budget.markUnknown("routed");
    return { file, budget };
  }
  it("retains old holds and the same grant while reconciling the actual served price and recovering admission", () => {
    const { file, budget } = setup(), prefix = readFileSync(file, "utf8"), before = budget.summary;
    budget.registerModelPrice(registration);
    expect(budget.summary.tranche).toEqual(before.tranche);
    expect(() => budget.reserve({ ...reservation, id: "blocked", priceId: "new", inputCeiling: 1, outputCeiling: 1 })).toThrow("blocks further");
    budget.reconcileRoutedUsage(review);
    expect(readFileSync(file, "utf8").startsWith(prefix)).toBe(true);
    expect(budget.summary).toMatchObject({ originalEstimatedPeakNanoCny: 48, estimatedPeakNanoCny: 24, reservedNanoCny: 28,
      blockingUnknown: [], unknown: ["unknown"], tranche: { amountNanoCny: 100, knownNanoCny: 24, reservedNanoCny: 28, remainingNanoCny: 48 } });
    const reopened = new ExperimentBudget(file, policy);
    expect(reopened.summary).toEqual(budget.summary);
    const exposed = reopened.price("new")!; exposed.modelId = "mutated";
    expect(reopened.price("new")!.modelId).toBe("served");
    expect(() => reopened.reserve({ ...reservation, id: "retry", trialId: "routed-source", inputCeiling: 1, outputCeiling: 1, priceId: "new" })).toThrow("permanently closed");
    reopened.reserve({ ...reservation, id: "fresh", trialId: "new-source", inputCeiling: 10, outputCeiling: 2, priceId: "new" });
    reopened.settle("fresh", review.usage);
    expect(reopened.summary.tranche?.remainingNanoCny).toBe(24);
    expect(() => reopened.reconcileRoutedUsage(review)).toThrow("binding mismatch");
    expect(new ExperimentBudget(file, policy).summary).toEqual(reopened.summary);
  });
  it("rejects duplicate, account/model mismatches, unsafe usage and rate changes without writing", () => {
    const { file, budget } = setup(); budget.registerModelPrice(registration);
    const prefix = readFileSync(file, "utf8");
    for (const input of [{ ...registration, priceId: "old" }, registration,
      { ...registration, priceId: "negative", price: { ...price, outputNanoCnyPerToken: -1 } }]) {
      expect(() => budget.registerModelPrice(input)).toThrow(); expect(readFileSync(file, "utf8")).toBe(prefix);
    }
    for (const input of [{ ...review, priceId: "missing" }, { ...review, requestedModelId: "wrong" },
      { ...review, servedModelId: "wrong" }, { ...review, evidenceHash: "invalid" },
      { ...review, usage: { ...review.usage, input: 11 } }, { ...review, usage: { ...review.usage, cacheHit: 11 } }]) {
      expect(() => budget.reconcileRoutedUsage(input)).toThrow(); expect(readFileSync(file, "utf8")).toBe(prefix);
    }
    budget.registerModelPrice({ ...registration, priceId: "foreign", price: { ...price, accountId: "foreign" } });
    budget.registerModelPrice({ ...registration, priceId: "expensive", price: { ...price, outputNanoCnyPerToken: 100 } });
    expect(() => budget.reconcileRoutedUsage({ ...review, priceId: "foreign" })).toThrow("binding mismatch");
    expect(() => budget.reconcileRoutedUsage({ ...review, priceId: "expensive" })).toThrow("original reservation");
    budget.reconcileRoutedUsage(review);
    const frames = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const last = frames.at(-1)!; last.entry.servedModelId = "tampered"; last.sha256 = contentHash(last.entry);
    writeFileSync(file, frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
    expect(() => new ExperimentBudget(file, policy)).toThrow("binding mismatch");
  });
});

describe("reviewed account-currency peak valuation", () => {
  const price = { accountId: "account", modelId: "model", inputMissNanoCnyPerToken: 4, inputHitNanoCnyPerToken: 2,
    outputNanoCnyPerToken: 8, pricingSource: "https://example.org/tariff", pricingCheckedAt: "2026-09-05" };
  const reviewed = { ...price, inputMissNanoCnyPerToken: 3, inputHitNanoCnyPerToken: 1, outputNanoCnyPerToken: 6 };
  const policy: ExperimentBudgetPolicy = { ...price, maximumNanoCny: 200, prices: { flash: price }, maxConcurrentRequests: 2,
    maxHttpRequests: { discovery: 20 }, maxKnownTokens: { discovery: 1000 }, phaseBudgets: [{ phases: ["discovery"], maximumNanoCny: 200 }] };
  const usage = { input: 10, cacheHit: 4, output: 2 };
  const evidence = { reason: "Reviewed documented account-currency peak tariff with complete known usage.", evidenceHash: "a".repeat(64) };
  const input = { priceId: "flash", originalPriceHash: contentHash(price), price: reviewed,
    requests: [{ id: reservation.id, usageHash: contentHash(usage) }], ...evidence };
  function prepared() {
    const file = journal(), budget = new ExperimentBudget(file, policy);
    budget.reserve({ ...reservation, inputCeiling: 10, outputCeiling: 2, priceId: "flash" }); budget.settle(reservation.id, usage);
    return { file, budget };
  }

  it("appends a known-price review, retains unknown exposure and original valuation, and changes real admission after replay", () => {
    const { file, budget } = prepared();
    budget.reserve({ ...reservation, id: "unknown", trialId: "closed", inputCeiling: 10, outputCeiling: 2, priceId: "flash" });
    budget.markUnknown("unknown"); budget.quarantineUnknown("unknown", evidence);
    const prefix = readFileSync(file, "utf8");
    expect(() => budget.assertRunCapacity("discovery", 100)).toThrow("phase and total");
    budget.reviewPeakPrices(input);
    expect(readFileSync(file, "utf8").startsWith(prefix)).toBe(true);
    expect(budget.summary).toMatchObject({ estimatedPeakNanoCny: 34, originalEstimatedPeakNanoCny: 48, reservedNanoCny: 56,
      priceReviews: [{ evidenceHash: evidence.evidenceHash, requests: 1, priceHash: contentHash(reviewed) }], quarantinedUnknown: ["unknown"] });
    const reopened = new ExperimentBudget(file, policy);
    expect(reopened.summary).toEqual(budget.summary);
    expect(() => reopened.assertRunCapacity("discovery", 100)).not.toThrow();
    expect(() => reopened.reserve({ ...reservation, id: "retry", trialId: "closed", inputCeiling: 1, outputCeiling: 1, priceId: "flash" })).toThrow("permanently closed");
    reopened.reserve({ ...reservation, id: "fresh", trialId: "new", inputCeiling: 10, outputCeiling: 2, priceId: "flash" });
    reopened.settle("fresh", usage);
    expect(reopened.summary).toMatchObject({ estimatedPeakNanoCny: 82, originalEstimatedPeakNanoCny: 96, reservedNanoCny: 56 });
    expect(() => reopened.assertRunCapacity("discovery", 63)).toThrow("phase and total");
    expect(() => reopened.reviewPeakPrices(input)).toThrow("repeated price review");
  });

  it("rejects invalid price and usage bindings without writing", () => {
    const { file, budget } = prepared(), prefix = readFileSync(file, "utf8");
    const mutations = [
      { ...input, priceId: "other" }, { ...input, originalPriceHash: "b".repeat(64) },
      { ...input, price: { ...reviewed, accountId: "other" } }, { ...input, price: { ...reviewed, modelId: "other" } },
      { ...input, price: { ...reviewed, inputMissNanoCnyPerToken: 5 } },
      { ...input, price: { ...reviewed, inputHitNanoCnyPerToken: 0 } },
      { ...input, price: { ...reviewed, outputNanoCnyPerToken: -1 } },
      { ...input, requests: [{ id: "missing", usageHash: contentHash(usage) }] },
      { ...input, requests: [{ id: reservation.id, usageHash: "b".repeat(64) }] },
      { ...input, requests: [...input.requests, ...input.requests] }, { ...input, requests: [] },
    ];
    for (const mutation of mutations) {
      expect(() => budget.reviewPeakPrices(mutation)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(prefix);
    }
    budget.reviewPeakPrices(input);
    const frames = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const last = frames.at(-1)!; last.entry.requests[0].usageHash = "b".repeat(64); last.sha256 = contentHash(last.entry);
    writeFileSync(file, frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
    expect(() => new ExperimentBudget(file, policy)).toThrow("settlement/usage binding");
  });

  it("requires drained, resolved uncertainty and never reprices an unknown request", () => {
    const { file, budget } = prepared();
    budget.reserve({ ...reservation, id: "unknown", trialId: "closed", inputCeiling: 10, outputCeiling: 2, priceId: "flash" });
    expect(() => budget.reviewPeakPrices(input)).toThrow("drain all live");
    budget.markUnknown("unknown");
    expect(() => budget.reviewPeakPrices(input)).toThrow("resolve unknown");
    budget.quarantineUnknown("unknown", evidence);
    const prefix = readFileSync(file, "utf8");
    expect(() => budget.reviewPeakPrices({ ...input, requests: [{ id: "unknown", usageHash: contentHash(usage) }] })).toThrow("settlement/usage binding");
    expect(readFileSync(file, "utf8")).toBe(prefix);
  });
});

describe("prospective phase budget reallocation", () => {
  const policy: ExperimentBudgetPolicy = {
    maximumNanoCny: 100, inputMissNanoCnyPerToken: 1, inputHitNanoCnyPerToken: 1, outputNanoCnyPerToken: 1,
    maxHttpRequests: { discovery: 20, trajectory: 20 }, maxKnownTokens: { discovery: 100, trajectory: 100 }, maxConcurrentRequests: 2,
    phaseBudgets: [{ phases: ["discovery"], maximumNanoCny: 50 }, { phases: ["trajectory"], maximumNanoCny: 50 }],
  };
  const evidence = { reason: "Prospectively move unspent phase reserves within the unchanged total.", evidenceHash: "e".repeat(64) };

  it("keeps unknown exposure in its source phase and total without duplicating it in another run's phase", () => {
    const file = journal(), budget = new ExperimentBudget(file, policy);
    budget.reserve({ ...reservation, inputCeiling: 20, outputCeiling: 10 });
    budget.markUnknown(reservation.id); budget.quarantineUnknown(reservation.id, evidence);
    const prefix = readFileSync(file, "utf8");
    expect(budget.summary.phases.discovery.reservedNanoCny).toBe(30);
    expect(budget.summary.phases.trajectory.reservedNanoCny).toBe(0);
    expect(budget.summary.reservedNanoCny).toBe(30);
    expect(() => budget.assertRunCapacity("trajectory", 50)).not.toThrow();
    expect(() => budget.assertRunCapacity("trajectory", 51)).toThrow("phase and total");
    expect(() => budget.assertRunCapacity("discovery", 21)).toThrow("phase and total");
    for (const cap of [0, -1, 1.5, Number.NaN]) expect(() => budget.assertRunCapacity("trajectory", cap)).toThrow("invalid prospective");
    expect(readFileSync(file, "utf8")).toBe(prefix);
    const reopened = new ExperimentBudget(file, policy);
    expect(reopened.summary).toEqual(budget.summary);
    expect(() => reopened.assertRunCapacity("trajectory", 50)).not.toThrow();
    reopened.settle(reservation.id, { input: 10, output: 5, cacheHit: 0 });
    expect(reopened.summary.phases.discovery).toMatchObject({ estimatedPeakNanoCny: 15, reservedNanoCny: 0 });
    expect(reopened.summary.reservedNanoCny).toBe(0);
  });

  it("still blocks a run whose phase fits when reconciled historical usage exhausts the total", () => {
    const budget = new ExperimentBudget(journal(), policy);
    budget.reserve({ ...reservation, inputCeiling: 20, outputCeiling: 10 });
    budget.markUnknown(reservation.id);
    budget.reconcileUsageOverrun(reservation.id, { input: 70, output: 5, cacheHit: 0 }, evidence);
    expect(budget.summary.phases.trajectory.estimatedPeakNanoCny).toBe(0);
    expect(() => budget.assertRunCapacity("trajectory", 26)).toThrow("phase and total");
    expect(() => budget.assertRunCapacity("trajectory", 25)).not.toThrow();
  });

  it("appends allocation evidence and replays unchanged charges, prices and unknown reserves", () => {
    const file = journal(), budget = new ExperimentBudget(file, policy);
    budget.reserve({ ...reservation, inputCeiling: 20, outputCeiling: 10 });
    budget.settle(reservation.id, { input: 20, output: 5, cacheHit: 0 });
    budget.reserve({ ...reservation, id: "unknown", trialId: "closed", phase: "trajectory", inputCeiling: 10, outputCeiling: 5 });
    budget.markUnknown("unknown"); budget.quarantineUnknown("unknown", evidence);
    const prefix = readFileSync(file, "utf8"), hash = budget.policyHash;
    const allocation = [{ phases: ["discovery" as const], maximumNanoCny: 30 }, { phases: ["trajectory" as const], maximumNanoCny: 70 }];
    budget.reallocatePhases(allocation, evidence);
    expect(readFileSync(file, "utf8").startsWith(prefix)).toBe(true);
    expect(budget.policyHash).toBe(hash);
    expect(budget.summary).toMatchObject({ estimatedPeakNanoCny: 25, reservedNanoCny: 15, phaseBudgets: allocation, quarantinedUnknown: ["unknown"] });
    const reopened = new ExperimentBudget(file, policy);
    expect(reopened.summary).toEqual(budget.summary);
    expect(() => reopened.reserve({ ...reservation, id: "over-phase", inputCeiling: 4, outputCeiling: 2 })).toThrow("phase monetary");
    reopened.reserve({ ...reservation, id: "funded", trialId: "fresh", phase: "trajectory", inputCeiling: 20, outputCeiling: 20 });
    reopened.settle("funded", { input: 20, output: 5, cacheHit: 0 });
    expect(reopened.summary.estimatedPeakNanoCny).toBe(50);
    expect(reopened.summary.reservedNanoCny).toBe(15);
    expect(reopened.policy.maximumNanoCny).toBe(100);
  });

  it("rejects a larger total, missing or repeated phases and caps below held exposure without writing", () => {
    const file = journal(), budget = new ExperimentBudget(file, policy);
    budget.reserve({ ...reservation, inputCeiling: 20, outputCeiling: 10 });
    expect(() => budget.reallocatePhases(policy.phaseBudgets!, evidence)).toThrow("drain");
    budget.markUnknown(reservation.id);
    expect(() => budget.reallocatePhases(policy.phaseBudgets!, evidence)).toThrow("unknown usage");
    budget.quarantineUnknown(reservation.id, evidence);
    const original = readFileSync(file, "utf8");
    expect(() => budget.reallocatePhases([{ phases: ["discovery"], maximumNanoCny: 30 }, { phases: ["trajectory"], maximumNanoCny: 71 }], evidence)).toThrow("total budget");
    expect(() => budget.reallocatePhases([{ phases: ["discovery"], maximumNanoCny: 100 }], evidence)).toThrow("same phases");
    expect(() => budget.reallocatePhases([{ phases: ["discovery", "discovery", "trajectory"], maximumNanoCny: 100 }], evidence)).toThrow("same phases");
    expect(() => budget.reallocatePhases([{ phases: ["discovery"], maximumNanoCny: 29 }, { phases: ["trajectory"], maximumNanoCny: 71 }], evidence)).toThrow("reserved cost");
    expect(readFileSync(file, "utf8")).toBe(original);
  });
});

describe("AC-FP1 durable budget", () => {
  it("reconciles reviewed overrun usage while permanently closing the interrupted trial", () => {
    const file = journal();
    const budget = new ExperimentBudget(file, AC_FP3_BUDGET);
    const small = { ...reservation, inputCeiling: 100, outputCeiling: 10, priceId: "flash" };
    const usage = { input: 101, output: 2, cacheHit: 20 };
    const evidence = { reason: "Verified response usage exceeds the input estimate; the trial remains stopped.", evidenceHash: "c".repeat(64) };
    budget.reserve(small);
    expect(() => budget.settle(small.id, usage)).toThrow("ceiling");
    expect(() => budget.reconcileUsageOverrun(small.id, usage, evidence)).toThrow("drain");
    budget.markUnknown(small.id);
    expect(() => budget.reconcileUsageOverrun(small.id, { input: 99, output: 2, cacheHit: 0 }, evidence)).toThrow("does not exceed");
    expect(() => budget.reconcileUsageOverrun(small.id, { ...usage, cacheHit: 102 }, evidence)).toThrow("cache hit");
    budget.reconcileUsageOverrun(small.id, usage, evidence);
    expect(budget.summary.unknown).toEqual([]);
    expect(budget.summary.reservedNanoCny).toBe(0);
    expect(budget.summary.reconciledOverruns).toEqual([small.id]);
    expect(budget.summary.phases.discovery.knownTokens).toBe(103);
    expect(budget.summary.estimatedPeakNanoCny).toBe(81 * 3520 + 20 * 112 + 2 * 10560);
    const reopened = new ExperimentBudget(file, AC_FP3_BUDGET);
    expect(reopened.summary).toEqual(budget.summary);
    expect(() => reopened.reserve({ ...small, id: "same-trial" })).toThrow("permanently closed");
    expect(() => reopened.reconcileUsageOverrun(small.id, usage, evidence)).toThrow("already settled");
    reopened.reserve({ ...small, id: "new-trial", trialId: "independently-frozen-trial" });
  });

  it("records actual overrun cost even beyond a monetary ceiling and prevents further sends", () => {
    const policy = { ...AC_FP3_BUDGET, maximumNanoCny: 100 * 3520 + 10 * 10560 };
    const budget = new ExperimentBudget(journal(), policy);
    const small = { ...reservation, inputCeiling: 100, outputCeiling: 10, priceId: "flash" };
    budget.reserve(small); budget.markUnknown(small.id);
    budget.reconcileUsageOverrun(small.id, { input: 1000, output: 10, cacheHit: 0 },
      { reason: "Reviewed provider evidence establishes incurred cost, regardless of the failed reserve estimate.", evidenceHash: "d".repeat(64) });
    expect(budget.summary.estimatedPeakNanoCny).toBe(1000 * 3520 + 10 * 10560);
    expect(() => budget.reserve({ ...small, id: "new", trialId: "different" })).toThrow("CNY budget");
  });

  it("quarantines reviewed uncertainty without refunding exposure or reopening the source trial", () => {
    const file = journal();
    const policy = { ...AC_FP3_BUDGET, maxConcurrentRequests: 1 };
    const budget = new ExperimentBudget(file, policy);
    const evidence = { reason: "Reviewed HTTP400 response has no usage; reserve the full ceiling.", evidenceHash: "a".repeat(64) };
    budget.reserve({ ...reservation, priceId: "flash" });
    expect(() => budget.quarantineUnknown(reservation.id, evidence)).toThrow("drain");
    budget.markUnknown(reservation.id);
    const exposure = budget.summary.reservedNanoCny;
    expect(() => budget.reserve({ ...reservation, id: "new", trialId: "new-trial", priceId: "flash" })).toThrow("unsettled");
    budget.quarantineUnknown(reservation.id, evidence);
    expect(budget.summary.unknown).toEqual([reservation.id]);
    expect(budget.summary.quarantinedUnknown).toEqual([reservation.id]);
    expect(budget.summary.blockingUnknown).toEqual([]);
    expect(budget.summary.reservedNanoCny).toBe(exposure);
    expect(budget.summary.phases.discovery.knownTokens).toBe(0);
    expect(() => budget.reserve({ ...reservation, id: "old-trial-retry", priceId: "flash" })).toThrow("permanently closed");
    const reopened = new ExperimentBudget(file, policy);
    expect(reopened.summary).toEqual(budget.summary);
    reopened.reserve({ ...reservation, id: "new", trialId: "new-trial", priceId: "flash" });
    expect(reopened.summary.reservedNanoCny).toBe(exposure * 2);
    reopened.settle("new", { input: 1, output: 1, cacheHit: 0 });
    reopened.settle(reservation.id, { input: 1, output: 0, cacheHit: 0 });
    expect(reopened.summary.unknown).toEqual([]);
    expect(() => reopened.reserve({ ...reservation, id: "settled-trial-retry", priceId: "flash" })).toThrow("permanently closed");
  });

  it("keeps quarantined exposure in every monetary and token limit", () => {
    const small = { ...reservation, inputCeiling: 100, outputCeiling: 10, priceId: "flash" };
    const charge = 100 * 3520 + 10 * 10560;
    for (const limit of ["global", "phase", "tokens"] as const) {
      const policy = { ...AC_FP3_BUDGET,
        ...(limit === "global" ? { maximumNanoCny: charge * 2 - 1 } : {}),
        ...(limit === "phase" ? { phaseBudgets: [{ phases: ["discovery" as const], maximumNanoCny: charge * 2 - 1 }] } : {}),
        ...(limit === "tokens" ? { maxKnownTokens: { discovery: 219 } } : {}),
      };
      const budget = new ExperimentBudget(journal(), policy);
      budget.reserve(small);
      budget.markUnknown(small.id);
      budget.quarantineUnknown(small.id, { reason: "The response has no known usage; retain its ceiling.", evidenceHash: "b".repeat(64) });
      expect(() => budget.reserve({ ...small, id: "overflow", trialId: "different-trial" })).toThrow();
      expect(budget.summary.reservedNanoCny).toBe(charge);
    }
  });

  it("accounts for concurrent exposure and treats crash-recovered reservations as unknown", () => {
    const file = journal();
    const policy = { ...AC_FP3_BUDGET, maxConcurrentRequests: 3 };
    const budget = new ExperimentBudget(file, policy);
    budget.reserve({ ...reservation, priceId: "flash" });
    budget.reserve({ ...reservation, id: "http-2", priceId: "flash" });
    expect(budget.summary.inFlight).toEqual(["http-1", "http-2"]);
    expect(budget.summary.unknown).toEqual([]);
    const reopened = new ExperimentBudget(file, policy);
    expect(reopened.summary.unknown).toEqual(["http-1", "http-2"]);
    expect(reopened.summary.inFlight).toEqual([]);
    expect(() => reopened.reserve({ ...reservation, id: "http-3", priceId: "flash" })).toThrow("unsettled");
    budget.markUnknown("http-2");
    expect(() => budget.reserve({ ...reservation, id: "http-3", priceId: "flash" })).toThrow("unsettled");
    const before = budget.summary.reservedNanoCny;
    budget.settle("http-1", { input: 100, output: 2, cacheHit: 20 });
    expect(budget.summary.reservedNanoCny).toBe(before / 2);
    expect(budget.summary.unknown).toEqual(["http-2"]);
  });

  it("includes every active reservation in global, phase and token limits", () => {
    const small = { ...reservation, inputCeiling: 100, outputCeiling: 10, priceId: "flash" };
    const charge = 100 * 3520 + 10 * 10560;
    for (const limit of ["global", "phase", "tokens"] as const) {
      const policy = { ...AC_FP3_BUDGET, maxConcurrentRequests: 3,
        ...(limit === "global" ? { maximumNanoCny: charge * 2 - 1 } : {}),
        ...(limit === "phase" ? { phaseBudgets: [{ phases: ["discovery" as const], maximumNanoCny: charge * 2 - 1 }] } : {}),
        ...(limit === "tokens" ? { maxKnownTokens: { discovery: 219 } } : {}),
      };
      const budget = new ExperimentBudget(journal(), policy);
      budget.reserve(small);
      expect(() => budget.reserve({ ...small, id: "overflow" })).toThrow();
      expect(budget.summary.unsettled).toEqual(["http-1"]);
    }
  });

  it("binds each model price before sending and replays mixed-model charges", () => {
    const file = journal();
    const budget = new ExperimentBudget(file, AC_FP3_BUDGET);
    expect(() => budget.reserve(reservation)).toThrow("price binding");
    budget.reserve({ ...reservation, priceId: "flash" });
    budget.settle(reservation.id, { input: 100, output: 10, cacheHit: 30 });
    budget.reserve({ ...reservation, id: "pro-1", priceId: "pro" });
    const reopened = new ExperimentBudget(file, AC_FP3_BUDGET);
    expect(reopened.summary.reservedNanoCny).toBe(1_000_000 * 10560 + 131_072 * 31680);
    expect(() => reopened.reserve({ ...reservation, id: "flash-2", priceId: "flash" })).toThrow("unsettled");
    reopened.settle("pro-1", { input: 100, output: 10, cacheHit: 30 });
    expect(reopened.summary.estimatedPeakNanoCny).toBe(70 * (3520 + 10560) + 30 * (112 + 352) + 10 * (10560 + 31680));
    expect(readFileSync(file, "utf8")).toContain('"version":2');
    expect(() => new ExperimentBudget(file, { ...AC_FP3_BUDGET, prices: { ...AC_FP3_BUDGET.prices!, pro: { ...AC_FP3_BUDGET.prices!.pro!, outputNanoCnyPerToken: 1 } } })).toThrow("policy");
  });

  it("shares a monetary preparation cap across calibration and probes without a token cap", () => {
    const policy = { ...AC_FP3_BUDGET, phaseBudgets: [{ phases: ["calibration", "probes"] as const, maximumNanoCny: 40_000 }] };
    const budget = new ExperimentBudget(journal(), { ...policy, phaseBudgets: policy.phaseBudgets.map((row) => ({ ...row, phases: [...row.phases] })) });
    budget.reserve({ ...reservation, inputCeiling: 1, outputCeiling: 1, phase: "calibration", priceId: "flash" });
    budget.settle(reservation.id, { input: 1, output: 1, cacheHit: 0 });
    expect(() => budget.reserve({ ...reservation, id: "probe", inputCeiling: 1, outputCeiling: 1, phase: "probes", priceId: "pro" })).toThrow("monetary");
    expect(budget.summary.unsettled).toEqual([]);
  });
  it("isolates revised policy journals and reconciles Responses cache accounting", () => {
    const file = journal();
    const budget = new ExperimentBudget(file, AC_FP2_BUDGET);
    budget.reserve({ ...reservation, phase: "review" });
    const usage = deepSeekExperimentUsage({ usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 60 } } });
    budget.settle(reservation.id, usage);
    expect(budget.summary.phases.review.estimatedPeakNanoCny).toBe(40 * 3520 + 60 * 112 + 5 * 10560);
    expect(() => new ExperimentBudget(file)).toThrow("policy");
    expect(() => deepSeekExperimentUsage({ usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 101 } } })).toThrow("reconcile");
  });
  it("reserves before sending and blocks duplicate, concurrent, and crash-resumed sends", () => {
    const file = journal();
    const budget = new ExperimentBudget(file);
    budget.reserve(reservation);
    expect(readFileSync(file, "utf8")).toContain("http-1");
    expect(() => budget.reserve({ ...reservation, id: "http-2" })).toThrow(/unsettled/);
    expect(() => new ExperimentBudget(file).reserve({ ...reservation, id: "http-2" })).toThrow(/unsettled/);
    budget.settle("http-1", { input: 70_000, output: 3_000, cacheHit: 2_000 });
    expect(() => budget.reserve(reservation)).toThrow(/duplicate/);
    const resumed = new ExperimentBudget(file);
    expect(resumed.summary.phases.discovery).toEqual({ httpRequests: 1, knownTokens: 73_000, estimatedPeakNanoCny: 231_200_000, reservedNanoCny: 0 });
    resumed.reserve({ ...reservation, id: "http-2" });
    expect(resumed.summary.unsettled).toEqual(["http-2"]);
  });

  it("counts retry sends and enforces per-phase HTTP caps", () => {
    const budget = new ExperimentBudget(journal());
    for (let index = 0; index < 200; index += 1) {
      const id = `retry-${index}`;
      budget.reserve({ ...reservation, id });
      budget.settle(id, { input: 1, output: 1, cacheHit: 0 });
    }
    expect(() => budget.reserve({ ...reservation, id: "overflow" })).toThrow(/HTTP budget/);
    budget.reserve({ ...reservation, id: "confirmation-0", phase: "confirmation" });
    expect(budget.summary.phases.confirmation.httpRequests).toBe(1);
  });

  it("refuses a reserve that cannot fit the token stop line", () => {
    const budget = new ExperimentBudget(journal());
    expect(() => budget.reserve({ ...reservation, inputCeiling: 8_000_000 })).toThrow(/token reserve/);
    expect(budget.summary.phases.discovery.httpRequests).toBe(0);
  });

  it("does not release reservations for missing, inconsistent, or over-ceiling usage", () => {
    const budget = new ExperimentBudget(journal());
    budget.reserve(reservation);
    expect(() => deepSeekExperimentUsage({})).toThrow();
    expect(() => deepSeekExperimentUsage({ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 6 } })).toThrow(/reconcile/);
    expect(() => budget.settle("http-1", { input: 1_000_001, output: 0, cacheHit: 0 })).toThrow(/ceiling/);
    expect(budget.summary.unsettled).toEqual(["http-1"]);
  });

  it("rejects a truncated or changed journal instead of silently resuming", () => {
    const file = journal();
    const budget = new ExperimentBudget(file);
    budget.reserve(reservation);
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.trimEnd());
    expect(() => new ExperimentBudget(file)).toThrow(/incomplete/);
    writeFileSync(file, original.replace(budget.policyHash, "drift"));
    expect(() => new ExperimentBudget(file)).toThrow(/mismatch/);
  });

  it("does not double count cached input or reasoning included in output", () => {
    expect(deepSeekExperimentUsage({ usage: {
      prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
      prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7,
      completion_tokens_details: { reasoning_tokens: 2 },
    } })).toEqual({ input: 10, output: 4, cacheHit: 3 });
  });
});

describe("explicit additional budget tranches", () => {
  const policy: ExperimentBudgetPolicy = { maximumNanoCny: 100, inputMissNanoCnyPerToken: 1,
    inputHitNanoCnyPerToken: 1, outputNanoCnyPerToken: 1, maxConcurrentRequests: 2,
    maxHttpRequests: { discovery: 100 }, maxKnownTokens: { discovery: 10000 },
    phaseBudgets: [{ phases: ["discovery"], maximumNanoCny: 100 }] };
  const evidence = { reason: "User explicitly approved a new independent spending tranche", evidenceHash: "c".repeat(64) };
  const request = { ...reservation, inputCeiling: 9, outputCeiling: 1 };
  function prepared() {
    const file = journal(), budget = new ExperimentBudget(file, policy);
    budget.reserve(request); budget.settle(request.id, { input: 9, output: 1, cacheHit: 0 });
    budget.reserve({ ...request, id: "old-unknown", trialId: "closed" });
    budget.markUnknown("old-unknown"); budget.quarantineUnknown("old-unknown", evidence);
    return { file, budget };
  }
  const grant = { id: "new-grant", amountNanoCny: 50, priorExposureNanoCny: 20, ...evidence };

  it("preserves the journal and unknown holds while bounding new spending independently of old unused funds or refunds", () => {
    const { file, budget } = prepared(), prefix = readFileSync(file, "utf8");
    budget.authorizeTranche(grant);
    budget.reallocatePhases([{ phases: ["discovery"], maximumNanoCny: 150 }], evidence);
    expect(readFileSync(file, "utf8").startsWith(prefix)).toBe(true);
    expect(budget.summary).toMatchObject({ estimatedPeakNanoCny: 10, reservedNanoCny: 10,
      maximumNanoCny: 150, remainingNanoCny: 50, tranche: { amountNanoCny: 50, knownNanoCny: 0, reservedNanoCny: 0 } });
    expect(() => budget.assertRunCapacity("discovery", 50)).not.toThrow();
    expect(() => budget.assertRunCapacity("discovery", 51)).toThrow();
    budget.settle("old-unknown", { input: 1, output: 1, cacheHit: 0 });
    expect(budget.summary.remainingNanoCny).toBe(50);
    budget.reserve({ ...request, id: "new", trialId: "fresh", inputCeiling: 49 });
    expect(budget.summary.tranche?.reservedNanoCny).toBe(50);
    expect(() => budget.reserve({ ...request, id: "overflow", trialId: "fresh" })).toThrow("CNY budget");
    budget.settle("new", { input: 49, output: 1, cacheHit: 0 });
    expect(budget.summary.remainingNanoCny).toBe(0);
    const reopened = new ExperimentBudget(file, policy);
    expect(reopened.summary).toEqual(budget.summary);
    expect(() => reopened.reserve({ ...request, id: "reopened", trialId: "fresh" })).toThrow("CNY budget");
    expect(() => reopened.reserve({ ...request, id: "retry-old", trialId: "closed" })).toThrow("permanently closed");
  });

  it("rejects duplicate grants, wrong boundaries, unsafe amounts and tampered replay without changing valid evidence", () => {
    const { file, budget } = prepared(), prefix = readFileSync(file, "utf8");
    for (const invalid of [{ ...grant, amountNanoCny: 0 }, { ...grant, amountNanoCny: -1 },
      { ...grant, amountNanoCny: Number.MAX_SAFE_INTEGER }, { ...grant, priorExposureNanoCny: 19 }]) {
      expect(() => budget.authorizeTranche(invalid)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(prefix);
    }
    budget.authorizeTranche(grant);
    expect(() => budget.authorizeTranche(grant)).toThrow("duplicate");
    expect(() => budget.authorizeTranche({ ...grant, id: "changed-id" })).toThrow("duplicate");
    const frames = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    frames.at(-1)!.entry.priorExposureNanoCny = 0;
    frames.at(-1)!.sha256 = contentHash(frames.at(-1)!.entry);
    writeFileSync(file, frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
    expect(() => new ExperimentBudget(file, policy)).toThrow("exposure binding");
  });

  it("requires drained requests, preserves phase limits, and replaces rather than stacks unused tranche money", () => {
    const { file, budget } = prepared();
    budget.reserve({ ...request, id: "active", trialId: "fresh" });
    expect(() => budget.authorizeTranche({ ...grant, priorExposureNanoCny: 30 })).toThrow("drain all live");
    budget.markUnknown("active");
    expect(() => new ExperimentBudget(file, policy).authorizeTranche({ ...grant, priorExposureNanoCny: 30 })).toThrow("resolve unknown");
    budget.settle("active", { input: 9, output: 1, cacheHit: 0 });
    budget.authorizeTranche({ ...grant, priorExposureNanoCny: 30, amountNanoCny: 100 });
    expect(() => budget.assertRunCapacity("discovery", 80)).toThrow("phase and total");
    budget.authorizeTranche({ ...grant, id: "next", evidenceHash: "d".repeat(64), priorExposureNanoCny: 30, amountNanoCny: 15 });
    expect(budget.summary.remainingNanoCny).toBe(15);
    expect(new ExperimentBudget(file, policy).summary).toEqual(budget.summary);
  });
});
