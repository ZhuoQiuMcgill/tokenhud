import { type Dirent, readdirSync, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Finding and stat-ing transcripts. `walk` matches cc-usage's `projects.rglob("*.jsonl")`
 * under CPython 3.14: hidden files and directories included, symlinked directories not
 * descended into, names matched case-sensitively, and every entry named `*.jsonl` listed
 * whatever its type (a directory or broken symlink so named is dropped later, when it
 * does not stat as a file).
 */

export interface Walk {
  files: string[];
  /** Every directory walked, the root included: polled roots watch their mtimes. */
  dirs: string[];
}

const SUFFIX = ".jsonl";

function matches(name: string): boolean {
  return process.platform === "win32" ? name.toLowerCase().endsWith(SUFFIX) : name.endsWith(SUFFIX);
}

/** Lists `root` recursively; unreadable directories (and a missing root) are skipped. */
export function walk(root: string): Walk {
  const out: Walk = { files: [], dirs: [] };
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    out.dirs.push(dir);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (matches(entry.name)) out.files.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return out;
}

/** Lists one directory (not recursively): its `*.jsonl` entries and subdirectories. */
export function listDir(dir: string): { files: string[]; dirs: string[] } {
  const out = { files: [] as string[], dirs: [] as string[] };
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (matches(entry.name)) out.files.push(path);
    if (entry.isDirectory()) out.dirs.push(path);
  }
  return out;
}

export interface FileStat {
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

function toFileStat(st: Stats): FileStat {
  return {
    dev: String(st.dev),
    ino: String(st.ino),
    size: st.size,
    mtimeMs: st.mtimeMs,
    isFile: st.isFile(),
  };
}

/**
 * Stats many paths, `concurrency` at a time. Over WSL's 9P mount, overlapping the round
 * trips cuts a poll's wall time several-fold at the same CPU cost.
 */
export async function statFiles(
  paths: readonly string[],
  concurrency = 16,
): Promise<(FileStat | null)[]> {
  const out: (FileStat | null)[] = new Array(paths.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const i = next++;
      try {
        out[i] = toFileStat(await stat(paths[i] as string));
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
}
