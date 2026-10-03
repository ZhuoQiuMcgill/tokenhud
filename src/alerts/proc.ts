import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Which Claude Code process a hook run and an MCP server belong to, for the MCP server's
 * session fallback (src/alerts/store.ts `currentSession`). A process is its pid and its
 * start time, which together are never reused.
 *
 * - **Linux:** `/proc/<pid>/stat` (its name, parent and start time in clock ticks).
 * - **macOS:** `ps -o ppid= -o lstart= -o comm= -p <pid>`.
 * - **Elsewhere (Windows):** unverified, so the fallback is off and the server keeps the
 *   session id Claude Code started it with.
 *
 * A hook command runs in a shell (`sh -c`), so the Claude Code process above a hook is its
 * parent's parent; the walk skips up to two shells.
 */

export interface ProcId {
  pid: number;
  /** When it started, as the OS says it: never the same for two processes with one pid. */
  start: string;
}

export interface ProcInfo {
  ppid: number;
  start: string;
  /** The executable's name. */
  name: string;
}

export type ReadProc = (pid: number) => ProcInfo | null;

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash", "ksh", "busybox"]);

function linuxProc(pid: number): ProcInfo | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The name is in parentheses and may hold spaces or parentheses itself.
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    const fields = text.slice(close + 2).split(" ");
    const ppid = Number(fields[1]);
    const start = fields[19];
    if (open < 0 || !Number.isInteger(ppid) || start === undefined || start === "") return null;
    return { ppid, start, name: text.slice(open + 1, close) };
  } catch {
    return null;
  }
}

const LSTART = /^\s*(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.+?)\s*$/;

function darwinProc(pid: number): ProcInfo | null {
  try {
    const run = Bun.spawnSync(
      ["/bin/ps", "-o", "ppid=", "-o", "lstart=", "-o", "comm=", "-p", String(pid)],
      {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (run.exitCode !== 0) return null;
    const m = LSTART.exec(run.stdout.toString());
    if (m === null) return null;
    return { ppid: Number(m[1]), start: m[2] as string, name: basename(m[3] as string) };
  } catch {
    return null;
  }
}

/** How this OS's processes are read, or null where they can't be verified. */
export function procReader(platform: NodeJS.Platform = process.platform): ReadProc | null {
  if (platform === "linux") return linuxProc;
  if (platform === "darwin") return darwinProc;
  return null;
}

/**
 * The Claude Code process above a process whose parent is `ppid`: the parent, or above
 * the shell (at most two) the parent is. Null when it can't be told.
 */
export function claudeProcess(ppid: number, read: ReadProc | null): ProcId | null {
  if (read === null || ppid <= 1) return null;
  let pid = ppid;
  let info = read(pid);
  for (let hops = 0; info !== null && SHELLS.has(info.name) && hops < 2; hops++) {
    if (info.ppid <= 1) return null;
    pid = info.ppid;
    info = read(pid);
  }
  return info === null ? null : { pid, start: info.start };
}
