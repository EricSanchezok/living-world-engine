import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpsDnsLookup } from "../model-dns";
import { createModelFetchResolver } from "../model-network";
import type { ProviderAccountConfig } from "../model-catalog";

const endpoint = "https://resolver.example.test/dns-query";
function answer(address = "127.0.0.1", ttl = 60) {
  return { Status: 0, TC: false, Question: [{ name: "model.example.test.", type: 1 }],
    Answer: [{ name: "model.example.test.", type: 5, TTL: ttl, data: "cdn.example.test." },
      { name: "cdn.example.test.", type: 1, TTL: 120, data: address }] };
}
function lookup(resolve: LookupFunction, family = 0): Promise<string | LookupAddress[]> {
  return new Promise((accept, reject) => resolve("model.example.test", { family, all: true },
    (error, addresses) => error ? reject(error) : accept(addresses)));
}
afterEach(() => vi.restoreAllMocks());

describe("account HTTPS DNS", () => {
  it("survives a delayed callback beyond ten seconds and still bounds one shared lookup", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("DNS deadline", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    try {
      const delayed = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((accept, reject) => {
        const timer = setTimeout(() => accept(Response.json(answer())), 20_000);
        init!.signal!.addEventListener("abort", () => { clearTimeout(timer);reject(init!.signal!.reason); }, { once: true });
      }));
      const resolve = createHttpsDnsLookup(endpoint, { fetch: delayed });
      const results = Promise.allSettled(Array.from({ length: 4 }, () => lookup(resolve)));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await results).toEqual(Array.from({ length: 4 }, () => ({ status: "fulfilled", value: [{ address: "127.0.0.1", family: 4 }] })));
      expect(delayed).toHaveBeenCalledTimes(1);

      const unavailable = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_accept, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }));
      const failing = createHttpsDnsLookup(endpoint, { fetch: unavailable });
      let finished = false;
      const failures = Promise.allSettled(Array.from({ length: 4 }, () => lookup(failing))).then((value) => { finished = true;return value; });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await failures).every((value) => value.status === "rejected" && value.reason.name === "TimeoutError")).toBe(true);
      expect(unavailable).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("refreshes at the shortest CNAME/address TTL and does not forward provider data", async () => {
    let time = 0;
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(answer(time ? "127.0.0.2" : "127.0.0.1", 2)));
    const resolve = createHttpsDnsLookup(endpoint, { fetch: send, now: () => time });
    expect(await lookup(resolve)).toEqual([{ address: "127.0.0.1", family: 4 }]);
    time = 1999;
    await lookup(resolve);
    expect(send).toHaveBeenCalledTimes(1);
    time = 2000;
    expect(await lookup(resolve)).toEqual([{ address: "127.0.0.2", family: 4 }]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[0]![0])).toBe(`${endpoint}?name=model.example.test&type=A`);
    expect(send.mock.calls[0]![1]).toMatchObject({ headers: { accept: "application/dns-json" }, redirect: "error" });
    expect(send.mock.calls[0]![1]?.body).toBeUndefined();
  });

  it("coalesces concurrent lookups and clears a failed lookup without a default DNS fallback", async () => {
    let reject!: (error: Error) => void;
    const send = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce(Response.json(answer()));
    const resolve = createHttpsDnsLookup(endpoint, { fetch: send });
    const first = lookup(resolve), second = lookup(resolve);
    reject(new Error("DNS offline"));
    expect(await Promise.allSettled([first, second])).toEqual([
      { status: "rejected", reason: new Error("DNS offline") }, { status: "rejected", reason: new Error("DNS offline") },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await lookup(resolve)).toEqual([{ address: "127.0.0.1", family: 4 }]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...answer(), Status: 3 },
    { ...answer(), TC: true },
    { ...answer(), Question: [{ name: "other.test", type: 1 }] },
    { ...answer(), Answer: [{ name: "unrelated.test", type: 1, TTL: 60, data: "127.0.0.1" }] },
    answer("not-an-address"),
  ])("rejects unusable DNS evidence %#", async (body) => {
    const resolve = createHttpsDnsLookup(endpoint, { fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)) });
    await expect(lookup(resolve)).rejects.toThrow();
  });

  it("does not cache TTL zero or silently serve IPv6 with IPv4", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(answer("127.0.0.1", 0)));
    const resolve = createHttpsDnsLookup(endpoint, { fetch: send });
    await lookup(resolve); await lookup(resolve);
    expect(send).toHaveBeenCalledTimes(2);
    await expect(lookup(resolve, 6)).rejects.toThrow("IPv4 only");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("delivers the original host, credentials and body once through a real account socket", async () => {
    const requests: Array<{ host?: string; authorization?: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ host: request.headers.host, authorization: request.headers.authorization, body });
      response.setHeader("connection", "close");
      response.end("received");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const origin = `http://model.example.test:${address.port}`;
    const account: ProviderAccountConfig = { channel: "api", region: "test", protocol: "openai-chat", dialect: "test",
      models_dev_provider_id: "test", base_url: origin, api_key_env: "TEST_KEY", max_concurrency: 1,
      network: { dns_over_https_url: endpoint } };
    const dns = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(answer()));
    try {
      const send = createModelFetchResolver({})("test", account)!;
      const response = await send(`${origin}/chat/completions`, { method: "POST", headers: { authorization: "Bearer fixture-only" }, body: "original-body" });
      expect(await response.text()).toBe("received");
      expect(requests).toEqual([{ host: `model.example.test:${address.port}`, authorization: "Bearer fixture-only", body: "original-body" }]);
      expect(dns).toHaveBeenCalledTimes(1);
      expect(dns.mock.calls[0]![1]?.headers).toEqual({ accept: "application/dns-json" });
      await expect(send("https://other.example.test", {})).rejects.toThrow("cannot change provider origin");
      expect(requests).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET"])("recovers a wrapped DNS %s before the server receives exactly one model request", async (code) => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";for await (const part of request) body += part;
      requests.push(body);response.setHeader("connection", "close");response.end("received once");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();if (!address || typeof address === "string") throw new Error("missing server port");
    const origin = `http://model.example.test:${address.port}`;
    const account: ProviderAccountConfig = { channel: "api", region: "test", protocol: "openai-chat", dialect: "test",
      models_dev_provider_id: "test", base_url: origin, api_key_env: "TEST_KEY", max_concurrency: 1,
      network: { dns_over_https_url: endpoint, socket_connect_attempts: 2 } };
    const dns = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error("resolver socket closed"), { code }) }))
      .mockImplementation(async () => Response.json(answer()));
    const events: Array<{ status: string; attempt: number; code?: string }> = [];
    try {
      const send = createModelFetchResolver({}, { onConnectionEvent: (event) => events.push(event) })("test", account)!;
      const response = await send(`${origin}/chat/completions`, { method: "POST", body: "complete frozen body" });
      expect(await response.text()).toBe("received once");
      expect(requests).toEqual(["complete frozen body"]);
      expect(dns).toHaveBeenCalledTimes(2);
      expect(events.map((event) => [event.attempt, event.status, event.code])).toEqual([
        [1, "started", undefined], [1, "failed", code], [2, "started", undefined], [2, "connected", undefined],
      ]);
    } finally { server.closeAllConnections();await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
