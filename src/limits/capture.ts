import { timestampMs } from "../sources/timestamp.ts";

/**
 * Normalised limit captures, ported from cc-usage's `limits_fetch.py` and `ratelimits.py`.
 * A capture is exactly what cc-usage keeps in `provider-limits.json`: percentages and reset
 * times in epoch seconds, never a credential or a raw response.
 */

/** One limit window of a capture. */
export interface Bucket {
  /** cc-usage's display label ("5-HOUR", "WEEKLY", "FABLE WEEKLY"); absent on rollout snapshots. */
  label?: string;
  /** 0..100 (a provider may report more than 100). */
  used_percentage: number;
  /** Epoch seconds. */
  resets_at: number;
  /** Codex windows carry their length; Claude's is known from the window's kind. */
  window_minutes?: number | null;
}

/** Where a capture came from, for reporting only (cc-usage's files have no such field). */
export type CaptureVia = "api" | "rpc" | "rollout" | "cc-usage";

export interface Capture {
  /** Epoch seconds. */
  captured_at: number;
  /** The provider, as cc-usage spells it. */
  source: "claude" | "codex";
  via?: CaptureVia;
  /** Window kind -> bucket, in the provider's order. */
  rate_limits: Record<string, Bucket>;
}

/** A provider could not return current limits. Its message never holds a credential. */
export class LimitFetchError extends Error {
  override name = "LimitFetchError";
}

/**
 * The local `codex` CLI cannot serve the app-server RPC at all: missing, unable to start,
 * or dead before it ever answered `initialize`. Retrying only respawns a doomed process, so
 * the caller latches on this and stops asking for the rest of the session (cc-usage T14 R4).
 */
export class CodexAppServerUnavailable extends LimitFetchError {
  override name = "CodexAppServerUnavailable";
}

/**
 * The account is not signed in on this machine. Claude: no credential file, no OAuth login
 * in it, or a sign-in the official client could not refresh. Codex: the app-server's
 * request was refused as unauthorised. Such an account is history-only (ARCHITECTURE.md
 * §4) and is checked again only daily or when its credential file changes.
 */
