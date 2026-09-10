import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "../../core/errors";
import { UpstreamError } from "../../ports/upstream";
import { StoreError } from "../../ports/stores";
import { ZodError } from "zod";

/**
 * 统一错误信封：{ error: { code, message, details? } }
 * AppError / UpstreamError / StoreError / ZodError 各自映射；其余按 500 处理并吞掉细节。
 */
export async function errorHandler(err: unknown, c: Context): Promise<Response> {
  if (err instanceof AppError) {
    return respond(c, err.status as ContentfulStatusCode, err.code, err.message, err.details);
  }

  if (err instanceof UpstreamError) {
    const status =
      err.code === "AUTH_FAILED" ? 502
      : err.code === "RATE_LIMITED" ? 429
      : err.code === "UNAVAILABLE" ? 502
      : err.code === "BAD_REQUEST" ? 400
      : err.code === "NOT_FOUND" ? 404
      : err.code === "CAPABILITY_MISSING" ? 501
      : 502;
    return respond(c, status, "UPSTREAM_ERROR", err.message, { upstreamId: err.upstreamId, upstreamCode: err.code });
  }

  if (err instanceof StoreError) {
    const status = err.code === "UPSTREAM_IN_USE" ? 409 : err.code === "CONFLICT" ? 409 : 404;
    return respond(c, status, err.code, err.message);
  }

  if (err instanceof ZodError) {
    return respond(c, 400, "VALIDATION_ERROR", "请求参数不合法", err.issues);
  }

  console.error("[gateway] unhandled error:", err);
  return respond(c, 500, "INTERNAL", "网关内部错误");
}

function respond(c: Context, status: ContentfulStatusCode, code: string, message: string, details?: unknown): Response {
  const body = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return c.json(body, status);
}
