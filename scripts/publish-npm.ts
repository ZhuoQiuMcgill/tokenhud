// Publishes the npm packages scripts/stage-npm.ts staged, in an order that never leaves a
// `tokenhud` on npm whose binary can't be downloaded:
//
//   1. the platform packages, @tokenhud/<platform>;
//   2. then it waits until every platform package's tarball (the `dist.tarball` of its version
//      document) downloads and matches the document's `dist.integrity`, checking every 20 s
//      for up to 30 min;
//   3. only then tokenhud. If the wait runs out, tokenhud is not published and this fails;
//   4. a release (not a prerelease) moves tokenhud's `next` tag up to it, when it is newer.
//      The release is out by then, so a refusal is a warning with the command to run by hand.
//
// A release goes under `latest`, a prerelease under `next`; but a prerelease older than
// tokenhud's `next` (a backport's candidate, 0.1.2-rc.1 while next is 0.2.0-rc.1) goes under
// `next-<major>.<minor>` (`next-0.1`), so it never moves `next` backwards.
//
// For v0.1.0, npm's CDN served @tokenhud/linux-x64's tarball as a 404 for about 10 minutes
// after it was published. `bun add -g tokenhud` installed tokenhud anyway, without the
// optional dependency it couldn't download, which left a command that only said its binary
// was missing.
//
// A version already on the registry is skipped, so a re-run carries on where a failed run
// stopped. The release workflow runs it after stage-npm.ts, on a tag:
//
//   bun scripts/publish-npm.ts --provenance
//
// Options: --dir (dist/npm), --registry (npm's), --provenance, and --interval and --timeout,
// in seconds (20 and 1800). On npm's registry, npm authenticates as the release workflow's
// trusted publisher (OIDC): before anything is published, this checks that npm is one that
// can, and a refused publish names the npmjs.com settings to check. Another registry (a
// test's) takes a token, from any npm.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO } from "../src/release.ts";

export const NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * The npm versions that can both publish and set dist-tags as a trusted publisher: `npm
 * publish` learned OIDC in 11.5.1, `npm dist-tag` only in 11.21.0 and 12.2.0.
 */
export const TRUSTED_NPM = ">=11.21.0 <12.0.0 || >=12.2.0";

/** A staged package: its directory, name and version. */
export interface Staged {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
}

/** The packages staged in `dir`: the platform packages, and tokenhud, which goes last. */
export function stagedPackages(dir: string): { platforms: Staged[]; launcher: Staged } {
  const all = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const pkg = JSON.parse(readFileSync(join(dir, name, "package.json"), "utf8"));
      return { dir: join(dir, name), name: pkg.name as string, version: pkg.version as string };
    });
  const launcher = all.find((p) => p.name === "tokenhud");
  if (launcher === undefined) throw new Error(`${dir} has no tokenhud package`);
  const other = all.find((p) => p.version !== launcher.version);
  if (other !== undefined) {
    throw new Error(`${other.name} is ${other.version}, but tokenhud is ${launcher.version}`);
  }
  return { platforms: all.filter((p) => p !== launcher), launcher };
}

/** What installers ask the registry for: its abbreviated document, else the full one. */
const ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

interface Document {
  readonly "dist-tags"?: Record<string, string>;
  readonly versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
}

export interface Registry {
  /** Ends in `/`. */
  readonly url: string;
  readonly fetch: typeof fetch;
  /** How long one request may take. */
  readonly requestTimeoutMs: number;
}

