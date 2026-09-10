import type { CryptoPort } from "../../ports/crypto";

/**
 * AES-256-GCM 信封加密，Workers / Node 通用（WebCrypto）。
 * 密文格式：base64url(iv[12] || ciphertext+tag)。
 * MASTER_KEY 为任意长度的机密串，内部 SHA-256 归一为 32 字节密钥。
 */
export function createWebCryptoCipher(masterKey: string): CryptoPort {
  if (!masterKey || masterKey.length < 16) {
    throw new Error("MASTER_KEY 未设置或过短（至少 16 字符）");
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const getKey = (): Promise<CryptoKey> =>
    crypto.subtle
      .digest("SHA-256", encoder.encode(masterKey))
      .then((raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));

  return {
    async encrypt(plaintext: string): Promise<string> {
      const key = await getKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
      const payload = new Uint8Array(iv.length + ct.length);
      payload.set(iv);
      payload.set(ct, iv.length);
      return toBase64Url(payload);
    },

    async decrypt(payloadB64: string): Promise<string> {
      const key = await getKey();
      const payload = fromBase64Url(payloadB64);
      if (payload.length <= 12) throw new Error("密文格式无效");
      const iv = payload.slice(0, 12);
      const ct = payload.slice(12);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return decoder.decode(pt);
    },
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
