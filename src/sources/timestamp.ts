/**
 * cc-usage's `parse_timestamp` followed by the ledger's `round(ts * 1000)`, ported from
 * CPython 3.14 so a record's epoch-ms timestamp is the one cc-usage stored:
 *
 *     s = ts.strip(); if s.endswith("Z"): s = s[:-1] + "+00:00"
 *     dt = datetime.fromisoformat(s)                       # the C implementation
 *     except ValueError: try strptime(ts.replace("Z", "+0000"), fmt) for
 *         "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"
 *     a naive result is UTC; ts = dt.timestamp(); stored = round(ts * 1000)
 *
 * Real transcripts all use one shape (`2026-06-01T00:00:00.000Z`); the rest of the
 * grammar is ported so an odd line still lands where cc-usage put it. The vectors in
 * test/fixtures/sources/timestamp-vectors.json come from cc-usage itself.
 */

// Python's str.strip() whitespace (str.isspace), which differs from JS trim(): it
// includes U+001C..U+001F and U+0085, and excludes U+FEFF.
const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

// The shape Claude Code writes. For it the general parser reduces to plain field reads,
// and between 1970 and 2255 the microsecond count stays below 2^53, so doubles are exact.
const CANONICAL = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?Z$/;

function canonicalMs(value: string): number | null {
  const m = CANONICAL.exec(value);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const frac = m[7] ?? "";
  const us = frac === "" ? 0 : Number(frac) * 10 ** (6 - frac.length);
  const micros = (daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s) * 1e6 + us;
  return roundHalfEven((micros / 1e6) * 1000);
}

/** Epoch milliseconds as cc-usage stores them, or null when cc-usage could not parse `value`. */
export function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const fast = canonicalMs(value);
  if (fast !== null) return fast;
  let s = value.replace(PY_STRIP, "");
  if (s.endsWith("Z")) s = `${s.slice(0, -1)}+00:00`;
  const micros = fromIsoFormat(s) ?? strptimeFallback(value.replaceAll("Z", "+0000"));
  return micros === null ? null : roundHalfEven(toSeconds(micros) * 1000);
}

// ── calendar ─────────────────────────────────────────────────────────────────────

function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : (DAYS_IN_MONTH[m] ?? 0);
}

/** Days from 1970-01-01 to the proleptic Gregorian date y-m-d (Howard Hinnant's algorithm). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

interface Fields {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  us: number;
  /** UTC offset in microseconds; 0 for a naive time (taken as UTC). */
  offsetUs: number;
}

/** `datetime(...)`'s range checks, then microseconds since the epoch (a bigint: year 1 or 9999 overflows 2^53). */
function toMicros(f: Fields): bigint | null {
  if (f.y < 1 || f.y > 9999 || f.mo < 1 || f.mo > 12 || f.d < 1 || f.d > daysInMonth(f.y, f.mo)) {
    return null;
  }
  if (f.h > 23 || f.mi > 59 || f.s > 59 || f.us > 999_999) return null;
  const seconds = daysFromCivil(f.y, f.mo, f.d) * 86400 + f.h * 3600 + f.mi * 60 + f.s;
  return BigInt(seconds) * 1_000_000n + BigInt(f.us) - BigInt(f.offsetUs);
}

// ── fromisoformat (CPython's C implementation, Modules/_datetimemodule.c) ───────────

/** The C parser works on the UTF-8 bytes; reads past the end see the NUL terminator. */
class Bytes {
  constructor(
    readonly b: Uint8Array,
    readonly len: number,
  ) {}
  at(i: number): number {
    return i < this.len ? (this.b[i] as number) : 0;
  }
  isDigit(i: number): boolean {
    const c = this.at(i);
    return c >= 0x30 && c <= 0x39;
  }
  /** `parse_digits`: `n` ASCII digits at `i`, or null. */
  digits(i: number, n: number): number | null {
    let v = 0;
    for (let k = 0; k < n; k++) {
      if (!this.isDigit(i + k)) return null;
      v = v * 10 + this.at(i + k) - 0x30;
    }
    return v;
  }
}

const DASH = 0x2d;
const W = 0x57;

