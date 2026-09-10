/** 网关自身的业务错误，onError 中间件统一转为错误信封。 */
export type AppErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "DOMAIN_NOT_ROUTED"
  | "DOMAIN_DISABLED"
  | "DOMAIN_NOT_ALLOWED"
  | "CHANNEL_NOT_ALLOWED"
  | "DOMAIN_REQUIRED"
  | "UPSTREAM_REQUIRED"
  | "LOCAL_PART_TAKEN"
  | "MAILBOX_NOT_FOUND"
  | "MAILBOX_EXPIRED"
  | "FORCE_DELETE_UNSAFE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "ADAPTER_MISSING"
  | "CAPABILITY_MISSING"
  | "UPSTREAM_IN_USE"
  | "KEY_PLAINTEXT_UNAVAILABLE"
  | "CONFLICT"
  | "INTERNAL";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  DOMAIN_NOT_ROUTED: 400,
  DOMAIN_DISABLED: 403,
  DOMAIN_NOT_ALLOWED: 403,
  CHANNEL_NOT_ALLOWED: 403,
  DOMAIN_REQUIRED: 400,
  UPSTREAM_REQUIRED: 400,
  LOCAL_PART_TAKEN: 409,
  MAILBOX_NOT_FOUND: 404,
  // 410 Gone：邮箱曾存在但已到期，上游已回收——与「从未存在」(404) 和
  // 「上游故障」(502) 都不同，客户端据此提示"已过期"而不是让用户以为服务坏了
  MAILBOX_EXPIRED: 410,
  FORCE_DELETE_UNSAFE: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  ADAPTER_MISSING: 500,
  CAPABILITY_MISSING: 501,
  UPSTREAM_IN_USE: 409,
  KEY_PLAINTEXT_UNAVAILABLE: 409,
  CONFLICT: 409,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}
