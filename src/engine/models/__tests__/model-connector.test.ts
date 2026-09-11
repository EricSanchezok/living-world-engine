import { createServer } from "node:http";
import { Socket } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { expect, it, vi } from "vitest";
import { boundedModelConnector, type ModelConnectionEvent } from "../model-connector";

it("recovers a failed socket setup before delivering exactly one complete HTTP request", async () => {
  const requests: Array<{ body: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";for await (const part of request) body += part;
    requests.push({ body, authorization: request.headers.authorization });response.end("accepted");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();if (!address || typeof address === "string") throw new Error("missing server port");
  const real = buildConnector({ timeout: 1000 }), events: ModelConnectionEvent[] = [];
  const delegate = vi.fn<buildConnector.connector>().mockImplementationOnce((_settings, callback) => {
    callback(Object.assign(new Error("fixture TCP timeout before socket handoff"), { code: "ETIMEDOUT" }), null);
  }).mockImplementation(real);
  const dispatcher = new Agent({ connect: boundedModelConnector(delegate, { maxAttempts: 2, observe: (event) => events.push(event) }) });
  try {
    const response = await undiciFetch(`http://127.0.0.1:${address.port}/model`, {
      dispatcher, method: "POST", body: "unchanged complete request", headers: { authorization: "Bearer fixture-only" },
    });
    expect(await response.text()).toBe("accepted");
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([{ body: "unchanged complete request", authorization: "Bearer fixture-only" }]);
    expect(events.map((event) => [event.attempt, event.status])).toEqual([[1, "started"], [1, "failed"], [2, "started"], [2, "connected"]]);
  } finally { await dispatcher.close();await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("does not repeat an HTTP request when the peer drops its response after socket handoff", async () => {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";for await (const part of request) body += part;
    received.push(body);response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();if (!address || typeof address === "string") throw new Error("missing server port");
  const delegate = vi.fn<buildConnector.connector>().mockImplementation(buildConnector({ timeout: 1000 }));
  const dispatcher = new Agent({ connect: boundedModelConnector(delegate, { maxAttempts: 2 }) });
  try {
    await expect(undiciFetch(`http://127.0.0.1:${address.port}/model`, { dispatcher, method: "POST", body: "possibly billed" })).rejects.toThrow();
    expect(received).toEqual(["possibly billed"]);
    expect(delegate).toHaveBeenCalledTimes(1);
  } finally { await dispatcher.close();await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it.each([
  ["ETIMEDOUT", 2, false, 2], ["ERR_TLS_CERT_ALTNAME_INVALID", 2, false, 1],
  ["ETIMEDOUT", 1, false, 1], ["ETIMEDOUT", 2, true, 1],
] as const)("bounds %s with %i attempts and an existing socket=%s", async (code, maxAttempts, existingSocket, attempts) => {
  const error = Object.assign(new Error("fixture connection failure"), { code });
  const delegate = vi.fn<buildConnector.connector>().mockImplementation((_settings, callback) => callback(error, null));
  const connect = boundedModelConnector(delegate, { maxAttempts });
  const callback = vi.fn();
  const socket = existingSocket ? new Socket() : undefined;
  connect({ hostname: "model.example.test", port: "443", protocol: "https:", ...(socket ? { httpSocket: socket } : {}) }, callback);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(delegate).toHaveBeenCalledTimes(attempts);
  expect(callback).toHaveBeenCalledExactlyOnceWith(error, null);
  socket?.destroy();
});

it("does not treat a wrapped certificate error or a cyclic cause as a transient connection failure", async () => {
  const certificate = new TypeError("fetch failed", { cause: Object.assign(new Error("certificate mismatch"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }) });
  const cyclic = Object.assign(new Error("cyclic connection failure"), { code: "ECONNRESET", cause: undefined as unknown });
  cyclic.cause = cyclic;
  for (const error of [certificate, cyclic]) {
    const delegate = vi.fn<buildConnector.connector>().mockImplementation((_settings, callback) => callback(error, null));
    const callback = vi.fn();
    boundedModelConnector(delegate, { maxAttempts: 2 })({ hostname: "model.example.test", port: "443", protocol: "https:" }, callback);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith(error, null);
  }
});
