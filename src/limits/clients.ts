import { appendFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * The executable `name` on PATH, or null. PATH is read from `process.env` at the call, not
 * the environment the process started with (Bun.which's default): the same in use, and
 * under `bun test` it finds the preload's stub clients. Unset, Bun's default applies.
 */
export function findOnPath(name: string): string | null {
  const path = process.env.PATH;
  return Bun.which(name, path === undefined ? {} : { PATH: path });
}

/** Where refusals are recorded, beside the stubs; the test preload reads it after each test. */
export const TEST_SPAWN_LOG = "spawned.log";

/**
 * Under `bun test`, refuses to run a provider client that is not a test stub. A no-op
 * otherwise.
 *
 * tokenhud runs the real `claude` (to refresh a token) and `codex` (its app-server). A
 * test must never reach either: one did (T15), and ran the real claude against the real
 * home. The test preload sets `TOKENHUD_TEST=1` and `TOKENHUD_TEST_STUBS`, its dir of stub
 * `claude` and `codex` executables, which it puts first on PATH. Then only an executable
 * under the dir that holds the stubs (the test temp root, where every test makes its own
 * stubs too) may run. Anything else, a real client found on PATH or named by an absolute
 * path, is refused before it is spawned. The refusal is also recorded beside the stubs, so
 * the test fails even when the caller swallows the error.
 */
export function refuseRealClient(executable: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.TOKENHUD_TEST !== "1") return;
  const stubs = env.TOKENHUD_TEST_STUBS;
  if (stubs && within(executable, dirname(stubs))) return;
  const name = basename(executable);
  if (stubs) appendFileSync(join(stubs, TEST_SPAWN_LOG), `${name} (refused)\n`);
  throw new Error(`refused to run ${name} from a test: ${executable} is not a test stub`);
}

/** Whether `path` is inside `root`, as given or with symlinks (macOS's /var) resolved. */
function within(path: string, root: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  for (const r of [resolve(root), real(root)]) {
    for (const p of [resolve(path), real(path)]) {
      const rel = relative(fold(r), fold(p));
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return true;
    }
  }
  return false;
}
