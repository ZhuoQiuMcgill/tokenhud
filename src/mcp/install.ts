import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Root } from "../sources/roots.ts";

/**
 * Whether tokenhud is set up in a Claude config dir, for `tokenhud doctor`. Plugins and
 * user-scope MCP servers belong to one config dir, so each account needs its own install.
 * Everything here only reads, and keeps nothing from those files but the answer:
 * - the plugin: `<dir>/settings.json` `enabledPlugins["tokenhud@<marketplace>"]`, and
 *   `<dir>/plugins/installed_plugins.json` for one installed but switched off;
 * - an MCP server added with `claude mcp add -s user`: the `mcpServers` of Claude Code's
 *   global config, `~/.claude.json` for the default `~/.claude` and `<dir>/.claude.json`
 *   for a dir used through CLAUDE_CONFIG_DIR.
 */

export interface ClaudeInstall {
  /** "enabled", "installed" (but switched off), or null when the plugin is not there. */
  plugin: "enabled" | "installed" | null;
  /** A user-scope MCP server that runs `tokenhud mcp`. */
  mcp: boolean;
}

const PLUGIN = /^tokenhud@/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A server entry named tokenhud, or one whose command line runs `tokenhud ... mcp`. */
function runsTokenhud(name: string, server: unknown): boolean {
  if (name === "tokenhud") return true;
  if (!isRecord(server)) return false;
  const args = Array.isArray(server.args) ? server.args : [];
  const words = [server.command, ...args].filter((w): w is string => typeof w === "string");
  const line = words.join(" ");
  return /tokenhud/.test(line) && /(^|\s)mcp(\s|$)/.test(line);
}

/** Claude Code's global config files for a config dir, most likely first. */
function globalConfigs(dir: string): string[] {
  const own = join(dir, ".claude.json");
  return basename(dir) === ".claude" ? [join(dirname(dir), ".claude.json"), own] : [own];
}

export function detectInstall(root: Pick<Root, "path">): ClaudeInstall {
  const enabled = readJson(join(root.path, "settings.json"))?.enabledPlugins;
  const installed = readJson(join(root.path, "plugins", "installed_plugins.json"))?.plugins;
  let plugin: ClaudeInstall["plugin"] = null;
  if (isRecord(enabled) && Object.entries(enabled).some(([k, v]) => PLUGIN.test(k) && v === true)) {
    plugin = "enabled";
  } else if (
    (isRecord(enabled) && Object.keys(enabled).some((k) => PLUGIN.test(k))) ||
    (isRecord(installed) && Object.keys(installed).some((k) => PLUGIN.test(k)))
  ) {
    plugin = "installed";
  }
  const mcp = globalConfigs(root.path).some((path) => {
    const servers = readJson(path)?.mcpServers;
    return isRecord(servers) && Object.entries(servers).some(([k, v]) => runsTokenhud(k, v));
  });
  return { plugin, mcp };
}