export class SignedOut extends LimitFetchError {
  override name = "SignedOut";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** cc-usage's `_epoch`: a number as is, an ISO-8601 string in epoch seconds, else null. */
export function epochSeconds(value: unknown): number | null {
  if (isNumber(value)) return value;
  if (typeof value !== "string" || value === "") return null;
  const ms = timestampMs(value);
  return ms === null ? null : ms / 1000;
}

/** cc-usage's `captured_at`: a total order for freshest-wins, -Infinity when absent. */
export function capturedAt(capture: unknown): number {
  const value = isRecord(capture) ? capture.captured_at : undefined;
  return isNumber(value) ? value : Number.NEGATIVE_INFINITY;
}

/** The freshest of `captures` by `captured_at` (the first on a tie), or null. */
export function freshest(captures: readonly (Capture | null | undefined)[]): Capture | null {
  let best: Capture | null = null;
  for (const capture of captures) {
    if (capture && (best === null || capturedAt(capture) > capturedAt(best))) best = capture;
  }
  return best;
}

// ── labels (ratelimits.py) ───────────────────────────────────────────────────────

const LABELS: Readonly<Record<string, string>> = { five_hour: "5-HOUR", seven_day: "WEEKLY" };
const ORDER = ["five_hour", "seven_day"];

export function labelFor(key: string): string {
  return LABELS[key] ?? key.replaceAll("_", " ").toUpperCase();
}

/** cc-usage's `label_for_minutes`: the label of a duration-based Codex window. */
export function labelForMinutes(minutes: unknown, fallback: string): string {
  if (!isNumber(minutes) || minutes <= 0) return labelFor(fallback);
  const value = Math.trunc(minutes);
  if (value % 10_080 === 0) {
    const weeks = value / 10_080;
    return weeks === 1 ? "WEEKLY" : `${weeks}-WEEK`;
  }
  if (value % 1_440 === 0) return `${value / 1_440}-DAY`;
  if (value % 60 === 0) return `${value / 60}-HOUR`;
  return `${value}-MIN`;
}

/** A bucket's display label, as cc-usage's `get_buckets` derives it. */
export function bucketLabel(key: string, bucket: Bucket): string {
  if (typeof bucket.label === "string" && bucket.label !== "") return bucket.label;
  return labelForMinutes(bucket.window_minutes, key);
}

/**
 * Every well-formed bucket of a capture in cc-usage's display order: `five_hour`, then
 * `seven_day`, then the rest by key (code point order, as Python sorts str).
 */
export function orderedBuckets(capture: Capture | null): [string, Bucket][] {
  if (capture === null || !isRecord(capture.rate_limits)) return [];
  const found: [string, Bucket][] = [];
  for (const [key, bucket] of Object.entries(capture.rate_limits)) {
    if (!isRecord(bucket)) continue;
    if (!isNumber(bucket.used_percentage) || !isNumber(bucket.resets_at)) continue;
    found.push([key, bucket]);
  }
  const rank = (key: string) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
  return found.sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The window's length in minutes, from cc-usage's bucket metadata: Codex windows carry
 * `window_minutes`; Claude's kinds are 5 hours (`session`, `five_hour`) or 7 days
 * (`weekly_*`, `seven_day*`). Otherwise the label, read back the way cc-usage wrote it
 * ("5-HOUR", "WEEKLY", "FABLE WEEKLY", "2-DAY"). Null when nothing says.
 */
export function windowMinutes(key: string, bucket: Bucket): number | null {
  if (isNumber(bucket.window_minutes) && bucket.window_minutes > 0) return bucket.window_minutes;
  if (key === "session" || key === "five_hour") return 300;
  if (key.startsWith("weekly") || key.startsWith("seven_day")) return 10_080;
  const label = bucket.label ?? "";
  if (/(^|\s)WEEKLY$/.test(label)) return 10_080;
  const m = /(^|\s)(\d+)-(MIN|HOUR|DAY|WEEK)$/.exec(label);
  if (m === null) return null;
  const unit = { MIN: 1, HOUR: 60, DAY: 1_440, WEEK: 10_080 }[m[3] as "MIN"];
  return Number(m[2]) * unit;
}

// ── normalisers ──────────────────────────────────────────────────────────────────

function capture(
  provider: Capture["source"],
  via: CaptureVia,
  buckets: Record<string, Bucket>,
  now: number,
): Capture {
  return { captured_at: now, source: provider, via, rate_limits: buckets };
}

/** cc-usage's `normalize_claude_limits`: Claude's usage response, scoped model limits included. */
export function normalizeClaudeLimits(data: unknown, now: number = Date.now() / 1000): Capture {
  if (!isRecord(data)) throw new LimitFetchError("Claude returned an invalid usage response");
  const buckets: Record<string, Bucket> = {};
  const limits = data.limits;
  if (Array.isArray(limits)) {
    limits.forEach((item: unknown, index) => {
      if (!isRecord(item)) return;
      const percent = item.percent;
      const resetsAt = epochSeconds(item.resets_at);
      if (!isNumber(percent) || resetsAt === null) return;
      // Python's `str(item.get("kind") or f"limit_{index}")`.
      const kind = item.kind ? String(item.kind) : `limit_${index}`;
      let scopeName: unknown = null;
      const scope = item.scope;
      if (isRecord(scope)) {
        const model = scope.model;
        if (isRecord(model)) scopeName = model.display_name || model.id;
        scopeName = scopeName || scope.surface;
      }
      let label: string;
      if (kind === "session") label = "5-HOUR";
      else if (kind === "weekly_all") label = "WEEKLY";
      else if (kind === "weekly_scoped") label = `${scopeName || "SCOPED"} WEEKLY`.toUpperCase();
      else label = kind.replaceAll("_", " ").toUpperCase();
      const key = kind in buckets ? `${kind}_${index}` : kind;
      buckets[key] = { label, used_percentage: percent, resets_at: resetsAt };
    });
  }
  if (Object.keys(buckets).length === 0) {
    for (const [key, item] of Object.entries(data)) {
      if (!isRecord(item)) continue;
      const percent = item.utilization;
      const resetsAt = epochSeconds(item.resets_at);
      if (isNumber(percent) && resetsAt !== null) {
        buckets[key] = { used_percentage: percent, resets_at: resetsAt };
      }
    }
  }
  if (Object.keys(buckets).length === 0) {
    throw new LimitFetchError("Claude returned no usable usage limits");
  }
  return capture("claude", "api", buckets, now);
}

/** cc-usage's `normalize_codex_limits`: the `account/rateLimits/read` result. */
export function normalizeCodexLimits(data: unknown, now: number = Date.now() / 1000): Capture {
  if (!isRecord(data)) throw new LimitFetchError("Codex returned an invalid rate-limit response");
  let byId = data.rateLimitsByLimitId;
  if (!isRecord(byId) || Object.keys(byId).length === 0) {
    const single = data.rateLimits;
    byId = isRecord(single) ? { codex: single } : {};
  }
  const buckets: Record<string, Bucket> = {};
  for (const [limitId, limit] of Object.entries(byId as Record<string, unknown>)) {
    if (!isRecord(limit)) continue;
    const limitName = limit.limitName;
    for (const slot of ["primary", "secondary", "individualLimit"]) {
      const window = limit[slot];
      if (!isRecord(window)) continue;
      const percent = window.usedPercent;
      const resetsAt = epochSeconds(window.resetsAt);
      const minutes = window.windowDurationMins;
      if (!isNumber(percent) || resetsAt === null) continue;
      const duration = labelForMinutes(minutes, slot);
      const label = limitName ? `${limitName} ${duration}` : duration;
      buckets[`${limitId}_${slot}`] = {
        label: label.toUpperCase(),
        used_percentage: percent,
        resets_at: resetsAt,
        window_minutes: isNumber(minutes) ? minutes : null,
      };
    }
  }
  if (Object.keys(buckets).length === 0) {
    throw new LimitFetchError("Codex returned no usable rate limits");
  }
  return capture("codex", "rpc", buckets, now);
}

/** A capture read back from a file someone else wrote: only well-formed parts survive. */
export function parseCapture(value: unknown): Capture | null {
  if (!isRecord(value) || !isNumber(value.captured_at) || !isRecord(value.rate_limits)) return null;
  if (value.source !== "claude" && value.source !== "codex") return null;
  const buckets: Record<string, Bucket> = {};
  for (const [key, raw] of Object.entries(value.rate_limits)) {
    if (!isRecord(raw) || !isNumber(raw.used_percentage) || !isNumber(raw.resets_at)) continue;
    const bucket: Bucket = { used_percentage: raw.used_percentage, resets_at: raw.resets_at };
    if (typeof raw.label === "string" && raw.label !== "") bucket.label = raw.label;
    if (isNumber(raw.window_minutes)) bucket.window_minutes = raw.window_minutes;
    buckets[key] = bucket;
  }
  const out: Capture = {
    captured_at: value.captured_at,
    source: value.source,
    rate_limits: buckets,
  };
  const via = value.via;
  if (via === "api" || via === "rpc" || via === "rollout" || via === "cc-usage") out.via = via;
  return out;
}
