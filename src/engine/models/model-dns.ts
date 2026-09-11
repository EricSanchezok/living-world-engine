import { isIPv4, type LookupFunction } from "node:net";
import { z } from "zod";

const answerSchema = z.object({
  Status: z.literal(0),
  TC: z.literal(false),
  Question: z.array(z.object({ name: z.string(), type: z.number() })),
  Answer: z.array(z.object({ name: z.string(), type: z.number(), TTL: z.number().int().nonnegative(), data: z.string() })),
});
const name = (value: string) => value.toLowerCase().replace(/\.$/u, "");
// Full local batches can delay network callbacks beyond the old ten-second limit.
// Keep a bounded lookup window; this does not retry a provider request.
export const ACCOUNT_DNS_TIMEOUT_MS = 60_000;

/** IPv4 DNS JSON transport, scoped by its owning account; see decision 0107. */
export function createHttpsDnsLookup(endpoint: string, options: { fetch?: typeof fetch; now?: () => number } = {}): LookupFunction {
  const resolver = new URL(endpoint);
  if (resolver.protocol !== "https:" || resolver.username || resolver.password || resolver.search || resolver.hash) {
    throw new Error("DNS resolver must use HTTPS without credentials, query, or fragment");
  }
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; addresses: string[] }>();
  const pending = new Map<string, Promise<string[]>>();
  const resolve = async (hostname: string): Promise<string[]> => {
    const cached = cache.get(hostname);
    if (cached && cached.expiresAt > now()) return cached.addresses;
    const active = pending.get(hostname);
    if (active) return active;
    const request = (async () => {
      const started = now();
      const url = new URL(resolver);
      url.searchParams.set("name", hostname);
      url.searchParams.set("type", "A");
      const response = await send(url, { headers: { accept: "application/dns-json" }, redirect: "error", signal: AbortSignal.timeout(ACCOUNT_DNS_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`DNS resolver returned HTTP ${response.status}`);
      const result = answerSchema.parse(await response.json());
      if (result.Question.length !== 1 || name(result.Question[0]!.name) !== hostname || result.Question[0]!.type !== 1) {
        throw new Error("DNS response question does not match the requested hostname");
      }
      const names = new Set([hostname]);
      for (let pass = 0; pass < result.Answer.length; pass += 1) {
        for (const answer of result.Answer) if (answer.type === 5 && names.has(name(answer.name))) names.add(name(answer.data));
      }
      const records = result.Answer.filter((answer) => names.has(name(answer.name)) && (answer.type === 1 || answer.type === 5));
      const addresses = [...new Set(records.filter((answer) => answer.type === 1 && isIPv4(answer.data)).map((answer) => answer.data))];
      if (!addresses.length) throw new Error("DNS response has no IPv4 address for the requested hostname");
      cache.set(hostname, { expiresAt: started + Math.min(...records.map((answer) => answer.TTL)) * 1000, addresses });
      return addresses;
    })();
    pending.set(hostname, request);
    try { return await request; }
    finally { pending.delete(hostname); }
  };
  return (hostname, lookupOptions, callback) => {
    if (lookupOptions.family === 6) {
      callback(Object.assign(new Error("account HTTPS DNS lookup supports IPv4 only"), { code: "ENOTFOUND" }), "", 4);
      return;
    }
    void resolve(name(hostname)).then(
      (addresses) => callback(null, lookupOptions.all ? addresses.map((address) => ({ address, family: 4 })) : addresses[0]!, 4),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), "", 4),
    );
  };
}
