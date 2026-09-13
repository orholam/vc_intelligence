import { randomBytes } from "node:crypto";

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENC[now % 32] + out;
    now = Math.floor(now / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const out: number[] = [];
  for (let i = 0; i < RANDOM_LEN; i++) out.push((bytes[i] ?? 0) % 32);
  return out;
}

/** Monotonic ULID: lexicographically sortable, 128-bit, Crockford base32. */
export function ulid(): string {
  const now = Date.now();
  if (now === lastTime) {
    // increment previous randomness (monotonic within the same millisecond)
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      const cur = lastRandom[i] ?? 31;
      if (cur < 31) {
        lastRandom[i]! += 1;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((n) => ENC[n]).join("");
}

/** Opaque prefixed id, e.g. art_01J..., ent_01J..., src_01J... (§6 schemas). */
export function opaqueId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
