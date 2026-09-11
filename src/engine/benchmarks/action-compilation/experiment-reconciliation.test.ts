import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { ExperimentBudget } from "./experiment-budget";
import { immutableExperimentJson } from "./experiment-artifacts";
import { reconcileNotSentTrial, verifiedNotSentHttp } from "./experiment-reconciliation";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const trialId = "discovery-P01-05-SF", httpId = `${trialId}-http-001`;
function fixture(options: { code?: string; stack?: string; calls?: number; response?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ac-fp2-not-sent-")); roots.push(root);
  const budget = new ExperimentBudget(path.join(root, "budget.jsonl"));
  budget.reserve({ id: httpId, trialId, phase: "discovery", inputCeiling: 100_000, outputCeiling: 131_072 });
  const code = options.code ?? "ETIMEDOUT";
  const evidence = { trial: { id: trialId }, calls: Array.from({ length: options.calls ?? 1 }, () => ({ error: { name: "ModelTransportError" } })),
    stateUnchanged: true, compilerAccepted: false, events: [{ event: "model.transport.failed", error: {
      cause: { code, message: `connect ${code} 198.18.0.40:443`, stack: options.stack ?? "at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1636:16)" },
    } }] };
  immutableExperimentJson(path.join(root, "frozen.json"), { hash: "frozen" });
  immutableExperimentJson(path.join(root, "trials", trialId, "result.json"), { frozenHash: "frozen", evidence, hash: contentHash(evidence), stopReason: "fetch failed" });
  immutableExperimentJson(path.join(root, "http", httpId, "request.json"), { id: httpId, trial: { id: trialId }, body: { model: "test" }, bodyHash: contentHash({ model: "test" }) });
  if (options.response) immutableExperimentJson(path.join(root, "http", httpId, "response.json"), { status: 400 });
  return { root, budget };
}

describe("proven preconnect reconciliation", () => {
  it("preserves the failed attempt and settles no-send usage exactly once, without fabricating a provider response", () => {
    const { root, budget } = fixture();
    const originalJournal = readFileSync(path.join(root, "budget.jsonl"), "utf8");
    const receipt = reconcileNotSentTrial(root, trialId, budget);
    expect(receipt.kind).toBe("tcp-connect-not-sent");
    expect(verifiedNotSentHttp(root, httpId)).toBe(true);
    expect(budget.summary.unsettled).toEqual([]);
    expect(budget.summary.phases.discovery.knownTokens).toBe(0);
    expect(budget.summary.phases.discovery.httpRequests).toBe(1); // Reserved attempt remains in the ledger.
    expect(readFileSync(path.join(root, "budget.jsonl"), "utf8").startsWith(originalJournal)).toBe(true);
    expect(existsSync(path.join(root, "http", httpId, "response.json"))).toBe(false);
    expect(existsSync(path.join(root, "not-sent-transports", httpId, "result.json"))).toBe(true);
    expect(existsSync(path.join(root, "trials", trialId))).toBe(false);
    reconcileNotSentTrial(root, trialId, budget);
    expect(readFileSync(path.join(root, "budget.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it.each([
    { code: "ECONNRESET" }, { stack: "at response timeout" }, { calls: 2 }, { response: true },
  ])("does not reconcile unknown or sampled outcomes: %j", (options) => {
    const { root, budget } = fixture(options);
    expect(() => reconcileNotSentTrial(root, trialId, budget)).toThrow();
    expect(budget.summary.unsettled).toHaveLength(1);
    expect(existsSync(path.join(root, "trials", trialId, "result.json"))).toBe(true);
  });

  it("refuses receipt corruption or a subsequently discovered provider response", () => {
    const { root, budget } = fixture();
    reconcileNotSentTrial(root, trialId, budget);
    const receiptFile = path.join(root, "http", httpId, "not-sent.json");
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    writeFileSync(receiptFile, JSON.stringify({ ...receipt, evidenceHash: "changed" }));
    expect(() => verifiedNotSentHttp(root, httpId)).toThrow("drift");
  });
});
