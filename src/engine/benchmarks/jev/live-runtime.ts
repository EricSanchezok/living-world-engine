import { writeFileSync } from "node:fs";
import path from "node:path";
import { createJevLiveBudget } from "./live-budget";
export { JEV_BUDGET_POLICY } from "./live-budget";
import { contentHash } from "../../models/model-audit";
import { loadModelCatalog, parseModelCatalog } from "../../models/model-catalog";
import { ModelRegistry } from "../../models/model-registry";
import { ModelGateway } from "../../models/model-gateway";
import { createModelFetchResolver } from "../../models/model-network";
import { RecordingRuntimeObserver } from "../../runtime/observability";

/** One shared append-only budget, with an exclusive process lease before any paid request. */
export function createJevLiveRuntime(root = path.resolve(".livingworld-benchmarks/jev-engine"), options: { includeBaselineProfiles?: boolean } = {}) {
  const live = createJevLiveBudget(root);
  try {
    const budget = live.budget;
    const source = loadModelCatalog();
    const catalog = parseModelCatalog({ schema_version: 3, scheduler: source.scheduler, registry: source.registry,
      accounts: Object.fromEntries(["typesafe-api", "deepseek-api"].map(id => [id, source.account(id)])),
      profiles: Object.fromEntries(["decision-jev", "decision-deepseek", "creation-deepseek",
        ...(options.includeBaselineProfiles ? ["truth-deepseek", "agent-deepseek"] : [])].map(id => [id, source.profile(id)])),
      model_overrides: { typesafe: source.modelOverrides.typesafe, deepseek: source.modelOverrides.deepseek } });
    const registry = new ModelRegistry(catalog, root);
    const observer = new RecordingRuntimeObserver({ mode: "full" });
    const resolver = createModelFetchResolver(process.env);
    const gateway = new ModelGateway(catalog, process.env, { registry, observer, maxTransportAttempts: 1,
      fetchForAccount(accountId, account) {
        const transport = resolver(accountId, account) ?? fetch;
        return live.transport(accountId, transport);
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
        } finally { registry.stopBackgroundRefresh(); live.close(); }
      },
    };
  } catch (error) { live.close(); throw error; }
}