function findSeparator(t: Bytes): number {
  const len = t.len;
  if (len === 7) return 7;
  if (t.at(4) === DASH) {
    if (t.at(5) !== W) return 10;
    if (len < 8) return -1;
    if (len > 8 && t.at(8) === DASH) {
      if (len === 9) return -1;
      if (len > 10 && t.isDigit(10)) return 8;
      return 10;
    }
    return 8;
  }
  if (t.at(4) !== W) return 8;
  let idx = 7;
  while (idx < len && t.isDigit(idx)) idx++;
  if (idx < 9) return idx;
  return idx % 2 === 0 ? 7 : 8;
}

/** Ordinal (days since 0001-01-01 = 1) -> [y, m, d], as `_ord2ymd`. */
function ordToYmd(ord: number): [number, number, number] {
  const days = ord - 719163; // 1970-01-01 is ordinal 719163
  // civil_from_days
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** `iso_to_ymd`: ISO year/week/day -> [y, m, d], or null when out of range. */
function isoToYmd(year: number, week: number, day: number): [number, number, number] | null {
  if (year < 1 || year > 9999) return null;
  if (week <= 0 || week >= 53) {
    let ok = false;
    if (week === 53) {
      const first = (daysFromCivil(year, 1, 1) + 719163) % 7; // weekday of Jan 1, Monday = 1
      ok = first === 4 || (first === 3 && isLeap(year));
    }
    if (!ok) return null;
  }
  if (day <= 0 || day >= 8) return null;
  const jan1 = daysFromCivil(year, 1, 1) + 719163;
  const firstWeekday = (jan1 + 6) % 7; // Monday = 0
  let week1Monday = jan1 - firstWeekday;
  if (firstWeekday > 3) week1Monday += 7;
  return ordToYmd(week1Monday + (week - 1) * 7 + (day - 1));
}

function parseDate(t: Bytes, len: number): [number, number, number] | null {
  let p = 0;
  const year = t.digits(p, 4);
  if (year === null) return null;
  p += 4;
  const sep = t.at(p) === DASH;
  if (sep) p++;
  if (t.at(p) === W) {
    p++;
    const week = t.digits(p, 2);
    if (week === null) return null;
    p += 2;
    let day = 1;
    // `len` is unsigned in C: -1 (an invalid separator position) compares as huge.
    if (len < 0 || p < len) {
      if (sep && t.at(p++) !== DASH) return null;
      const d = t.digits(p, 1);
      if (d === null) return null;
      day = d;
    }
    return isoToYmd(year, week, day);
  }
  const month = t.digits(p, 2);
  if (month === null) return null;
  p += 2;
  if (sep && t.at(p++) !== DASH) return null;
  const day = t.digits(p, 2);
  if (day === null) return null;
  return [year, month, day];
}

interface Hms {
  rv: number;
  h: number;
  m: number;
  s: number;
  us: number;
}

const CORRECTION = [100000, 10000, 1000, 100, 10];

/** `parse_hh_mm_ss_ff` over [start, end): rv 0 at the end of the string, 1 if more follows, < 0 on error. */
function parseHms(t: Bytes, start: number, end: number): Hms {
  const out: Hms = { rv: 0, h: 0, m: 0, s: 0, us: 0 };
  const vals: ("h" | "m" | "s")[] = ["h", "m", "s"];
  let p = start;
  let hasSep = true;
  for (let i = 0; i < 3; i++) {
    const v = t.digits(p, 2);
    if (v === null) return { ...out, rv: -3 };
    out[vals[i] as "h" | "m" | "s"] = v;
    p += 2;
    const c = t.at(p++);
    if (i === 0) hasSep = c === 0x3a;
    if (p >= end) return { ...out, rv: c !== 0 ? 1 : 0 };
    if (hasSep && c === 0x3a) {
      if (i === 2) return { ...out, rv: -4 };
      continue;
    }
    if (c === 0x2e || c === 0x2c) {
      if (i < 2) return { ...out, rv: -3 };
      break;
    }
    if (!hasSep) p--;
    else return { ...out, rv: -4 };
  }
  const toParse = Math.min(end - p, 6);
  const us = t.digits(p, toParse);
  if (us === null) return { ...out, rv: -3 };
  out.us = toParse < 6 ? us * (CORRECTION[toParse - 1] as number) : us;
  p += toParse;
  while (t.isDigit(p)) p++;
  return { ...out, rv: t.at(p) !== 0 ? 1 : 0 };
}

/** `parse_isoformat_time` from byte `start`: [hms, tz offset µs or null] or null. */
function parseTime(t: Bytes, start: number): [Hms, number | null] | null {
  const end = t.len;
  let tz = start;
  do {
    const c = t.at(tz);
    if (c === 0x5a || c === 0x2b || c === DASH) break;
  } while (++tz < end);
  const hms = parseHms(t, start, tz);
  if (hms.rv < 0) return null;
  if (tz >= end) return hms.rv === 1 ? null : [hms, null];
  if (t.at(tz) === 0x5a) return t.at(tz + 1) !== 0 ? null : [hms, 0];
  const sign = t.at(tz) === DASH ? -1 : 1;
  const off = parseHms(t, tz + 1, end);
  if (off.rv !== 0) return null;
  // CPython 3.14 checks no field of the offset on its own (+05:99 is 6:39), only that
  // the whole offset is inside one day; and a zero whole-second offset is UTC even when
  // it carries microseconds.
  const seconds = off.h * 3600 + off.m * 60 + off.s;
  if (seconds === 0) return [hms, 0];
  const micros = sign * (seconds * 1_000_000 + off.us);
  return Math.abs(micros) < 86_400_000_000 ? [hms, micros] : null;
}

const SURROGATE = /^[\ud800-\udfff]$/;

function fromIsoFormat(s: string): bigint | null {
  const cps = Array.from(s);
  if (cps.length < 7) return null;
  // A lone surrogate is allowed only as the separator (positions 7, 8 or 10), where it
  // becomes "T"; anywhere else it cannot be encoded and the string is invalid.
  for (const pos of [7, 8, 10]) {
    if (pos > cps.length) break;
    if (SURROGATE.test(cps[pos] ?? "")) {
      cps[pos] = "T";
      break;
    }
  }
  if (cps.some((c) => SURROGATE.test(c))) return null;
  const bytes = Buffer.from(cps.join(""), "utf8");
  const t = new Bytes(bytes, bytes.length);
  const sepAt = findSeparator(t);
  const date = parseDate(t, sepAt);
  if (date === null) return null;
  let [y, mo, d] = date;
  let hms: Hms = { rv: 0, h: 0, m: 0, s: 0, us: 0 };
  let offset: number | null = null;
  if (t.len > sepAt) {
    let p = sepAt + 1;
    const lead = t.at(sepAt);
    if (lead & 0x80) {
      const top = lead & 0xf0;
      p += top === 0xe0 ? 2 : top === 0xf0 ? 3 : 1;
    }
    if (p > t.len) return null;
    const time = parseTime(t, p);
    if (time === null) return null;
    [hms, offset] = time;
  }
  let h = hms.h;
  // "24:00" is midnight at the end of the day; other 24:xx times are invalid.
  if (h === 24 && mo >= 1 && mo <= 12 && d <= daysInMonth(y, mo)) {
    if (hms.m !== 0 || hms.s !== 0 || hms.us !== 0) return null;
    h = 0;
    d += 1;
    if (d > daysInMonth(y, mo)) {
      d = 1;
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
    }
  }
  return toMicros({ y, mo, d, h, mi: hms.m, s: hms.s, us: hms.us, offsetUs: offset ?? 0 });
}

// ── strptime fallback (Lib/_strptime.py) ──────────────────────────────────────────

// Python's `\d` in a str pattern is any Unicode decimal digit, and the format is
// matched case-insensitively (only the literal T is affected; %z's Z is case-sensitive).
const D = "\\p{Nd}";
const Y = `(${D}${D}${D}${D})`;
const MON = "(1[0-2]|0[1-9]|[1-9])";
const DAY = `(3[0-1]|[1-2]${D}|0[1-9]|[1-9]| [1-9])`;
const HOUR = `(2[0-3]|[0-1]${D}|${D}| ${D})`;
const MIN = `([0-5]${D}|${D})`;
const SEC = `(6[0-1]|[0-5]${D}|${D})`;
const FRAC = "([0-9]{1,6})";
const ZONE = `([+-]${D}${D}:?[0-5]${D}(?::?[0-5]${D}(?:\\.${D}{1,6})?)?|Z)`;
const BASE = `^${Y}-${MON}-${DAY}[Tt]${HOUR}:${MIN}:${SEC}`;
const FORMATS = [
  new RegExp(`${BASE}\\.${FRAC}${ZONE}`, "u"),
  new RegExp(`${BASE}${ZONE}`, "u"),
  new RegExp(BASE, "u"),
];

const ND = /^\p{Nd}$/u;

/** The value of one Unicode decimal digit: Nd digits come in aligned runs of ten from 0. */
function digitValue(ch: string): number {
  const cp = ch.codePointAt(0) as number;
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  let k = 0;
  while (k < 10 && ND.test(String.fromCodePoint(cp - k - 1))) k++;
  return k % 10;
}

/** Python's `int()` on a digit string (leading spaces allowed); null if anything else. */
function pyInt(text: string): number | null {
  const digits = Array.from(text.replace(/^ +/, ""));
  if (digits.length === 0) return null;
  let v = 0;
  for (const ch of digits) {
    if (!ND.test(ch)) return null;
    v = v * 10 + digitValue(ch);
  }
  return v;
}

/** `_strptime`'s %z: offset in microseconds, or null where Python raises. */
function zoneMicros(zone: string): number | null {
  if (zone === "Z") return 0;
  let z = Array.from(zone);
  if (z[3] === ":") {
    z = [...z.slice(0, 3), ...z.slice(4)];
    if (z.length > 5) {
      if (z[5] !== ":") return null;
      z = [...z.slice(0, 5), ...z.slice(6)];
    }
  }
  const hours = pyInt(z.slice(1, 3).join(""));
  const minutes = pyInt(z.slice(3, 5).join(""));
  const secText = z.slice(5, 7).join("");
  const seconds = secText === "" ? 0 : pyInt(secText);
  const rem = z.slice(8).join("");
  const fraction = pyInt(rem + "0".repeat(6 - Array.from(rem).length));
  if (hours === null || minutes === null || seconds === null || fraction === null) return null;
  const sign = zone.startsWith("-") ? -1 : 1;
  const micros = sign * ((hours * 3600 + minutes * 60 + seconds) * 1_000_000 + fraction);
  // datetime.timezone accepts only offsets strictly inside one day.
  return Math.abs(micros) < 86_400_000_000 ? micros : null;
}

function strptimeFallback(text: string): bigint | null {
  for (const [i, format] of FORMATS.entries()) {
    const m = format.exec(text);
    // Python matches at the start, then fails on any unconverted data left over.
    if (m === null || m[0].length !== text.length) continue;
    const [, y, mo, d, h, mi, s] = m.map((g) => (g === undefined ? null : pyInt(g)));
    if (y == null || mo == null || d == null || h == null || mi == null || s == null) continue;
    let us = 0;
    let offsetUs = 0;
    if (i === 0) {
      const frac = m[7] as string;
      us = Number(frac + "0".repeat(6 - frac.length));
    }
    if (i < 2) {
      const zone = zoneMicros(m[i === 0 ? 8 : 7] as string);
      if (zone === null) continue;
      offsetUs = zone;
    }
    const micros = toMicros({ y, mo, d, h, mi, s, us, offsetUs });
    if (micros !== null) return micros;
  }
  return null;
}

// ── float arithmetic, as Python does it ─────────────────────────────────────────

const TWO53 = 2n ** 53n;

/** `micros / 10**6` with Python's correctly rounded int true division. */
function toSeconds(micros: bigint): number {
  const neg = micros < 0n;
  const n = neg ? -micros : micros;
  if (n <= TWO53) return Number(micros) / 1e6;
  // |n| > 2^53: find the 53-bit quotient q = n * 2^k / 10^6 and round it half-even.
  const d = 1_000_000n;
  let k = 53 - (n.toString(2).length - d.toString(2).length);
  let q = 0n;
  let r = 0n;
  let den = d;
  for (;;) {
    const num = k >= 0 ? n << BigInt(k) : n;
    den = k >= 0 ? d : d << BigInt(-k);
    q = num / den;
    r = num % den;
    if (q < 2n ** 52n) k++;
    else if (q >= TWO53) k--;
    else break;
  }
  if (2n * r > den || (2n * r === den && (q & 1n) === 1n)) q += 1n;
  const value = Number(q) / 2 ** k;
  return neg ? -value : value;
}

/** Python's `round(x)` for a float: to the nearest integer, ties to even. */
function roundHalfEven(x: number): number {
  // Python returns an int, which has no negative zero.
  if (x < 0) return 0 - roundHalfEven(-x);
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
