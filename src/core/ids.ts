/**
 * ULID（Crockford Base32，非单调版本）。48 位时间戳 + 80 位随机。
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export function newId(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < TIME_LEN; i++) {
    time = ENCODING[t % 32] + time;
    t = Math.floor(t / 32);
  }

  const rand = crypto.getRandomValues(new Uint8Array(RANDOM_LEN));
  let random = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    random += ENCODING[rand[i]! % 32];
  }
  return time + random;
}
