import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The one setting tokenhud reads from a Codex home's `config.toml`: the top-level
 * `service_tier`, the tier a rollout without any `thread_settings_applied` event is priced
 * at. The file is opened read-only and nothing else in it is kept. Only keys before the
 * first `[table]` header are top-level in TOML, so a `service_tier` inside a profile table
 * is ignored (which profile was active is not knowable after the fact).
 */

/** Tier 1: priority/fast; tier 0: standard. */
export type SpeedTier = 0 | 1;

/** `thread_settings_applied` and `config.toml` spellings (ccusage's `codex_service_tier`). */
const TIERS: ReadonlyMap<string, SpeedTier> = new Map([
  ["priority", 1],
  ["fast", 1],
  ["default", 0],
  ["standard", 0],
]);

/** The tier a recorded `service_tier` names, or undefined for a value tokenhud does not know. */
export function serviceTier(value: string): SpeedTier | undefined {
  return TIERS.get(value);
}

const KEY = /^(?:service_tier|"service_tier"|'service_tier')\s*=\s*(.*)$/;

/** The value of a TOML basic or literal string at the start of `text`, else undefined. */
function stringValue(text: string): string | undefined {
  const quote = text[0];
  if (quote === "'") {
    const end = text.indexOf("'", 1);
    return end < 0 ? undefined : text.slice(1, end);
  }
  if (quote !== '"') return undefined;
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') return out;
    if (ch === "\\") {
      // Escapes cannot spell a known tier name; keep the escaped character so an odd
      // value stays an unknown one rather than a known one.
      out += text[i + 1] ?? "";
      i++;
      continue;
    }
    out += ch;
  }
  return undefined;
}

/**
 * The top-level `service_tier` string of a `config.toml` text, or undefined when there is
 * none. Multi-line strings are skipped so a `[` or a `service_tier =` inside one is not
 * mistaken for structure.
 */
export function topLevelServiceTier(text: string): string | undefined {
  let inMultiline: string | null = null;
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inMultiline !== null) {
      if (line.includes(inMultiline)) inMultiline = null;
      continue;
    }
    if (line.startsWith("[")) return found;
    const match = KEY.exec(line);
    if (match !== null) {
      found = stringValue((match[1] as string).trim());
      continue;
    }
    for (const delimiter of ['"""', "'''"]) {
      const at = line.indexOf(delimiter);
      if (at >= 0 && !line.includes(delimiter, at + 3)) inMultiline = delimiter;
    }
  }
  return found;
}

/**
 * The fallback tier of the Codex home at `home`: its `config.toml`'s top-level
 * `service_tier`, or 0 when the file, the key or a known value is missing. Never throws.
 */
export function configFallbackTier(home: string): SpeedTier {
  let text: string;
  try {
    text = readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return 0;
  }
  const value = topLevelServiceTier(text);
  return value === undefined ? 0 : (serviceTier(value) ?? 0);
}
