import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SESSION_ID } from "../alerts/store.ts";
import { type Provider, type Root, rootIdentity } from "../sources/roots.ts";
import { ToolError } from "./errors.ts";

/**
 * Which account a tool call is about (ARCHITECTURE.md §8, T9 spec):
 * 1. an explicit `account` argument, a label or a root identity;
 * 2. Claude: `CLAUDE_CONFIG_DIR` from the server's env (Claude Code passes its env to stdio
 *    servers), else `~/.claude`;
 * 3. then a cross-check: Claude Code also passes `CLAUDE_CODE_SESSION_ID`, and that
 *    session's transcript `<root>/projects/<project>/<id>.jsonl` already exists while a
 *    tool call runs. If it is under another known root, that root wins. Only the file's
 *    existence is checked, never its content. The variable is undocumented, so this is
 *    best-effort: without it the env answer stands;
 * 4. Codex (`provider: "codex"`): the root `CODEX_HOME` names, else the Codex account with
 *    the most recent usage, else `~/.codex`.
 */

export type DetectedVia = "argument" | "env" | "default" | "transcript" | "recent";

export interface Resolved {
  root: Root;
  detectedVia: DetectedVia;
}

export interface ResolveRequest {
  account?: string | undefined;
  provider?: Provider | undefined;
}

export interface ResolveContext {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** Enabled roots of both providers, as discovery returns them. */
  roots: readonly Root[];
  /** Whether `<root>/projects/*\/<sessionId>.jsonl` exists. */
  hasTranscript: (root: Root, sessionId: string) => boolean;
  /** Epoch ms of the root's newest usage in the store, or null. */
  lastSeen: (root: Root) => number | null;
}

/** Whether `<root>/projects/<any project>/<sessionId>.jsonl` exists. Reads directory names only. */
export function transcriptExists(root: Root, sessionId: string): boolean {
  if (!SESSION_ID.test(sessionId)) return false;
  let projects: string[];
  try {
    projects = readdirSync(root.projects);
  } catch {
    return false;
  }
  const file = `${sessionId}.jsonl`;
  return projects.some((project) => existsSync(join(root.projects, project, file)));
}

function labelsOf(roots: readonly Root[]): string {
  return roots.map((r) => r.label).join(", ") || "none";
}

function quoted(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function resolveAccount(req: ResolveRequest, ctx: ResolveContext): Resolved {
  if (req.account !== undefined) {
    const wanted = req.account.trim();
    const lower = wanted.toLowerCase();
    const root =
      ctx.roots.find((r) => r.identity === wanted) ??
      ctx.roots.find((r) => r.label.toLowerCase() === lower);
    if (root === undefined) {
      throw new ToolError(
        "unknown_account",
        `unknown account '${quoted(wanted)}' (accounts: ${labelsOf(ctx.roots)})`,
      );
    }
    if (req.provider !== undefined && root.provider !== req.provider) {
      throw new ToolError(
        "bad_argument",
        `account '${root.label}' is a ${root.provider} account, not ${req.provider}`,
      );
    }
    return { root, detectedVia: "argument" };
  }
  return req.provider === "codex" ? resolveCodex(ctx) : resolveClaude(ctx);
}

/** The root at `dir` (a path as an env variable spells it), by identity. */
function rootAt(roots: readonly Root[], dir: string, home: string): Root | undefined {
  const identity = rootIdentity(dir, home);
  return roots.find((r) => r.identity === identity);
}

function resolveClaude(ctx: ResolveContext): Resolved {
  const claude = ctx.roots.filter((r) => r.provider === "claude");
  const envDir = ctx.env.CLAUDE_CONFIG_DIR;
  let candidate: Resolved | null = null;
  if (envDir) {
    const root = rootAt(claude, envDir, ctx.home);
    if (root !== undefined) candidate = { root, detectedVia: "env" };
  } else {
    const root = claude.find((r) => r.source === "auto");
    if (root !== undefined) candidate = { root, detectedVia: "default" };
  }

  const sessionId = ctx.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId && SESSION_ID.test(sessionId)) {
    if (candidate !== null && ctx.hasTranscript(candidate.root, sessionId)) return candidate;
    const other = claude.find((r) => r !== candidate?.root && ctx.hasTranscript(r, sessionId));
    if (other !== undefined) return { root: other, detectedVia: "transcript" };
  }
  if (candidate !== null) return candidate;
  throw new ToolError(
    "unknown_account",
    envDir
      ? "CLAUDE_CONFIG_DIR names a Claude config dir tokenhud does not track (missing, or disabled in tokenhud's config)"
      : "the default Claude account (~/.claude) is disabled in tokenhud's config",
  );
}

function resolveCodex(ctx: ResolveContext): Resolved {
  const codex = ctx.roots.filter((r) => r.provider === "codex");
  const envHome = ctx.env.CODEX_HOME;
  if (envHome) {
    const root = rootAt(codex, envHome, ctx.home);
    if (root !== undefined) return { root, detectedVia: "env" };
  }
  let recent: Root | undefined;
  let recentAt = Number.NEGATIVE_INFINITY;
  for (const root of codex) {
    const at = ctx.lastSeen(root);
    if (at !== null && at > recentAt) {
      recent = root;
      recentAt = at;
    }
  }
  if (recent !== undefined) return { root: recent, detectedVia: "recent" };
  const fallback = codex.find((r) => r.source === "auto");
  if (fallback !== undefined) return { root: fallback, detectedVia: "default" };
  throw new ToolError("unknown_account", "no Codex account is enabled on this machine");
}
