// biome-ignore-all lint/style/noNonNullAssertion: every index below is into a fixed-size typed array and in range by construction; checking each one would slow the hot loop for nothing.

/**
 * Usage-event keys, bit-identical to cc-usage's `parser.ledger_key`:
 *
 *     int.from_bytes(blake2b(material.encode("utf-8", "surrogatepass"), digest_size=8)
 *                    .digest(), "big", signed=True)
 *
 * Imported cc-usage history and freshly parsed events must get the same key, or every
 * imported row would count a second time next to its live twin.
 */

/**
 * Version of the rules that turn transcript lines into keyed usage rows, as cc-usage's
 * `KEY_SCHEME` (1: Claude `(requestId, message.id)` / `uuid`; Codex session + timestamp +
 * counters). Bump it only together with a `KEY_SCHEME_MIGRATIONS` entry in the store.
 * Typed `number`, not the literal, so guards comparing it to other schemes type-check.
 */
export const KEY_SCHEME: number = 1;

// ── WTF-8 ────────────────────────────────────────────────────────────────────────
// Python's `surrogatepass` writes a lone surrogate as its 3-byte generalized UTF-8 form.
// `TextEncoder` would write U+FFFD instead and change the key. A valid surrogate pair is
// one astral code point in both languages (json.loads joins escaped pairs), so it takes
// the 4-byte form. A Python str holding a high and a low surrogate as two separate code
// points has no JS counterpart, and json.loads never produces one.
let bytes = new Uint8Array(1024);

/** Encodes `s` into `bytes` (grown as needed) and returns the byte length. */
function encodeWtf8(s: string): number {
  const n = s.length;
  if (bytes.length < n * 3) bytes = new Uint8Array(Math.max(n * 3, bytes.length * 2));
  const out = bytes;
  let p = 0;
  for (let i = 0; i < n; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out[p++] = c;
    } else if (c < 0x800) {
      out[p++] = 0xc0 | (c >> 6);
      out[p++] = 0x80 | (c & 0x3f);
    } else {
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
          out[p++] = 0xf0 | (c >> 18);
          out[p++] = 0x80 | ((c >> 12) & 0x3f);
          out[p++] = 0x80 | ((c >> 6) & 0x3f);
          out[p++] = 0x80 | (c & 0x3f);
          continue;
        }
      }
      out[p++] = 0xe0 | (c >> 12);
      out[p++] = 0x80 | ((c >> 6) & 0x3f);
      out[p++] = 0x80 | (c & 0x3f);
    }
  }
  return p;
}

// ── BLAKE2b, unkeyed, 8-byte digest ──────────────────────────────────────────────
// Bun's BoringSSL has no BLAKE2b with a custom output length, so this is a pure-TS port
// (after blakejs): each 64-bit word is a (lo, hi) pair of 32-bit halves.
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
// The message schedule for 12 rounds, pre-doubled to index (lo, hi) pairs in `m`.
const SIGMA = new Uint8Array(
  [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  ]
    .flat()
    .map((x) => x * 2),
);
const BLOCK = 128;
const v = new Uint32Array(32);
const m = new Uint32Array(32);
const h = new Uint32Array(16);
const last = new Uint8Array(BLOCK);

const TWO32 = 0x100000000;

