import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/core/ratelimit";

describe("固定窗口限流", () => {
  it("按 key 独立计数，精确到窗口边界恢复，拒绝请求不延长窗口", () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.consume("a", 100)).toBe(true);
    expect(limiter.consume("b", 500)).toBe(true);
    expect(limiter.consume("a", 1099)).toBe(false);
    expect(limiter.consume("a", 1100)).toBe(true);
    expect(limiter.consume("b", 1100)).toBe(false);
  });

  it("本次覆盖上限不改变其他 key 的默认值，调整时保留已用额度", () => {
    const limiter = new RateLimiter(1);
    expect(limiter.consume("custom", 0, 2)).toBe(true);
    expect(limiter.consume("custom", 0, 2)).toBe(true);
    expect(limiter.consume("custom", 0, 2)).toBe(false);
    expect(limiter.consume("custom", 0, 3)).toBe(true);
    expect(limiter.consume("custom", 0, 1)).toBe(false);
    expect(limiter.consume("default", 0)).toBe(true);
    expect(limiter.consume("default", 0)).toBe(false);
  });

  it("0 不限速且继续计数，恢复有限上限不会重置用量", () => {
    const limiter = new RateLimiter(1);
    expect(limiter.consume("a", 0)).toBe(true);
    expect(limiter.consume("a", 0, 0)).toBe(true);
    expect(limiter.consume("a", 0, 0)).toBe(true);
    expect(limiter.consume("a", 0, 3)).toBe(false);
    expect(limiter.consume("a", 0, 4)).toBe(true);
  });

  it("系统默认不限速时，单个 key 仍可设置有限上限", () => {
    const limiter = new RateLimiter(0);
    expect(limiter.consume("custom", 0, 1)).toBe(true);
    expect(limiter.consume("custom", 0, 1)).toBe(false);
    expect(limiter.consume("default", 0)).toBe(true);
    expect(limiter.consume("default", 0)).toBe(true);
  });
});
