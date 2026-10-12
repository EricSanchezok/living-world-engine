import type { ModelExecutionAudit, ModelInvocationAudit } from "../contracts/model";

/** Conservative qualification schedule. The USD conversion is a budget ceiling, not a market FX quote. */
export const DECISION_MODEL_PRICES = {
  jev: { accountId: "typesafe-api", modelId: "jev-1.13.0", inputMissNanoCnyPerToken: 336, inputHitNanoCnyPerToken: 336,
    outputNanoCnyPerToken: 0, pricingCheckedAt: "2026-10-12", pricingSource: "https://docs.typesafe.ai/models" },
  deepseek: { accountId: "deepseek-api", modelId: "deepseek-flash", inputMissNanoCnyPerToken: 2400, inputHitNanoCnyPerToken: 48,
    outputNanoCnyPerToken: 9600, pricingCheckedAt: "2026-10-12", pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/" },
} as const;

export function estimateModelCost(audit: Pick<ModelExecutionAudit, "accountId" | "modelId">, invocation: ModelInvocationAudit) {
  const price = Object.values(DECISION_MODEL_PRICES).find(price => price.accountId === audit.accountId && price.modelId === audit.modelId);
  const { input, output, cacheRead } = invocation.tokenUsage;
  const known = price && input !== null && output !== null;
  const hit = Math.min(input ?? 0, Math.max(0, cacheRead ?? 0));
  return { estimateCny: known ? ((input! - hit) * price.inputMissNanoCnyPerToken + hit * price.inputHitNanoCnyPerToken +
    output! * price.outputNanoCnyPerToken) / 1e9 : null,
    unknownTransportUsage: invocation.transports.some(transport => transport.status !== "succeeded"),
    pricingCheckedAt: price?.pricingCheckedAt ?? null, pricingSource: price?.pricingSource ?? null };
}
