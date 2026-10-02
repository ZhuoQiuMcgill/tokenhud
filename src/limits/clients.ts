import { appendFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LimitFetchError } from "./capture.ts";

/**
 * The executable `name` on PATH, or null. PATH is read from `process.env` at the call, not
 * the environment the process started with (Bun.which's default): the same in use, and
 * under `bun test` it finds the test guard's stub clients. Unset, Bun's default applies.
 */
export function findOnPath(name: string): string | null {
  const path = process.env.PATH;
  return Bun.which(name, path === undefined ? {} : { PATH: path });
}

/** Where refusals are recorded, beside the stubs; the test guard reads it after each test. */
export const TEST_SPAWN_LOG = "spawned.log";

/** A provider client that a test tried to run, refused before it was spawned. */
export class RefusedClient extends LimitFetchError {}

/** A test file's name, as `bun test` finds them: `x.test.ts`, `x_spec.tsx`, … */
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;

/**
 * Whether this is `bun test`'s own thread. Checked under Bun 1.4.2 (T15): `bun test` sets
 * NODE_ENV=test, and Bun.main is the test file being run. Nothing else marks it: argv,
 * process.title and the rest of the environment are as under `bun run`. Either sign alone
 * could be a user's (an exported NODE_ENV=test); both together mean tokenhud's code is
 * running inside a test file, which no user does. Workers and children of a test are not
 * covered here: the test guard gives them TOKENHUD_TEST.
 */
function inBunTest(env: NodeJS.ProcessEnv, main: string): boolean {
  return env.NODE_ENV === "test" && TEST_FILE.test(main);
}

/**
 * In tests, refuses to run a provider client that is not a test stub. A no-op otherwise.
 *
 * tokenhud runs the real `claude` (to refresh a token) and `codex` (its app-server). A
 * test must never reach either: one did (T15), and ran the real claude against the real
 * home. The test guard (test/guard.ts) sets `TOKENHUD_TEST=1` and `TOKENHUD_TEST_STUBS`,
 * its dir of stub `claude` and `codex`, which it puts first on PATH; then only an
 * executable under the dir that holds the stubs (the test temp root, where every test
 * makes its own stubs too) may run. Without the guard, in `bun test`'s thread, nothing
 * may: that is the fallback for a test file run without it.
 *
 * Anything else, a real client found on PATH or named by an absolute path, is refused
 * before it is spawned. The refusal is recorded beside the stubs, so the test fails even
 * when the caller swallows the error.
 */
export function refuseRealClient(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  main: string = Bun.main,
): void {
  if (env.TOKENHUD_TEST !== "1" && !inBunTest(env, main)) return;
  const stubs = env.TOKENHUD_TEST_STUBS;
  if (stubs && within(executable, dirname(stubs))) return;
  const name = basename(executable);
  if (stubs) {
    appendFileSync(join(stubs, TEST_SPAWN_LOG), `${name} (refused)\n`);
    throw new RefusedClient(`refused to run ${name} from a test: it is not a test stub`);
  }
  throw new RefusedClient(`refused to run ${name} from a test: the test guard is not installed`);
}

/**
 * Whether `path` is inside `root`, both with symlinks resolved (macOS's /var is
 * /private/var), so a link under the root to a binary outside it does not count. A path
 * that doesn't exist yet is resolved through its parent.
 */
function within(path: string, root: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      const parent = dirname(p);
      return parent === p ? resolve(p) : join(real(parent), basename(p));
    }
  };
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(fold(real(root)), fold(real(path)));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
