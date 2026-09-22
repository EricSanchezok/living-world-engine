import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { DEEPSEEK_JSON_STREAM } from "../../src/engine/models/deepseek-json-stream";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";

export const E3_SNAPSHOT = "4f6530d4868b8613bd027a36cf609c215bf58e57c879f9553f833f441f305e1a";
export const E3_PRICE = { accountId: "deepseek-api", modelId: "deepseek-flash", inputHitNanoCnyPerToken: 40,
  inputMissNanoCnyPerToken: 2000, outputNanoCnyPerToken: 8000,
  pricingSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", pricingCheckedAt: "2026-09-22" } as const;
export const E3_PHASES = { P1: { cny: 100, http: 60 }, P2: { cny: 300, http: 2400 } } as const;
export const json = <T = unknown>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
export function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", flush: true });
}
export function cleanRevision() {
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked code before new model inference");
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** One process owns this journal and the provider's original concurrency limit. */
export function e3Environment(root: string, phase: keyof typeof E3_PHASES, options: {
  beforeSend?: (request: Request, body: string, trial: string) => Promise<void>;
  stopReason?: () => string | undefined;
} = {}) {
  const catalog = loadModelCatalog(path.join(root, "models.yaml")), registry = new ModelRegistry(catalog, path.join(root, "data"));
  registry.snapshot(E3_SNAPSHOT);
  const budget = new ExperimentBudget(path.join(root, `${phase}-budget.jsonl`), {
    maximumNanoCny: E3_PHASES[phase].cny * 1e9, ...E3_PRICE,
    maxHttpRequests: { [phase === "P1" ? "discovery" : "trajectory"]: E3_PHASES[phase].http },
    maxKnownTokens: { discovery: Number.MAX_SAFE_INTEGER, trajectory: Number.MAX_SAFE_INTEGER },
    maxConcurrentRequests: 16, prices: { flash: E3_PRICE },
  });
  const network = createModelFetchResolver(process.env);
  let transport: FirstPassExperimentTransport | undefined, trial = "";
  const pending = new Set<Promise<unknown>>();
  const gateway = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
    registry: { catalog, capture: async hash => registry.snapshot(hash ?? E3_SNAPSHOT),
      refresh: async () => { throw new ModelConfigurationError("Frozen model registry refresh disabled"); }, status: () => registry.status() },
    fetchForAccount: (id, account) => {
      if (id !== E3_PRICE.accountId) throw new ModelConfigurationError("E3 account drift");
      if (!transport) {
        transport = new FirstPassExperimentTransport(budget, { root: path.join(root, phase), baseUrl: account.base_url,
        inputTokenCeiling: 1_048_576, outputTokenCeiling: 131_072, fetch: network(id, account) ?? fetch,
        allowLowerOutputLimit: true, priceBinding: { accountId: id, modelId: E3_PRICE.modelId, priceId: "flash" },
        scheduling: "provider", requireThinkingDisabled: true, responseTransport: DEEPSEEK_JSON_STREAM,
          trialPattern: /^(discovery|trajectory)-[a-zA-Z0-9-]+$/u });
        // A gateway can resolve its fetch lazily, after beginTrial.
        if (trial) transport.beginTrial(trial, phase === "P1" ? "discovery" : "trajectory");
      }
      return async (input, init) => {
        const reason = options.stopReason?.();
        if (reason) throw new ModelConfigurationError(reason);
        const request = new Request(input, init);
        if (options.beforeSend) await options.beforeSend(request, await request.clone().text(), trial);
        return transport!.fetch(input, init);
      };
    },
  });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: async request => {
      const reason = options.stopReason?.();
      if (reason) throw new ModelConfigurationError(reason);
      const call = gateway.generateStructured({ ...request, modelRegistrySnapshotHash: E3_SNAPSHOT });
      pending.add(call);
      try { return await call; } finally { pending.delete(call); }
    } };
  return { catalog, registry, provider, budget,
    beginTrial(id: string) {
      if (pending.size) throw new Error("Cannot replace an active E3 trial");
      trial = id;
      transport?.beginTrial(id, phase === "P1" ? "discovery" : "trajectory");
    },
    stopReason: () => transport?.stopReason ?? undefined,
    async drain() { while (pending.size) await Promise.allSettled([...pending]); },
    checkpoint(name: string, value: unknown) { save(path.join(root, name), { ...value as object,
      budget: budget.summary, budgetHash: contentHash(budget.summary) }); },
  };
}
