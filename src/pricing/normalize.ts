// Port of cc-usage's `normalize_model` (cc_usage/cost.py): transcript and rollout model ids
// are matched tolerantly against the price table's keys.

const DATE_SUFFIX = /-\d{6,8}$/; // e.g. -20251001
const HYPHENATED_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/; // e.g. -2026-03-05
const ONE_M_SUFFIX = /\[\s*1m\s*\]/gi; // e.g. claude-opus-4-8[1m]

// Provider prefixes seen in routed ids. Applied in order and not exclusively, exactly as
// cc-usage does, so a doubled prefix loses both parts.
const PROVIDER_PREFIXES = ["us.anthropic.", "eu.anthropic.", "anthropic.", "anthropic/"];

// Official aliases, consulted only when the normalised id itself has no table entry, so
// an explicit row for the alias still wins (cc-usage's `get_rates` order).
export const OFFICIAL_ALIASES: ReadonlyMap<string, string> = new Map([["gpt-5.6", "gpt-5.6-sol"]]);

/**
 * Lower-case, trim, and strip a `[1m]` context marker, a provider prefix and a trailing
 * `-YYYYMMDD` or `-YYYY-MM-DD` date stamp. Point releases such as `-5-1` survive, since
 * only 6 to 8 digit stamps count as dates. Empty or missing ids normalise to "".
 */
export function normalizeModel(model: string | null | undefined): string {
  if (!model) return "";
  let m = model.trim().toLowerCase();
  m = m.replace(ONE_M_SUFFIX, "").trim();
  for (const prefix of PROVIDER_PREFIXES) {
    if (m.startsWith(prefix)) m = m.slice(prefix.length);
  }
  m = m.replace(HYPHENATED_DATE_SUFFIX, "").replace(DATE_SUFFIX, "");
  return m.trim();
}
