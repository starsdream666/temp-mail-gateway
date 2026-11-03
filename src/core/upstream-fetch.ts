import { AppError } from "./errors";

/** A deadline covers headers and the response stream on both Node and Workers. */
export const UPSTREAM_TIMEOUT_MS = 30_000;
export const MAX_BUFFERED_RESPONSE_BYTES = 4 * 1024 * 1024;

export function createUpstreamFetch(fetchFn: typeof fetch = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const abort = new AbortController();
    const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    // The signal can fire between reads, when no Promise.race is currently waiting.
    void aborted.catch(() => {});
    const onParentAbort = () => abort.abort(parent?.reason ?? new Error("请求已取消"));
    const timer = setTimeout(() => abort.abort(new Error(`上游请求超过 ${timeoutMs}ms 时限`)), timeoutMs);
    const cleanup = () => { clearTimeout(timer); parent?.removeEventListener("abort", onParentAbort); };
    abort.signal.addEventListener("abort", () => {
      cleanup();
      rejectAbort(abort.signal.reason);
      if (reader) void reader.cancel(abort.signal.reason).catch(() => {});
    }, { once: true });
    parent?.addEventListener("abort", onParentAbort, { once: true });
    if (parent?.aborted) onParentAbort();
    let pending: Promise<Response> | undefined;
    try {
      if (abort.signal.aborted) throw abort.signal.reason;
      pending = fetchFn(input, { ...init, signal: abort.signal });
      const res = await Promise.race([pending, aborted]);
      if (!res.body) { cleanup(); return res; }
      reader = res.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await Promise.race([reader!.read(), aborted]);
            if (abort.signal.aborted) throw abort.signal.reason;
            if (chunk.done) { cleanup(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { cleanup(); controller.error(error); }
        },
        cancel(reason) {
          cleanup();
          abort.abort(reason ?? new Error("响应已取消"));
          // Do not wait on a misbehaving upstream's cancel promise.
          return undefined;
        },
      }, { highWaterMark: 0 }), res);
    } catch (error) {
      cleanup();
      // A transport that ignores AbortSignal may resolve after the deadline.
      if (pending) void pending.then(res => res.body?.cancel()).catch(() => {});
      throw error;
    }
  };
}

/** Bounded reads for endpoints whose JSON needs rewriting; other endpoints stay streamed. */
export async function readBoundedText(res: Response, maxBytes = MAX_BUFFERED_RESPONSE_BYTES): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error(`上游响应超过 ${maxBytes} 字节处理上限`);
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw new AppError("UPSTREAM_ERROR", error instanceof Error ? error.message : "无法读取上游响应");
  } finally { reader.releaseLock(); }
}
