import { ModelConfigurationError } from "../../src/engine/models/model-provider";

/** Stop queued dispatch before a blocked account's active scheduler slot is released. */
export function sourceRunnerAccountFetch(fetchImplementation: typeof fetch, stop: () => void): typeof fetch {
  return async (input, init) => {
    const response = await fetchImplementation(input, init);
    if ([401, 402, 403].includes(response.status)) stop();
    return response;
  };
}

/** Check every paid dispatch, including repairs, while preserving in-flight results. */
export async function sourceRunnerCallIfActive<T>(isStopped: () => boolean, call: () => Promise<T>):
Promise<{ status: "stopped" } | { status: "returned"; value: T }> {
  if (isStopped()) return { status: "stopped" };
  return { status: "returned", value: await call() };
}

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
