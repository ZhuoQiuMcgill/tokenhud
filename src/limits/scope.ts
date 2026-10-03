import type { LimitWindow } from "./index.ts";

/**
 * Which model a limit window is limited to. Kept apart from the MCP's verdicts
 * (src/mcp/decide.ts) so that `tokenhud hook`, which must start fast, loads only this.
 */

const CODEX_SLOT = /^(.+)_(primary|secondary|individualLimit)$/;
const DURATION_SUFFIX = /\s+(WEEKLY|\d+-(MIN|HOUR|DAY|WEEK))$/i;

/**
 * The model a window is limited to, as the provider names it ("FABLE"), or null for an
 * account-wide window (5-hour, weekly), which limits every model.
 * - Claude: `weekly_scoped` windows, labelled "<model> WEEKLY" by T8, and the older
 *   response's `seven_day_<model>` keys.
 * - Codex: every limit but the account's own `codex` one. T8 keys them
 *   `<limit id>_<slot>` and labels them "<limit name> <duration>".
 * A window scoped to something other than a model (a surface) reads as scoped too, so it
 * binds only when named; T8's captures don't keep the scope's type.
 */
export function windowScope(
  provider: string,
  w: Pick<LimitWindow, "kind" | "label">,
): string | null {
  if (provider === "codex") {
    const slot = CODEX_SLOT.exec(w.kind);
    if (slot === null || slot[1] === "codex") return null;
    const named = w.label.replace(DURATION_SUFFIX, "");
    return named !== w.label && named !== "" ? named : (slot[1] as string).replace(/^codex_/, "");
  }
  if (/^weekly_scoped(_\d+)?$/.test(w.kind)) return w.label.replace(/\s+WEEKLY$/i, "") || "scoped";
  const old = /^seven_day_(.+)$/.exec(w.kind);
  return old === null ? null : (old[1] as string).replaceAll("_", " ");
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether a model id (or name) is the one a scope names: every word of the scope is a word
 * of the model. "FABLE" matches "claude-fable-5"; "Opus 4.8" matches "claude-opus-4-8".
 */
export function scopeMatches(scope: string, model: string): boolean {
  const have = new Set(words(model));
  const need = words(scope);
  return need.length > 0 && need.every((w) => have.has(w));
}
