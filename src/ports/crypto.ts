/**
 * 信封加密接口。实现（adapters/crypto/webcrypto.ts）用 WebCrypto AES-256-GCM，
 * Workers 与 Node 通用。
 */
export interface CryptoPort {
  /** 明文 → iv||ciphertext||tag 的 base64url 串 */
  encrypt(plaintext: string): Promise<string>;
  /** encrypt 的逆操作；篡改或密钥不符时抛 Error */
  decrypt(payload: string): Promise<string>;
}
