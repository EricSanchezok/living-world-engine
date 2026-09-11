import { isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import type { ProviderAccountConfig } from "./model-catalog";
import { createHttpsDnsLookup } from "./model-dns";
import { boundedModelConnector, type ModelConnectionEvent } from "./model-connector";

export type AccountFetchResolver = (
  accountId: string,
  account: ProviderAccountConfig,
) => typeof fetch | undefined;

/**
 * Creates opt-in account transports for environments where a TUN route wins
 * over a reachable physical interface. The catalog carries only the name of
 * the environment variable; the address is read at process start and is
 * never included in model audits or persisted state.
 */
export function createModelFetchResolver(
  env: Readonly<Record<string, string | undefined>>,
  options: { onConnectionEvent?: (event: ModelConnectionEvent & { accountId: string }) => void } = {},
): AccountFetchResolver {
  const transports = new Map<string, { dispatcher: Agent; fetch: typeof fetch }>();

  return (accountId, account) => {
    const addressEnv = account.network?.local_address_env;
    const localAddress = addressEnv ? env[addressEnv]?.trim() : undefined;
    const dnsResolver = account.network?.dns_over_https_url;
    const connectAttempts = account.network?.socket_connect_attempts ?? 1;
    if (!localAddress && !dnsResolver && connectAttempts === 1) return undefined;
    if (localAddress && isIP(localAddress) === 0) {
      throw new Error(
        `model account ${accountId} requires ${addressEnv} to contain a local IP address`,
      );
    }

    const key = JSON.stringify([accountId, account.base_url, localAddress, dnsResolver, connectAttempts]);
    const existing = transports.get(key);
    if (existing) return existing.fetch;

    // Undici's Agent takes `localAddress` at the top level. Putting it inside
    // `connect` leaves the Client's per-request localAddress null, so macOS
    // still routes the TLS handshake through the VPN TUN interface.
    const dispatcher = new Agent({ ...(localAddress ? { localAddress } : {}),
      // Allow the bounded DNS window plus TLS setup; Undici's shorter default
      // would otherwise abort the same connection before its lookup completes.
      ...(dnsResolver || connectAttempts === 2 ? { connect: boundedModelConnector(
        buildConnector({ ...(dnsResolver ? { lookup: createHttpsDnsLookup(dnsResolver) } : {}), timeout: 75_000 }),
        { maxAttempts: connectAttempts,
          observe: (event) => options.onConnectionEvent?.({ ...event, accountId }) },
      ) } : {}) });
    const boundFetch: typeof fetch = async (input, init) => {
      if (dnsResolver) {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== new URL(account.base_url).origin) throw new Error("account DNS transport cannot change provider origin");
      }
      // Node's global Request type and undici's bundled Request type differ
      // slightly across supported Node versions, while the runtime contract
      // is the same fetch(input, init) surface used by the AI SDK.
      const response = await undiciFetch(
        input as unknown as Parameters<typeof undiciFetch>[0],
        { ...init, ...(dnsResolver ? { redirect: "error" as const } : {}), dispatcher } as Parameters<typeof undiciFetch>[1],
      );
      return response as unknown as Response;
    };
    transports.set(key, { dispatcher, fetch: boundFetch });
    return boundFetch;
  };
}
