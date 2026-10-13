import { describe, expect, it, vi } from "vitest";
import { observeResponseStream } from "../response-stream";

describe("streaming transport accounting", () => {
  it("forwards useful bytes before the terminal usage chunk and accounts before EOF", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const complete = vi.fn(), failed = vi.fn(), encoder = new TextEncoder();
    const wrapped = observeResponseStream(new Response(new ReadableStream({ start(controller) { source = controller; } })), complete, failed);
    const reader = wrapped.response.body!.getReader();
    source.enqueue(encoder.encode("第一段"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("第一段");
    expect(complete).not.toHaveBeenCalled();
    source.enqueue(encoder.encode("终段 usage")); source.close();
    await reader.read(); expect((await reader.read()).done).toBe(true);
    await wrapped.finished;
    expect(complete).toHaveBeenCalledExactlyOnceWith("第一段终段 usage");
    expect(failed).not.toHaveBeenCalled();
  });

  it("records interrupted usage once and preserves an already delivered chunk", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const complete = vi.fn(), failed = vi.fn();
    const wrapped = observeResponseStream(new Response(new ReadableStream({ start(c) { source = c; } })), complete, failed);
    const reader = wrapped.response.body!.getReader();
    source.enqueue(new Uint8Array([65])); expect((await reader.read()).value).toEqual(new Uint8Array([65]));
    const error = new Error("connection lost"); source.error(error);
    await expect(reader.read()).rejects.toThrow("connection lost");
    await expect(wrapped.finished).rejects.toThrow("connection lost");
    expect(failed).toHaveBeenCalledExactlyOnceWith(error); expect(complete).not.toHaveBeenCalled();
  });

  it("treats missing terminal accounting as a failed stream", async () => {
    const failed = vi.fn();
    const wrapped = observeResponseStream(new Response("partial"), () => { throw new Error("no usage"); }, failed);
    await expect(wrapped.response.text()).rejects.toThrow("no usage");
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
