// The TUI's log file: what went wrong, for `tokenhud doctor` and bug reports, while the
// screen shows one clean line. `<config dir>/logs/tokenhud.log`, rotated to `.1` past
// 256 KB, so it never holds more than about 512 KB. It never holds content: messages pass
// through `scrub`, which keeps account root dirs but cuts everything below them (project
// and session names), and shortens the home directory to `~`.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../paths.ts";

export const LOG_DIR_NAME = "logs";
export const LOG_FILE_NAME = "tokenhud.log";
export const MAX_LOG_BYTES = 256 * 1024;

export function logPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(configDir(env, home), LOG_DIR_NAME, LOG_FILE_NAME);
}

/**
 * `text` on one line with no path below an account root (a `projects/` or `sessions/`
 * subtree), the home directory written `~`, and stack frames reduced to file names.
 */
export function scrub(text: string, home: string = homedir()): string {
  let out = text;
  if (home.length > 1) out = out.split(home).join("~");
  out = out
    // Below a transcript dir is project and session naming: content.
    .replace(/([\\/](?:projects|sessions|archived_sessions))[\\/][^\s'"():,]*/g, "$1/…")
    // Stack frames: `at fn (/long/path/file.ts:12:3)` → `at fn (file.ts:12:3)`.
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"():]*[\\/]([^\s'"():\\/]+:\d+(?::\d+)?)/g, "$1");
  return out.replace(/\s*\n\s*/g, " | ").trim();
}

/**
 * The one line to show for an error: Bun's worker error events carry a source excerpt
 * ("12 |   code…") before the message, which is noise on screen.
 */
export function errorLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const message =
    lines.find((l) => /^(?:\w*Error|error)\b.*?:\s*\S/.test(l)) ??
    lines.find((l) => l !== "" && !/^\d+\s*\|/.test(l) && !/^at\s/.test(l) && !/^\^+$/.test(l)) ??
    "unexpected error";
  const cut = message.replace(/^(?:\w*Error|error)\b[^:]*:\s*/, "");
  return cut.length > 120 ? `${cut.slice(0, 119)}…` : cut;
}

export interface Log {
  write(level: "error" | "warn" | "info", message: string): void;
}

/** A size-capped file log; a log that can't be written is silently skipped. */
export function fileLog(path: string, home: string = homedir()): Log {
  return {
    write(level, message) {
      try {
        mkdirSync(join(path, ".."), { recursive: true });
        let size = 0;
        try {
          size = statSync(path).size;
        } catch {
          // no log yet
        }
        if (size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
        appendFileSync(path, `${new Date().toISOString()} ${level} ${scrub(message, home)}\n`);
      } catch {
        // an unwritable config dir: the screen still shows the one line
      }
    },
  };
}