/** A package's document, or null when the registry has no such package (a 404). */
async function document(registry: Registry, name: string): Promise<Document | null> {
  const res = await registry.fetch(`${registry.url}${name.replace("/", "%2f")}`, {
    headers: { accept: ACCEPT },
    signal: AbortSignal.timeout(registry.requestTimeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the registry answered ${res.status} for ${name}`);
  return (await res.json()) as Document;
}

/** Whether `bytes` match an SRI string's sha512 (`sha512-<base64>`, maybe among others). */
function matchesIntegrity(integrity: string | undefined, bytes: Uint8Array): boolean {
  const mine = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
  return (integrity ?? "")
    .split(/\s+/)
    .some((entry) => /^sha512-/.test(entry) && entry.slice(7).split("?")[0] === mine);
}

/** Why `pkg`'s tarball can't be installed yet, or null when it can. */
async function notDownloadable(registry: Registry, pkg: Staged): Promise<string | null> {
  try {
    const dist = (await document(registry, pkg.name))?.versions?.[pkg.version]?.dist;
    if (dist?.tarball === undefined) return `${pkg.version} is not in its document yet`;
    const res = await registry.fetch(dist.tarball, {
      signal: AbortSignal.timeout(registry.requestTimeoutMs),
    });
    if (!res.ok) return `its tarball answers ${res.status}`;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return matchesIntegrity(dist.integrity, bytes)
      ? null
      : "its tarball doesn't match the document's integrity";
  } catch (error) {
    return (error as Error).message;
  }
}

/** "30 min", or "5 s" under a minute. */
const duration = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface WaitOptions {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly clock: Clock;
  readonly log: (line: string) => void;
}

/**
 * Checks every `intervalMs` until each package's tarball downloads and matches its integrity,
 * for up to `timeoutMs`. Returns those that never did, each with why; none when all did. A
 * package that passed once is not asked for again.
 */
export async function waitForTarballs(
  registry: Registry,
  packages: readonly Staged[],
  { intervalMs, timeoutMs, clock, log }: WaitOptions,
): Promise<Array<{ name: string; why: string }>> {
  const start = clock.now();
  let waiting = [...packages];
  for (;;) {
    const why = await Promise.all(waiting.map((p) => notDownloadable(registry, p)));
    const left = waiting.flatMap((p, i) => (why[i] === null ? [] : [{ pkg: p, why: why[i] }]));
    waiting = left.map((l) => l.pkg);
    const elapsed = clock.now() - start;
    if (left.length === 0) {
      log(`every platform tarball downloads (after ${duration(elapsed)})`);
      return [];
    }
    log(
      `waiting for ${left.length} of ${packages.length} platform tarballs ` +
        `(${duration(elapsed)}): ${left.map((l) => `${l.pkg.name}: ${l.why}`).join("; ")}`,
    );
    if (elapsed >= timeoutMs) {
      return left.map((l) => ({ name: l.pkg.name, why: l.why as string }));
    }
    await clock.sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

export interface PublishOptions extends WaitOptions {
  readonly dir: string;
  readonly registry: Registry;
  readonly provenance: boolean;
  /** Whether npm must be one that can publish and set dist-tags as a trusted publisher. */
  readonly trusted: boolean;
  /** Runs npm with these arguments: its exit code, and what it printed. */
  readonly npm: (args: string[]) => Promise<{ code: number; output: string }>;
  /** Errors and warnings, as GitHub annotations. */
  readonly error: (line: string) => void;
  readonly warn: (line: string) => void;
  /** A paragraph of Markdown for the job's summary. */
  readonly summary: (markdown: string) => void;
}

// npm answers a publish it may not make with a 404 as often as with a 401 or 403.
const AUTH_FAILURE = /\b(E401|E403|E404|ENEEDAUTH)\b|\b40[134]\b|oidc|trusted publish/i;

/** What to say when publishing `name` fails, from npm's output. */
function failure(name: string, output: string): string {
  if (AUTH_FAILURE.test(output)) {
    return (
      `npm publish ${name} was refused: check the trusted publisher settings for ${name} on ` +
      `npmjs.com (repository ${REPO}, workflow release.yml, no environment), ` +
      "and that this job has `id-token: write`."
    );
  }
  return `npm publish ${name} failed; npm's output is above.`;
}

/** The npm version npm printed (`11.21.0`), or null. */
function npmVersion(output: string): string | null {
  return /^\d+\.\d+\.\d+\S*$/m.exec(output)?.[0] ?? null;
}

/**
 * The dist-tag `version` goes under: `latest` for a release; for a prerelease `next`, unless
 * tokenhud's `next` is newer, which it would move backwards: then `next-<major>.<minor>`.
 */
async function publishTag(registry: Registry, version: string): Promise<string> {
  if (!version.includes("-")) return "latest";
  const next = (await document(registry, "tokenhud"))?.["dist-tags"]?.next;
  // Equal on a re-run that already published tokenhud.
  if (next === undefined || Bun.semver.order(version, next) >= 0) return "next";
  const [major, minor] = version.split(".");
  return `next-${major}.${minor}`;
}

/** Publishes the staged packages in order; returns whether everything went through. */
export async function publishNpm(o: PublishOptions): Promise<boolean> {
  const staged = stagedPackages(o.dir);
  try {
    return await publishInOrder(o, staged);
  } catch (error) {
    // The registry couldn't say what is published (a 5xx, the network): nothing more is sent.
    o.error(
      `${(error as Error).message}. The run stopped there. Re-run this job: it skips what is ` +
        "already published.",
    );
    return false;
  }
}

async function publishInOrder(
  o: PublishOptions,
  { platforms, launcher }: ReturnType<typeof stagedPackages>,
): Promise<boolean> {
  const { version } = launcher;
  if (o.trusted) {
    const run = await o.npm(["--version"]);
    const found = run.code === 0 ? npmVersion(run.output) : null;
    if (found === null || !Bun.semver.satisfies(found, TRUSTED_NPM)) {
      o.error(
        `npm ${found ?? "(its version unknown)"} can't publish and set dist-tags as a trusted ` +
          "publisher: that takes npm 11.21.0 or later (12.2.0 or later on npm 12). Nothing was " +
          "published. Pin NPM_VERSION in release.yml to such a version.",
      );
      return false;
    }
  }
  const tag = await publishTag(o.registry, version);
  if (tag !== "latest" && tag !== "next") {
    o.log(`tokenhud@${version} is older than next: it goes under ${tag}, and next stays`);
    o.summary(
      `**tokenhud ${version} is published under \`${tag}\`**, not \`next\`, which holds a newer ` +
        `prerelease. Install it with \`bun add -g tokenhud@${tag}\` or ` +
        `\`npm install -g tokenhud@${tag}\`.`,
    );
  }
  const registry = o.registry.url;
  const onNpm = async (p: Staged) =>
    (await document(o.registry, p.name))?.versions?.[version] !== undefined;
  const publish = async (p: Staged): Promise<boolean> => {
    if (await onNpm(p)) {
      o.log(`${p.name}@${version} is already on npm`);
      return true;
    }
    const args = ["publish", p.dir, "--access", "public", "--tag", tag, "--registry", registry];
    const run = await o.npm(o.provenance ? [...args, "--provenance"] : args);
    if (run.code === 0) return true;
    // Published after all, though the registry's document didn't show it a moment ago.
    if (/previously published/i.test(run.output)) {
      o.log(`${p.name}@${version} is already on npm`);
      return true;
    }
    o.error(failure(p.name, run.output));
    return false;
  };

  for (const p of platforms) if (!(await publish(p))) return false;
  if (await onNpm(launcher)) {
    o.log(`tokenhud@${version} is already on npm`);
  } else {
    const missing = await waitForTarballs(o.registry, platforms, o);
    if (missing.length > 0) {
      o.error(
        `tokenhud@${version} was not published: after ${duration(o.timeoutMs)}, ` +
          `these platform packages still couldn't be downloaded: ${missing.map((m) => `${m.name} (${m.why})`).join(", ")}. ` +
          "Re-run this job: it skips what is published, and waits again.",
      );
      return false;
    }
    if (!(await publish(launcher))) return false;
  }

  // A release moves `next` up to it too, so next is never older than latest; but only when
  // it is newer than next, which may already hold the next release's candidates (0.3.0-rc.1
  // while 0.2.1 ships). Only tokenhud's: the platform packages are installed at the exact
  // version tokenhud names, so their tags don't matter.
  if (tag === "latest") {
    const next = (await document(o.registry, "tokenhud"))?.["dist-tags"]?.next;
    if (next !== undefined && Bun.semver.order(version, next) !== 1) {
      o.log(`tokenhud: next stays at ${next}, not older than ${version}`);
    } else {
      const manual = `npm dist-tag add tokenhud@${version} next`;
      const run = await o.npm([
        "dist-tag",
        "add",
        `tokenhud@${version}`,
        "next",
        "--registry",
        registry,
      ]);
      if (run.code !== 0) {
        // The release is out: a stale `next` is worth a warning, not a failed job.
        const refused = AUTH_FAILURE.test(run.output)
          ? " Check that tokenhud's trusted publisher on npmjs.com allows npm dist-tag."
          : "";
        o.warn(
          `tokenhud@${version} is published, but npm didn't move its next tag (still ${next ?? "unset"}).` +
            `${refused} Move it by hand: ${manual}`,
        );
        o.summary(
          `**tokenhud's \`next\` tag was not moved to ${version}.** The release is published; ` +
            `move the tag by hand:\n\n\`\`\`sh\n${manual}\n\`\`\``,
        );
      }
    }
  }
  return true;
}

/** Runs npm, its output passed through as it comes, and kept. */
async function runNpm(args: string[]): Promise<{ code: number; output: string }> {
  console.log(`$ npm ${args.join(" ")}`);
  const proc = Bun.spawn(["npm", ...args], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pass = async (stream: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      to.write(chunk);
      text += decoder.decode(chunk, { stream: true });
    }
    return text;
  };
  const [out, err] = await Promise.all([
    pass(proc.stdout, process.stdout),
    pass(proc.stderr, process.stderr),
  ]);
  return { code: await proc.exited, output: out + err };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", default: join(import.meta.dir, "..", "dist", "npm") },
      registry: { type: "string", default: NPM_REGISTRY },
      provenance: { type: "boolean", default: false },
      interval: { type: "string", default: "20" },
      timeout: { type: "string", default: "1800" },
    },
    strict: true,
  });
  const seconds = (s: string) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new Error(`not a number of seconds: ${s}`);
    return n * 1000;
  };
  const registry = values.registry.replace(/\/*$/, "/");
  const ok = await publishNpm({
    dir: values.dir,
    registry: { url: registry, fetch, requestTimeoutMs: 60_000 },
    provenance: values.provenance,
    trusted: registry === NPM_REGISTRY,
    intervalMs: seconds(values.interval),
    timeoutMs: seconds(values.timeout),
    clock: { now: Date.now, sleep: Bun.sleep },
    log: (line) => console.log(line),
    error: (line) => console.log(`::error::${line}`),
    warn: (line) => console.log(`::warning::${line}`),
    summary: (markdown) => {
      const file = process.env.GITHUB_STEP_SUMMARY;
      if (file) appendFileSync(file, `${markdown}\n\n`);
    },
    npm: runNpm,
  });
  process.exit(ok ? 0 : 1);
}
