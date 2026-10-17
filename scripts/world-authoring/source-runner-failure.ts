import { ModelConfigurationError } from "../../src/engine/models/model-provider";

/** Account failures stop dispatch; invalid source claims remain batch-local repairs. */
export function sourceRunnerAccountBlock(error: unknown): "payment-required" | "account-unavailable" | "configuration" | null {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current instanceof ModelConfigurationError) return "configuration";
    const status = Reflect.get(current, "statusCode") ?? Reflect.get(current, "status");
    if (status === 402) return "payment-required";
    if (status === 401 || status === 403) return "account-unavailable";
  }
  return null;
}
