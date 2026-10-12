import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ExperimentBudget, deepSeekExperimentUsage, type ExperimentBudgetPolicy } from "../action-compilation/experiment-budget";
import { contentHash } from "../../models/model-audit";
import { loadModelCatalog, parseModelCatalog } from "../../models/model-catalog";
import { ModelRegistry } from "../../models/model-registry";
import { ModelGateway } from "../../models/model-gateway";
import { createModelFetchResolver } from "../../models/model-network";
import { RecordingRuntimeObserver } from "../../runtime/observability";

/** Conservative budget conversion for this qualification, not a market FX quote. */
export const JEV_BUDGET_POLICY: ExperimentBudgetPolicy = {
  maximumNanoCny: 100_000_000_000 - Math.ceil(0.035729814 * 8 * 1_000_000_000),
  inputMissNanoCnyPerToken: 2400, inputHitNanoCnyPerToken: 48, outputNanoCnyPerToken: 9600,
  maxConcurrentRequests: 16, maxHttpRequests: { trajectory: 10000 }, maxKnownTokens: { trajectory: 1_000_000_000 },
  prices: {
    jev: { accountId: "typesafe-api", modelId: "jev-1.13.0", inputMissNanoCnyPerToken: 336, inputHitNanoCnyPerToken: 336,
      outputNanoCnyPerToken: 0, pricingCheckedAt: "2026-10-12", pricingSource: "https://docs.typesafe.ai/models" },
    deepseek: { accountId: "deepseek-api", modelId: "deepseek-flash", inputMissNanoCnyPerToken: 2400, inputHitNanoCnyPerToken: 48,
      outputNanoCnyPerToken: 9600, pricingCheckedAt: "2026-10-12", pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/" },
  },
};

/** One shared append-only budget, with an exclusive process lease before any paid request. */
export function createJevLiveRuntime(root = path.resolve(".livingworld-benchmarks/jev-engine")) {
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, "budget.lock");
  const descriptor = openSync(lock, "wx", 0o600);
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); closeSync(descriptor);
  try {
    const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), JEV_BUDGET_POLICY);
    const source = loadModelCatalog();
    const catalog = parseModelCatalog({ schema_version: 3, scheduler: source.scheduler, registry: source.registry,
      accounts: Object.fromEntries(["typesafe-api", "deepseek-api"].map(id => [id, source.account(id)])),
      profiles: Object.fromEntries(["decision-jev", "decision-deepseek", "creation-deepseek"].map(id => [id, source.profile(id)])),
      model_overrides: { typesafe: source.modelOverrides.typesafe, deepseek: source.modelOverrides.deepseek } });
    const registry = new ModelRegistry(catalog, root);
    const observer = new RecordingRuntimeObserver({ mode: "full" });
    const resolver = createModelFetchResolver(process.env);
    const gateway = new ModelGateway(catalog, process.env, { registry, observer, maxTransportAttempts: 1,
      fetchForAccount(accountId, account) {
        const transport = resolver(accountId, account) ?? fetch;
        return async (url, init) => {
          if (typeof init?.body !== "string") throw new Error("live budget requires a complete JSON request before dispatch");
          const body = JSON.parse(init.body), native = accountId === "typesafe-api";
          if (body.model !== (native ? "jev-1.13.0" : "deepseek-flash")) throw new Error("unpriced live model");
          const id = randomUUID();
          budget.reserve({ id, trialId: "jev-engine", phase: "trajectory", priceId: native ? "jev" : "deepseek",
            inputCeiling: native ? 64000 : Buffer.byteLength(init.body, "utf8") + 4096,
            outputCeiling: native ? 4_000_000 : Number(body.max_tokens ?? body.max_output_tokens) });
          try {
            const response = await transport(url, init);
            const raw = await response.clone().text();
            let value: unknown;
            if (response.headers.get("content-type")?.includes("text/event-stream")) {
              const packets = raw.split(/\r?\n/u).filter(line => line.startsWith("data:") && !line.includes("[DONE]"))
                .map(line => JSON.parse(line.slice(5).trim()) as { usage?: unknown });
              value = packets.findLast(packet => packet.usage != null);
            } else value = JSON.parse(raw);
            if (!response.ok) throw new Error(`HTTP ${response.status}; reservation retained until evidence review`);
            if (native) {
              const usage = (value as { usage: { input_tokens: number; output_tokens: number } }).usage;
              budget.settle(id, { input: usage.input_tokens, output: usage.output_tokens, cacheHit: 0 });
            } else budget.settle(id, deepSeekExperimentUsage(value));
            return response;
          } catch (error) {
            budget.markUnknown(id);
            throw error;
          }
        };
      },
    });
    let closed = false;
    return { root, catalog, registry, gateway, budget, observer,
      close(label: string) {
        if (closed) return; closed = true;
        try {
          const events = observer.snapshot();
          writeFileSync(path.join(root, `${label}-${contentHash(events).slice(0, 16)}.json`), JSON.stringify({
            budget: budget.summary, planningProbeUsd: 0.035729814, budgetConversionCnyPerUsd: 8, events,
          }, null, 2));
        } finally { registry.stopBackgroundRefresh(); unlinkSync(lock); }
      },
    };
  } catch (error) { unlinkSync(lock); throw error; }
}
