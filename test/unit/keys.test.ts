import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, timingSafeEqualStr } from "../../src/core/keys";
import { base64Url, randomBytes } from "../../src/core/_webcompat";

describe("网关 API key 生成", () => {
  it("base64Url 只输出 base64url 字符表内的字符（回归：字节越界曾产生字面量 undefined）", () => {
    // 覆盖 0..255 全字节范围，早期实现用 256 范围索引 64 字符表会得到 undefined
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;
    const encoded = base64Url(allBytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("undefined");
  });

  it("base64Url 保留完整熵：不同输入产出不同输出", () => {
    const a = base64Url(new Uint8Array([200, 201, 202]));
    const b = base64Url(new Uint8Array([210, 211, 212]));
    expect(a).not.toBe(b);
    expect(a).not.toContain("undefined");
  });

  it("生成的 key 格式合法且 prefix 与明文一致", async () => {
    const { key, keyHash, prefix } = await generateApiKey();
    expect(key).toMatch(/^tmg_[A-Za-z0-9_-]{40,}$/);
    expect(key).not.toContain("undefined");
    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix).not.toContain("undefined");
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashApiKey(key)).toBe(keyHash);
  });

  it("多次生成互不相同（随机性）", async () => {
    const keys = await Promise.all(Array.from({ length: 20 }, () => generateApiKey()));
    expect(new Set(keys.map((k) => k.key)).size).toBe(20);
  });

  it("randomBytes 返回请求长度", () => {
    expect(randomBytes(32).byteLength).toBe(32);
  });

  it("timingSafeEqualStr 正确比较", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});
