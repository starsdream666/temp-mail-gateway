import { randomBytes, base64Url, sha256Hex } from "./_webcompat";

/**
 * 网关 API key：tmg_<43位 base64url>。
 * 库中存 SHA-256 hash（鉴权用）与 AES-GCM 密文（管理端可随时取回完整明文）；
 * 旧版本创建的 key 只存 hash，明文不可取回。
 */
const KEY_PREFIX = "tmg_";

export async function generateApiKey(): Promise<{ key: string; keyHash: string; prefix: string }> {
  const raw = base64Url(randomBytes(32));
  const key = KEY_PREFIX + raw;
  return { key, keyHash: await hashApiKey(key), prefix: key.slice(0, 12) };
}

export async function hashApiKey(key: string): Promise<string> {
  return sha256Hex(key);
}

/** 常量时间字符串比较（防时序侧信道） */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
