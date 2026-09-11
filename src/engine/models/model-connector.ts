import { randomUUID } from "node:crypto";
import type { buildConnector } from "undici";

export interface ModelConnectionEvent {
  connectionId: string;
  hostname: string;
  port: string;
  attempt: number;
  status: "started" | "connected" | "failed";
  timestamp: string;
  elapsedMs: number;
  code?: string;
}

const RETRYABLE_CONNECT_ERRORS = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

function connectionFailure(error: Error): { code?: string; retryable: boolean } {
  const seen = new Set<Error>(), codes: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (seen.has(current) || seen.size >= 32) return { code: codes[0], retryable: false };
    seen.add(current);
    const code = (current as Error & { code?: unknown }).code;
    if (code !== undefined && typeof code !== "string") return { code: codes[0], retryable: false };
    if (typeof code === "string") codes.push(code);
    current = current.cause;
  }
  return { code: codes[0], retryable: current == null && codes.length > 0 && codes.every((code) => RETRYABLE_CONNECT_ERRORS.has(code)) };
}

/** Retry only before Undici receives a socket and can write an HTTP request. */
export function boundedModelConnector(delegate: buildConnector.connector, options: {
  maxAttempts: 1 | 2;
  observe?: (event: ModelConnectionEvent) => void;
}): buildConnector.connector {
  return (settings, callback) => {
    const connectionId = randomUUID();
    let attempt = 0, finished = false;
    const connect = () => {
      attempt += 1;
      const started = performance.now();
      const emit = (status: ModelConnectionEvent["status"], code?: string) => options.observe?.({
        connectionId, hostname: settings.hostname, port: settings.port, attempt, status,
        timestamp: new Date().toISOString(), elapsedMs: performance.now() - started, ...(code ? { code } : {}),
      });
      emit("started");
      let answered = false;
      const receive: buildConnector.Callback = (error, socket) => {
        if (answered || finished) { socket?.destroy();return; }
        answered = true;
        if (error) {
          const failure = connectionFailure(error);
          emit("failed", failure.code);
          if (!settings.httpSocket && attempt < options.maxAttempts && failure.retryable) {
            queueMicrotask(connect);
            return;
          }
          finished = true;
          callback(error, null);
          return;
        }
        finished = true;
        emit("connected");
        callback(null, socket);
      };
      try { delegate(settings, receive); }
      catch (error) { receive(error instanceof Error ? error : new Error(String(error)), null); }
    };
    connect();
  };
}