// One G round on the 64-bit words a, b, c, d (each a lo/hi pair in `v`) with message words
// x and y (lo/hi pairs in `m`). Words are held in locals as uint32 numbers; a sum of up to
// three of them is exact in a double, and its carry is the integer part over 2^32.
function mix(a: number, b: number, c: number, d: number, x: number, y: number): void {
  let al = v[a]!;
  let ah = v[a + 1]!;
  let bl = v[b]!;
  let bh = v[b + 1]!;
  let cl = v[c]!;
  let ch = v[c + 1]!;
  let dl = v[d]!;
  let dh = v[d + 1]!;
  let s = al + bl + m[x]!;
  ah = (ah + bh + m[x + 1]! + Math.floor(s / TWO32)) >>> 0;
  al = s >>> 0;
  // d = (d ^ a) rotated right by 32
  let tl = dl ^ al;
  dl = (dh ^ ah) >>> 0;
  dh = tl >>> 0;
  s = cl + dl;
  ch = (ch + dh + Math.floor(s / TWO32)) >>> 0;
  cl = s >>> 0;
  // b = (b ^ c) rotated right by 24
  tl = bl ^ cl;
  let th = bh ^ ch;
  bl = ((tl >>> 24) | (th << 8)) >>> 0;
  bh = ((th >>> 24) | (tl << 8)) >>> 0;
  s = al + bl + m[y]!;
  ah = (ah + bh + m[y + 1]! + Math.floor(s / TWO32)) >>> 0;
  al = s >>> 0;
  // d = (d ^ a) rotated right by 16
  tl = dl ^ al;
  th = dh ^ ah;
  dl = ((tl >>> 16) | (th << 16)) >>> 0;
  dh = ((th >>> 16) | (tl << 16)) >>> 0;
  s = cl + dl;
  ch = (ch + dh + Math.floor(s / TWO32)) >>> 0;
  cl = s >>> 0;
  // b = (b ^ c) rotated right by 63
  tl = bl ^ cl;
  th = bh ^ ch;
  bl = ((th >>> 31) | (tl << 1)) >>> 0;
  bh = ((tl >>> 31) | (th << 1)) >>> 0;
  v[a] = al;
  v[a + 1] = ah;
  v[b] = bl;
  v[b + 1] = bh;
  v[c] = cl;
  v[c + 1] = ch;
  v[d] = dl;
  v[d + 1] = dh;
}

/** Compresses the 128-byte block at `src[off]`; `t` is the byte count so far. */
function compress(src: Uint8Array, off: number, t: number, final: boolean): void {
  for (let i = 0; i < 16; i++) {
    v[i] = h[i]!;
    v[i + 16] = IV[i]!;
  }
  v[24] = v[24]! ^ t;
  v[25] = v[25]! ^ Math.floor(t / TWO32);
  if (final) {
    v[28] = ~v[28]!;
    v[29] = ~v[29]!;
  }
  for (let i = 0; i < 32; i++) {
    const o = off + i * 4;
    m[i] = src[o]! | (src[o + 1]! << 8) | (src[o + 2]! << 16) | (src[o + 3]! << 24);
  }
  for (let r = 0; r < 12 * 16; r += 16) {
    mix(0, 8, 16, 24, SIGMA[r]!, SIGMA[r + 1]!);
    mix(2, 10, 18, 26, SIGMA[r + 2]!, SIGMA[r + 3]!);
    mix(4, 12, 20, 28, SIGMA[r + 4]!, SIGMA[r + 5]!);
    mix(6, 14, 22, 30, SIGMA[r + 6]!, SIGMA[r + 7]!);
    mix(0, 10, 20, 30, SIGMA[r + 8]!, SIGMA[r + 9]!);
    mix(2, 12, 22, 24, SIGMA[r + 10]!, SIGMA[r + 11]!);
    mix(4, 14, 16, 26, SIGMA[r + 12]!, SIGMA[r + 13]!);
    mix(6, 8, 18, 28, SIGMA[r + 14]!, SIGMA[r + 15]!);
  }
  for (let i = 0; i < 16; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 16]!;
}

function byteSwap32(x: number): number {
  return ((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24);
}

/** The signed 64-bit key cc-usage derives from `material` (see the module comment). */
export function ledgerKey(material: string): bigint {
  const n = encodeWtf8(material);
  h.set(IV);
  h[0] = h[0]! ^ 0x01010008; // parameter block: digest length 8, key length 0, fanout 1, depth 1
  // Every block but the last is compressed as is; the last one (possibly empty or full)
  // is zero-padded and finalised.
  let off = 0;
  while (n - off > BLOCK) {
    compress(bytes, off, off + BLOCK, false);
    off += BLOCK;
  }
  last.fill(0);
  last.set(bytes.subarray(off, n));
  compress(last, 0, n, true);
  // The digest is h0's eight bytes, little-endian; Python reads them big-endian.
  const high = byteSwap32(h[0]!) >>> 0;
  const low = byteSwap32(h[1]!) >>> 0;
  return BigInt.asIntN(64, (BigInt(high) << 32n) | BigInt(low));
}
