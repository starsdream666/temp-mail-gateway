/**
 * 简易固定窗口限速（按网关 key）。Workers 下为单 isolate 内计数，做基础防滥用够用。
 */
interface Bucket {
  windowStart: number;
  count: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    readonly limit: number,
    private readonly windowMs: number = 3600_000,
  ) {}

  /** 按本次上限判断，修改上限不重置窗口；不限速时也记录用量。true = 放行。 */
  consume(key: string, now: number = Date.now(), limit: number = this.limit): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (limit > 0 && bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }
}
