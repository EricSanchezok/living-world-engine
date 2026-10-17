import { ModelCatalog } from "../../src/engine/models/model-catalog";

export function sourceAdjudicationCatalog(base: ModelCatalog, options: {
  profileId: string; baseProfileId: string; modelId: string;
  effort: "low" | "high" | "max"; accountConcurrency: number; thinking?: "auto" | "enabled";
}) {
  const template = base.profile(options.baseProfileId);
  return new ModelCatalog({ schema_version: base.schemaVersion, scheduler: base.scheduler,
    registry: base.registry, accounts: { ...structuredClone(base.accounts),
      [template.account_id]: { ...base.accounts[template.account_id]!, max_concurrency: options.accountConcurrency } },
    profiles: { ...structuredClone(base.profiles), [options.profileId]: { ...template,
      allowed_roles: ["creation"], description: "Source-bound independent literary adjudication",
      request_timeout_ms: 600000, max_output_tokens: 65536, max_input_bytes: 4000000,
      selector: { kind: "exact", model_id: options.modelId },
      inference: { ...template.inference, thinking: options.thinking ?? "auto", effort: options.effort },
    } }, model_overrides: structuredClone(base.modelOverrides) });
}
