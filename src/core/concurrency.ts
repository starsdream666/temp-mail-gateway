import type { MiddlewareHandler } from "hono";
import type { Env } from "../api/env";
import { AppError } from "./errors";

/** 与现有次数限流一致：单 Node 进程 / Workers isolate 内计数。 */
export class ConcurrencyLimiter {
  private active = new Map<string, number>();

  acquire(key: string, limit: number): () => void {
    const count = this.active.get(key) ?? 0;
    if (limit > 0 && count >= limit) throw new AppError("RATE_LIMITED", `该 Key 同时最多处理 ${limit} 个请求，请稍后重试`);
    // 不限期间也计数，调整上限后仍考虑正在执行的请求。
    this.active.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(key) ?? 1) - 1;
      if (remaining === 0) this.active.delete(key);
      else this.active.set(key, remaining);
    };
  }
}

export function limitKeyConcurrency(limiter: ConcurrencyLimiter): MiddlewareHandler<Env> {
  return async (c, next) => {
    const key = c.get("apiKey");
    if (key.id === "admin-session") return next();
    const release = limiter.acquire(key.id, key.maxConcurrentRequests ?? c.get("settings").maxConcurrentRequestsPerKey);
    try {
      await next();
      const response = c.res;
      if (!response.body) { release(); return; }
      const reader = response.body.getReader();
      // 透传响应流结束/取消/失败时释放，避免收到上游响应头就提前释放名额。
      c.res = new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) { release(); controller.close(); }
            else controller.enqueue(result.value);
          } catch (error) { release(); controller.error(error); }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); } finally { release(); }
        },
      }), response);
    } catch (error) { release(); throw error; }
  };
}
