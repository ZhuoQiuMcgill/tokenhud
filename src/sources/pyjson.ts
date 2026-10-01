/**
 * The few places where Python's `json.loads` and `JSON.parse` disagree in a way cc-usage's
 * rules can see, and Python's `str()` and truthiness for the values that become key
 * material.
 *
 * A JSON number written with a fraction or exponent (`5.0`, `1e3`) is a Python float, and
 * cc-usage's `_int` counts a float token field as 0; `JSON.parse` returns the number 5.
 * Integers past 2^53 lose digits in JavaScript, which changes `str()` of an id. Lines that
 * might hold either (`needsPyJson`) are parsed again with `parsePyJson`, which keeps each
 * number's literal kind. Claude Code writes its transcripts with `JSON.stringify`, which
 * never produces an integer-valued float below 1e21, so in practice the check only costs a
 * regex test per usage line.
 *
 * Not ported: Python also accepts the non-standard literals NaN and Infinity, which
 * `JSON.parse` rejects (the line is then skipped as malformed). `JSON.stringify` cannot
 * write them.
 */

/** A JSON number whose literal had a fraction or an exponent: a float to Python. */
export class PyFloat {
  constructor(readonly value: number) {}
}

/** A JSON integer literal beyond 2^53, kept exactly. */
export class PyBigInt {
  constructor(readonly value: bigint) {}
}

// A member value (a number right after `"key":`) with a fraction or an exponent, or with
// 16+ digits. Every field cc-usage reads is a member value. The test also hits such text
// inside strings (an escaped quote before a colon), which only costs a second parse: about
// 0.2% of real usage lines. Arrays are not looked into, so an id that is an array holding
// `5.0` reads as `[5]`; ids are strings in every transcript.
const RISKY_NUMBER = /"[ \t\n\r]*:[ \t\n\r]*-?(?:\d+[.eE]|\d{16})/;

/** Whether `line` may hold a number `JSON.parse` would read differently from Python. */
export function needsPyJson(line: string): boolean {
  return RISKY_NUMBER.test(line);
}

const INTEGER_LITERAL = /^-?\d+$/;

/** `JSON.parse` with Python's number kinds: PyFloat for floats, PyBigInt past 2^53. */
export function parsePyJson(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    const source = context?.source ?? String(value);
    if (!INTEGER_LITERAL.test(source)) return new PyFloat(value);
    return Number.isSafeInteger(value) ? value : new PyBigInt(BigInt(source));
  });
}

/** Python's truthiness of a JSON value. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0;
  if (value instanceof PyFloat) return value.value !== 0;
  if (value instanceof PyBigInt) return value.value !== 0n;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Python's `repr(float)`: shortest round-trip digits, exponent form outside 1e-4..1e16. */
function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mantissa, exp] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const decpt = Number(exp) + 1; // digits are 0.d1d2... * 10^decpt
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const e = decpt - 1;
  const frac = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${frac}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

// Python's str.isprintable() is false for these categories (space excepted).
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python's `repr(str)`. */
function strRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x7f || ch === " " || !NON_PRINTABLE.test(ch)) out += ch;
    else if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

/** Python's `repr()` of a parsed JSON value. */
function pyRepr(value: unknown): string {
  if (typeof value === "string") return strRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof PyFloat) &&
    !(value instanceof PyBigInt)
  ) {
    const items = Object.entries(value).map(([k, v]) => `${strRepr(k)}: ${pyRepr(v)}`);
    return `{${items.join(", ")}}`;
  }
  return pyStr(value);
}

/** Python's `str()` of a parsed JSON value, as an f-string writes it into key material. */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (value instanceof PyFloat) return floatRepr(value.value);
  if (value instanceof PyBigInt) return value.value.toString();
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : floatRepr(value);
  return pyRepr(value);
}
