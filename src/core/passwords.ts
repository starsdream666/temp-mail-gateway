import { timingSafeEqualStr } from "./keys";

// Web Crypto 同时兼容 Node 与 Workers；每次改密生成独立随机盐。
const ITERATIONS = 100_000;
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function derive(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: new TextEncoder().encode(salt) }, key, 256,
  );
  return hex(new Uint8Array(bits));
}

export async function hashAdminPassword(password: string): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2-sha256:${ITERATIONS}:${salt}:${await derive(password, salt)}`;
}

export async function verifyAdminPasswordHash(password: string, encoded: string): Promise<boolean> {
  const [scheme, iterations, salt, digest] = encoded.split(":");
  if (scheme !== "pbkdf2-sha256" || iterations !== String(ITERATIONS) || !salt || !digest) return false;
  return timingSafeEqualStr(await derive(password, salt), digest);
}
