import { lstatSync, readlinkSync } from "node:fs";
import { byCodePoint } from "../store/store.ts";

/**
 * The parts of Python's POSIX path handling that decide cc-usage's account identities
 * and file order, ported from CPython 3.14 (`pathlib.PurePosixPath`, `posixpath.realpath`),
 * the interpreter cc-usage runs on. Identities hash the resolved path string, so every
 * normalisation step must match character for character.
 */

/** `str(PurePosixPath(p))`: no empty or "." parts, no trailing slash; exactly "//" survives as a root. */
export function pyNormPath(p: string): string {
  let root = "";
  if (p.startsWith("/")) root = p.startsWith("//") && !p.startsWith("///") ? "//" : "/";
  const parts = p.split("/").filter((part) => part !== "" && part !== ".");
  const out = root + parts.join("/");
  return out === "" ? "." : out;
}

/**
 * `PurePosixPath(p).expanduser()` for "~" and "~/...": the home directory's trailing
 * slashes are dropped, as `posixpath.expanduser` does. Python also expands "~user" through
 * the password database; that is not ported, so such a path is returned unexpanded (cc-usage
 * would raise on a user it cannot find, and no tokenhud input has a reason to name one).
 */
export function pyExpandUser(p: string, home: string): string {
  const norm = pyNormPath(p);
  if (norm !== "~" && !norm.startsWith("~/")) return norm;
  const userHome = home.replace(/\/+$/, "") || "/";
  return pyNormPath(userHome + norm.slice(1));
}

/** What `realpath` needs from the file system; tests replace it. */
export interface RealpathFs {
  /** Whether `p` is a symlink; throws when it cannot be lstat'ed. */
  isSymlink(p: string): boolean;
  readlink(p: string): string;
  cwd(): string;
}

export const nodeRealpathFs: RealpathFs = {
  isSymlink: (p) => lstatSync(p).isSymbolicLink(),
  readlink: (p) => readlinkSync(p, "utf8"),
  cwd: () => process.cwd(),
};

/**
 * `posixpath.realpath(p, strict=False)` from CPython 3.14: resolves symlinks component by
 * component; a component that cannot be lstat'ed or read is kept as it is, and ".." pops
 * the path resolved so far. A symlink loop leaves the looping link unresolved.
 */
export function pyRealpath(filename: string, fs: RealpathFs = nodeRealpathFs): string {
  const sep = "/";
  // The stack of unresolved parts, reversed; `null` marks a symlink whose target has just
  // been pushed, so its resolution can be recorded in `seen` once the target is walked.
  const rest: (string | null)[] = filename.split(sep).reverse();
  let partCount = rest.length;
  let path = filename.startsWith(sep) ? sep : fs.cwd();
  const seen = new Map<string, string | null>();
  while (partCount > 0) {
    const name = rest.pop();
    if (name === null) {
      seen.set(rest.pop() as string, path);
      continue;
    }
    if (name === undefined) break;
    partCount--;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      path = path.slice(0, path.lastIndexOf(sep)) || sep;
      continue;
    }
    const newpath = path === sep ? path + name : path + sep + name;
    let target: string;
    try {
      if (!fs.isSymlink(newpath)) {
        path = newpath;
        continue;
      }
      if (seen.has(newpath)) {
        const known = seen.get(newpath);
        // A link still being resolved is a loop; it stays as the unresolved link.
        path = known ?? newpath;
        continue;
      }
      target = fs.readlink(newpath);
    } catch {
      path = newpath;
      continue;
    }
    if (target.startsWith(sep)) path = sep;
    seen.set(newpath, null);
    rest.push(newpath, null);
    const targetParts = target.split(sep).reverse();
    rest.push(...targetParts);
    partCount += targetParts.length;
  }
  return path;
}

/**
 * Python's ordering of `Path` objects: by the list of `/`-separated parts, each compared by
 * code point, so `abc/subagents/x.jsonl` sorts before `abc.jsonl` (`"abc" < "abc.jsonl"`),
 * unlike a plain string sort. cc-usage reads files in this order, and the first line seen
 * decides a record's timestamp. On Windows parts are compared case-insensitively and
 * split on `\`, as `PureWindowsPath` does.
 */
export function comparePyPaths(a: string, b: string, platform = process.platform): number {
  const windows = platform === "win32";
  const pa = windows ? a.toLowerCase().split("\\") : a.split("/");
  const pb = windows ? b.toLowerCase().split("\\") : b.split("/");
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x !== y) return byCodePoint(x, y);
  }
  return pa.length - pb.length;
}
