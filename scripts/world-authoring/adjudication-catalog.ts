import { ModelCatalog } from "../../src/engine/models/model-catalog";

export function sourceAdjudicationCatalog(base: ModelCatalog, options: {
  profileId: string; baseProfileId: string; modelId: string;
  effort: "low" | "high" | "max"; accountConcurrency: number; thinking?: "auto" | "enabled" | "disabled";
}) {
  const template = base.profile(options.baseProfileId);
  const deepSeek = base.account(template.account_id).models_dev_provider_id === "deepseek";
  const thinking = options.thinking ?? (deepSeek ? "enabled" : "auto");
  if (deepSeek && (options.modelId !== "deepseek-flash" || options.effort !== "low" || thinking === "auto")) {
    throw new Error("DeepSeek source work requires deepseek-flash with explicit disabled thinking or low effort");
  }
  return new ModelCatalog({ schema_version: base.schemaVersion, scheduler: base.scheduler,
    registry: base.registry, accounts: { ...structuredClone(base.accounts),
      [template.account_id]: { ...base.accounts[template.account_id]!, max_concurrency: options.accountConcurrency } },
    profiles: { ...structuredClone(base.profiles), [options.profileId]: { ...template,
      allowed_roles: ["creation"], description: "Source-bound independent literary adjudication",
      request_timeout_ms: 600000, max_output_tokens: 65536, max_input_bytes: 4000000,
      selector: { kind: "exact", model_id: options.modelId },
      inference: { ...template.inference, thinking, effort: thinking === "disabled" ? "auto" : options.effort },
    } }, model_overrides: structuredClone(base.modelOverrides) });
}
