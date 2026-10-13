/** Forward bytes immediately and finish accounting before exposing end-of-stream. */
export function observeResponseStream(response: Response, complete: (body: string) => void, failed?: (error: unknown) => void) {
  if (!response.body) throw new Error("stream response has no body");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let body = "", terminal = false;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void finished.catch(() => undefined);
  const fail = (error: unknown) => {
    if (terminal) return;
    terminal = true;
    try { failed?.(error); } finally { reject(error); }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          body += decoder.decode(); complete(body); terminal = true; resolve(); controller.close();
        } else {
          body += decoder.decode(next.value, { stream: true }); controller.enqueue(next.value);
        }
      } catch (error) { fail(error); controller.error(error); }
    },
    async cancel(reason) { fail(reason ?? new Error("response stream cancelled")); await reader.cancel(reason); },
  });
  return { response: new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }), finished };
}
