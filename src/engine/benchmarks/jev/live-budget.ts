import { observeResponseStream } from "../../models/response-stream";
import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DECISION_MODEL_PRICES } from "../../models/model-cost";
import { contentHash } from "../../models/model-audit";
import { ExperimentBudget, deepSeekExperimentUsage, type ExperimentBudgetPolicy } from "../action-compilation/experiment-budget";

/** Conservative conversion for the entire qualification, including the planning probes. */
export const JEV_PLANNING_NANO_CNY = Math.ceil(0.035729814 * 8 * 1_000_000_000);
export const JEV_BUDGET_POLICY: ExperimentBudgetPolicy = {
  maximumNanoCny: 100_000_000_000 - JEV_PLANNING_NANO_CNY,
  inputMissNanoCnyPerToken: 2400, inputHitNanoCnyPerToken: 48, outputNanoCnyPerToken: 9600,
  maxConcurrentRequests: 16, maxHttpRequests: { trajectory: 10000 }, maxKnownTokens: { trajectory: 1_000_000_000 },
  prices: DECISION_MODEL_PRICES,
};

/** One writer and one cumulative ceiling across frozen engines and experiment phases. */
export function createJevLiveBudget(root: string, stopReason: () => string | undefined = () => undefined) {
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, "budget.lock");
  const descriptor = openSync(lock, "wx", 0o600);
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); closeSync(descriptor);
  try {
    const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), JEV_BUDGET_POLICY);
    let trialId = "jev-engine", closed = false;
    const pending = new Set<Promise<unknown>>();
    return { budget,
      beginTrial(id: string) {
        if (pending.size || closed) throw new Error("live budget trial changed during dispatch or after close");
        trialId = id;
      },
      transport(accountId: string, transport: typeof fetch): typeof fetch {
        return (url, init) => {
          const call = (async () => {
            const reason = stopReason();
            if (closed || reason) throw new Error(reason ?? "live budget closed");
            if (!["typesafe-api", "deepseek-api"].includes(accountId)) throw new Error("unpriced live account");
            if (typeof init?.body !== "string") throw new Error("live budget requires a complete JSON request before dispatch");
            const body = JSON.parse(init.body), native = accountId === "typesafe-api";
            if (body.model !== (native ? "jev-1.13.0" : "deepseek-flash")) throw new Error("unpriced live model");
            const id = randomUUID();
            budget.reserve({ id, trialId, phase: "trajectory", priceId: native ? "jev" : "deepseek",
              inputCeiling: native ? 64000 : Buffer.byteLength(init.body, "utf8") + 4096,
              outputCeiling: native ? 4_000_000 : Number(body.max_tokens ?? body.max_output_tokens) });
            try {
              const response = await transport(url, init);
              if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
                const observed = observeResponseStream(response, raw => {
                  const packets = raw.split(/\r?\n/u).filter(line => line.startsWith("data:") && !line.includes("[DONE]"))
                    .map(line => JSON.parse(line.slice(5).trim()) as { usage?: unknown });
                  budget.settle(id, deepSeekExperimentUsage(packets.findLast(packet => packet.usage != null)));
                }, () => budget.markUnknown(id));
                pending.add(observed.finished);
                void observed.finished.finally(() => pending.delete(observed.finished)).catch(() => undefined);
                return observed.response;
              }
              const raw = await response.clone().text();
              if (!response.ok) {
                const evidence = { id, trialId, accountId, model: body.model, requestHash: contentHash(body), statusCode: response.status, body: raw };
                mkdirSync(path.join(root, "http-rejections"), { recursive: true });
                writeFileSync(path.join(root, "http-rejections", `${id}.json`), JSON.stringify(evidence), { flag: "wx", mode: 0o600, flush: true });
                budget.holdHttpRejection(id, { statusCode: response.status, evidenceHash: contentHash(evidence),
                  reason: "Terminal provider rejection retained with its full reservation; no zero-usage assumption" });
                return response;
              }
              let value: unknown;
              if (response.headers.get("content-type")?.includes("text/event-stream")) {
                const packets = raw.split(/\r?\n/u).filter(line => line.startsWith("data:") && !line.includes("[DONE]"))
                  .map(line => JSON.parse(line.slice(5).trim()) as { usage?: unknown });
                value = packets.findLast(packet => packet.usage != null);
              } else value = JSON.parse(raw);
              if (native) {
                const usage = (value as { usage: { input_tokens: number; output_tokens: number } }).usage;
                budget.settle(id, { input: usage.input_tokens, output: usage.output_tokens, cacheHit: 0 });
              } else budget.settle(id, deepSeekExperimentUsage(value));
              return response;
            } catch (error) { budget.markUnknown(id); throw error; }
          })();
          pending.add(call);
          void call.finally(() => pending.delete(call)).catch(() => undefined);
          return call;
        };
      },
      async drain() { while (pending.size) await Promise.allSettled([...pending]); },
      close() {
        if (closed) return;
        if (pending.size) throw new Error("cannot release live budget with unsettled transports");
        closed = true; unlinkSync(lock);
      },
    };
  } catch (error) { unlinkSync(lock); throw error; }
}
