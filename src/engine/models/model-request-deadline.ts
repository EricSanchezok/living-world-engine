/** Keep the deadline source alive until the complete transport has settled. */
export async function withModelRequestDeadline<T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const abortFromCaller = () => deadline.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  // AbortSignal.any holds weak references to its sources on Node 23. Owning the
  // timer and controller prevents a timeout source disappearing during GC.
  const timer = setTimeout(() => deadline.abort(new DOMException(
    "The operation was aborted due to timeout", "TimeoutError",
  )), timeoutMs);
  try {
    const result = await execute(deadline.signal);
    deadline.signal.throwIfAborted();
    return result;
  } catch (error) {
    deadline.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Cancel and drain the body reader even if fetch stops forwarding its signal after headers. */
export async function readModelResponseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) {
    signal.throwIfAborted();
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel(signal.reason).then(() => undefined, () => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    let text = "";
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return text + decoder.decode();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await cancellation;
    reader.releaseLock();
  }
}
