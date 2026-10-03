// scripts/publish-npm.ts: tokenhud goes to npm only once every platform package's tarball
// downloads and matches its integrity. Against the fake registry on localhost (fake-npm.ts),
// which can 404 a tarball, or serve a stale one, for its first requests: what npm's CDN did
// for about 10 minutes after v0.1.0 was published.
//
// The wait runs on an injected clock. The publishing runs the script as the release workflow
// does, with the real npm on stand-in packages, when npm is on PATH (CI's ci.yml installs the
// npm the release job uses and fails if these are skipped); npm's home, cache and config are
// temp files, and its only registry is the fake one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Clock,
  publishNpm,
  type Registry,
  type Staged,
  stagedPackages,
  TRUSTED_NPM,
  waitForTarballs,
} from "../../scripts/publish-npm.ts";
import { stageNpm } from "../../scripts/stage-npm.ts";
import { assetName, type ReleaseTarget, targetById } from "../../src/release.ts";
import { guard } from "../guard.ts";
import { type FakeNpm, type FakeNpmPackage, fakeNpm, type TarballFault } from "./fake-npm.ts";

guard();

const LINUX = "@tokenhud/linux-x64";
const MAC = "@tokenhud/darwin-arm64";
const TOKEN = "fake-token-0000";

let dir: string;
const registries: FakeNpm[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenhud-publish-npm-test-"));
});
afterEach(() => {
  for (const r of registries.splice(0)) r.stop();
  rmSync(dir, { recursive: true, force: true });
});

function serve(
  packages: FakeNpmPackage[],
  tags: Record<string, Record<string, string>> = {},
  fault?: (id: string, nth: number) => TarballFault | undefined,
): FakeNpm {
  const r = fakeNpm(packages, tags, { token: TOKEN, ...(fault === undefined ? {} : { fault }) });
  registries.push(r);
  return r;
}

/** A package on the registry, with a tarball of a few bytes. */
function listed(name: string, version: string): FakeNpmPackage {
  const tarball = join(dir, `${name.replace("/", "-")}-${version}.tgz`);
  writeFileSync(tarball, `tarball of ${name}@${version}`);
  return { manifest: { name, version }, tarball };
}

const registryAt = (r: FakeNpm): Registry => ({ url: r.url, fetch, requestTimeoutMs: 5_000 });

/** A clock that moves only when slept on. */
function fakeClock(): Clock {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

const staged = (name: string, version: string): Staged => ({ dir: "", name, version });
const count = (r: FakeNpm, event: string) => r.events.filter((e) => e === event).length;

/** Two platform packages and tokenhud, at `version`, staged with stand-in binaries. */
function stage(version: string): string {
  const dist = join(dir, `dist-${version}`);
  mkdirSync(dist);
  const targets = ["linux-x64", "darwin-arm64"].map((id) => targetById(id) as ReleaseTarget);
  for (const t of targets) writeFileSync(join(dist, assetName(t)), `binary ${assetName(t)}`);
  const out = join(dir, `npm-${version}`);
  stageNpm({ dist, out, version, targets });
  return out;
}

describe("the wait for the platform tarballs", () => {
  test("a tarball that 404s for its first 3 requests: ready at the 4th check, 60 s in", async () => {
    const r = serve([listed(LINUX, "0.2.0"), listed(MAC, "0.2.0")], {}, (id, nth) =>
      id === `${LINUX}@0.2.0` && nth <= 3 ? "missing" : undefined,
    );
    const clock = fakeClock();
    const log: string[] = [];
    const left = await waitForTarballs(
      registryAt(r),
      [staged(LINUX, "0.2.0"), staged(MAC, "0.2.0")],
      { intervalMs: 20_000, timeoutMs: 1_800_000, clock, log: (l) => log.push(l) },
    );
    expect(left).toEqual([]);
    expect(clock.now()).toBe(60_000);
    expect(log).toEqual([
      "waiting for 1 of 2 platform tarballs (0 s): @tokenhud/linux-x64: its tarball answers 404",
      "waiting for 1 of 2 platform tarballs (20 s): @tokenhud/linux-x64: its tarball answers 404",
      "waiting for 1 of 2 platform tarballs (40 s): @tokenhud/linux-x64: its tarball answers 404",
      "every platform tarball downloads (after 1 min)",
    ]);
    // The one that downloaded at once isn't asked for again.
    expect(r.tarballs.filter((t) => t === `${MAC}@0.2.0`)).toHaveLength(1);
    expect(count(r, `tarball ${LINUX}@0.2.0 404`)).toBe(3);
    expect(count(r, `tarball ${LINUX}@0.2.0 200`)).toBe(1);
  });

  test("a stale tarball, which doesn't match the document's integrity, is not ready", async () => {
    const r = serve([listed(LINUX, "0.2.0")], {}, (_, nth) => (nth <= 2 ? "corrupt" : undefined));
    const clock = fakeClock();
    const log: string[] = [];
    const left = await waitForTarballs(registryAt(r), [staged(LINUX, "0.2.0")], {
      intervalMs: 20_000,
      timeoutMs: 1_800_000,
      clock,
      log: (l) => log.push(l),
    });
    expect([left, clock.now()]).toEqual([[], 40_000]);
    expect(log[0]).toBe(
      "waiting for 1 of 1 platform tarballs (0 s): @tokenhud/linux-x64: its tarball doesn't match the document's integrity",
    );
  });

  test("a version not in its document yet: not ready, and no tarball asked for", async () => {
    const r = serve([listed(LINUX, "0.1.0")]);
    const left = await waitForTarballs(registryAt(r), [staged(LINUX, "0.2.0")], {
      intervalMs: 20_000,
      timeoutMs: 60_000,
      clock: fakeClock(),
      log: () => {},
    });
    expect(left).toEqual([{ name: LINUX, why: "0.2.0 is not in its document yet" }]);
    expect(r.tarballs).toEqual([]);
  });

  // Tarballs served somewhere other than npm's usual path: only a client that follows the
  // document's dist.tarball finds them.
  test("it downloads the tarball from where the document says, not the usual path", async () => {
    const r = fakeNpm(
      [listed(LINUX, "0.2.0")],
      {},
      {
        tarballPath: (name, version) => `/cdn/${version}/${name.replace("/", "-")}.tgz`,
      },
    );
    registries.push(r);
    const usual = await fetch(`${r.url}@tokenhud/linux-x64/-/linux-x64-0.2.0.tgz`);
    expect(usual.status).toBe(404);
    const left = await waitForTarballs(registryAt(r), [staged(LINUX, "0.2.0")], {
      intervalMs: 20_000,
      timeoutMs: 0,
      clock: fakeClock(),
      log: () => {},
    });
    expect(left).toEqual([]);
    expect(r.events).toEqual([`tarball ${LINUX}@0.2.0 200`]);
  });

  test("never downloadable: gives up after 30 min, at the 91st check, naming it and why", async () => {
    const r = serve([listed(LINUX, "0.2.0"), listed(MAC, "0.2.0")], {}, (id) =>
      id === `${LINUX}@0.2.0` ? "missing" : undefined,
    );
    const clock = fakeClock();
    const left = await waitForTarballs(
      registryAt(r),
      [staged(LINUX, "0.2.0"), staged(MAC, "0.2.0")],
      { intervalMs: 20_000, timeoutMs: 1_800_000, clock, log: () => {} },
    );
    expect(left).toEqual([{ name: LINUX, why: "its tarball answers 404" }]);
    expect(clock.now()).toBe(1_800_000);
    expect(count(r, `tarball ${LINUX}@0.2.0 404`)).toBe(91);
  });

  test("a registry in trouble: not ready, with what it answered", async () => {
    const broken = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("oops", { status: 503 }),
    });
    try {
      const left = await waitForTarballs(
        { url: `http://127.0.0.1:${broken.port}/`, fetch, requestTimeoutMs: 5_000 },
        [staged(LINUX, "0.2.0")],
        { intervalMs: 20_000, timeoutMs: 0, clock: fakeClock(), log: () => {} },
      );
      expect(left).toEqual([
        { name: LINUX, why: "the registry answered 503 for @tokenhud/linux-x64" },
      ]);
    } finally {
      broken.stop(true);
    }
  });
});

describe("the staged packages", () => {
  test("the platform packages, then tokenhud; all at one version", () => {
    const { platforms, launcher } = stagedPackages(stage("0.2.0"));
    expect(platforms.map((p) => `${p.name}@${p.version}`)).toEqual([
      `${MAC}@0.2.0`,
      `${LINUX}@0.2.0`,
    ]);
    expect(`${launcher.name}@${launcher.version}`).toBe("tokenhud@0.2.0");
  });

  test("a package at another version stops it", () => {
    const out = stage("0.2.0");
    const pkg = join(out, "linux-x64", "package.json");
    writeFileSync(pkg, JSON.stringify({ name: LINUX, version: "0.1.9" }));
    expect(() => stagedPackages(out)).toThrow(
      "@tokenhud/linux-x64 is 0.1.9, but tokenhud is 0.2.0",
    );
  });
});

describe("publishing, with npm stood in for", () => {
  /** publishNpm with an npm that answers `answer` and records what it was asked. */
  async function publishWith(
    r: FakeNpm | Registry,
    out: string,
    answer: (args: string[]) => { code: number; output: string },
    trusted = false,
  ) {
    const calls: string[] = [];
    const log: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const summary: string[] = [];
    const ok = await publishNpm({
      dir: out,
      registry: "fetch" in r ? r : registryAt(r),
      provenance: true,
      trusted,
      intervalMs: 20_000,
      timeoutMs: 0,
      clock: fakeClock(),
      log: (l) => log.push(l),
      error: (l) => errors.push(l),
      warn: (l) => warnings.push(l),
      summary: (m) => summary.push(m),
      npm: async (args) => {
        calls.push(args.join(" "));
        return answer(args);
      },
    });
    return { ok, calls, log, errors, warnings, summary };
  }

  /** An npm that publishes to `r` as the real one would, by hand: here, only the call matters. */
  const succeeds = () => ({ code: 0, output: "" });

  test("everything already on npm, and next on the following release's candidates: nothing to do", async () => {
    const r = serve([listed(LINUX, "0.2.1"), listed(MAC, "0.2.1"), listed("tokenhud", "0.2.1")], {
      tokenhud: { latest: "0.2.1", next: "0.3.0-rc.1" },
    });
    const run = await publishWith(r, stage("0.2.1"), succeeds);
    expect(run).toEqual({
      ok: true,
      calls: [],
      log: [
        `${MAC}@0.2.1 is already on npm`,
        `${LINUX}@0.2.1 is already on npm`,
        "tokenhud@0.2.1 is already on npm",
        "tokenhud: next stays at 0.3.0-rc.1, not older than 0.2.1",
      ],
      errors: [],
      warnings: [],
      summary: [],
    });
  });

  test("npm refused (403): which package's trusted publisher to check, and nothing after it", async () => {
    const r = serve([listed(MAC, "0.2.0")]);
    const run = await publishWith(r, stage("0.2.0"), () => ({
      code: 1,
      output:
        "npm error code E403\nnpm error 403 Forbidden - PUT http://registry/@tokenhud%2flinux-x64\n",
    }));
    expect(run.ok).toBe(false);
    expect(run.calls).toEqual([
      `publish ${join(dir, "npm-0.2.0", "linux-x64")} --access public --tag latest --registry ${r.url} --provenance`,
    ]);
    expect(run.errors).toEqual([
      "npm publish @tokenhud/linux-x64 was refused: check the trusted publisher settings for " +
        "@tokenhud/linux-x64 on npmjs.com (repository ZhuoQiuMcgill/tokenhud, workflow " +
        "release.yml, no environment), and that this job has `id-token: write`.",
    ]);
  });

  test("npm says the version is already published: taken as published, and the wait goes on", async () => {
    const r = serve([listed(MAC, "0.2.0")]);
    const run = await publishWith(r, stage("0.2.0"), () => ({
      code: 1,
      output: "npm error You cannot publish over the previously published versions: 0.2.0.\n",
    }));
    expect(run.ok).toBe(false);
    expect(run.log[1]).toBe(`${LINUX}@0.2.0 is already on npm`);
    // The registry still doesn't list it, so the wait (0 s here) ends without tokenhud.
    expect(run.errors).toEqual([
      "tokenhud@0.2.0 was not published: after 0 s, these platform packages still couldn't " +
        "be downloaded: @tokenhud/linux-x64 (0.2.0 is not in its document yet). Re-run this " +
        "job: it skips what is published, and waits again.",
    ]);
  });

  // The release is out by then: a stale `next` must not fail the job.
  test("moving next refused: a warning and a summary with the command to run by hand, and success", async () => {
    const r = serve([listed(LINUX, "0.2.0"), listed(MAC, "0.2.0"), listed("tokenhud", "0.2.0")], {
      tokenhud: { latest: "0.2.0", next: "0.2.0-rc.1" },
    });
    const run = await publishWith(r, stage("0.2.0"), (args) =>
      args[0] === "dist-tag" ? { code: 1, output: "npm error code ENEEDAUTH\n" } : succeeds(),
    );
    expect(run.ok).toBe(true);
    expect(run.errors).toEqual([]);
    expect(run.calls).toEqual([`dist-tag add tokenhud@0.2.0 next --registry ${r.url}`]);
    expect(run.warnings).toEqual([
      "tokenhud@0.2.0 is published, but npm didn't move its next tag (still 0.2.0-rc.1). Check " +
        "that tokenhud's trusted publisher on npmjs.com allows npm dist-tag. Move it by hand: " +
        "npm dist-tag add tokenhud@0.2.0 next",
    ]);
    expect(run.summary).toEqual([
      "**tokenhud's `next` tag was not moved to 0.2.0.** The release is published; move the tag " +
        "by hand:\n\n```sh\nnpm dist-tag add tokenhud@0.2.0 next\n```",
    ]);
  });

  test("an npm that can't set dist-tags as a trusted publisher: stops before publishing anything", async () => {
    const r = serve([]);
    for (const version of ["11.5.1", "12.1.0"]) {
      const run = await publishWith(
        r,
        stage(`0.2.0`),
        () => ({ code: 0, output: `${version}\n` }),
        true,
      );
      expect([version, run.ok, run.calls]).toEqual([version, false, ["--version"]]);
      expect(run.errors).toEqual([
        `npm ${version} can't publish and set dist-tags as a trusted publisher: that takes npm ` +
          "11.21.0 or later (12.2.0 or later on npm 12). Nothing was published. Pin NPM_VERSION " +
          "in release.yml to such a version.",
      ]);
      rmSync(join(dir, "dist-0.2.0"), { recursive: true });
    }
    expect(r.events).toEqual([]);
    // One that can: the run goes on.
    const run = await publishWith(
      r,
      stage("0.2.0"),
      (args) => (args[0] === "--version" ? { code: 0, output: "11.21.0\n" } : succeeds()),
      true,
    );
    expect(run.calls.slice(0, 2)).toEqual([
      "--version",
      `publish ${join(dir, "npm-0.2.0", "darwin-arm64")} --access public --tag latest --registry ${r.url} --provenance`,
    ]);
  });

  test("the npm versions that can: 11.21.0 on, and 12.2.0 on", () => {
    const can = ["11.5.1", "11.21.0", "11.30.2", "12.0.0", "12.1.9", "12.2.0", "13.0.0"].filter(
      (v) => Bun.semver.satisfies(v, TRUSTED_NPM),
    );
    expect(can).toEqual(["11.21.0", "11.30.2", "12.2.0", "13.0.0"]);
  });

  test("a registry that fails while saying what is published: stops, with the re-run hint", async () => {
    const broken = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("oops", { status: 503 }),
    });
    try {
      const run = await publishWith(
        { url: `http://127.0.0.1:${broken.port}/`, fetch, requestTimeoutMs: 5_000 },
        stage("0.2.0"),
        succeeds,
      );
      expect([run.ok, run.calls]).toEqual([false, []]);
      expect(run.errors).toEqual([
        "the registry answered 503 for @tokenhud/darwin-arm64. The run stopped there. Re-run " +
          "this job: it skips what is already published.",
      ]);
    } finally {
      broken.stop(true);
    }
  });

  describe("a prerelease's tag", () => {
    /** The tag each platform package and tokenhud were published under. */
    const tags = (calls: string[]) =>
      calls.filter((c) => c.startsWith("publish")).map((c) => /--tag (\S+)/.exec(c)?.[1]);

    test("next, when it is newer than next or next is unset, or (a re-run) is next", async () => {
      for (const [next, version] of [
        [undefined, "0.2.0-rc.1"],
        ["0.2.0-rc.1", "0.2.0-rc.2"],
        ["0.1.0", "0.3.0-rc.1"],
      ] as const) {
        const r = serve([listed("tokenhud", "0.1.0")], {
          tokenhud: { latest: "0.1.0", ...(next === undefined ? {} : { next }) },
        });
        const run = await publishWith(r, stage(version), succeeds);
        expect([next, tags(run.calls), run.summary]).toEqual([next, ["next", "next"], []]);
      }
      // A re-run after tokenhud went out: next is this version, and stays its tag.
      const r = serve([listed(LINUX, "0.2.0-rc.3"), listed(MAC, "0.2.0-rc.3")], {
        tokenhud: { latest: "0.1.0", next: "0.2.0-rc.3" },
      });
      const run = await publishWith(r, stage("0.2.0-rc.3"), succeeds);
      expect(tags(run.calls)).toEqual(["next"]);
    });

    // A backport's candidate (0.1.2-rc.1 while next holds 0.2.0-rc.1) would move next back.
    test("next-<major>.<minor> when next is newer, said in the log and the summary", async () => {
      const r = serve([listed("tokenhud", "0.1.1")], {
        tokenhud: { latest: "0.1.1", next: "0.2.0-rc.1" },
      });
      const run = await publishWith(r, stage("0.1.2-rc.1"), succeeds);
      // The platform packages'. (The stand-in npm sends nothing, so tokenhud's wait runs out;
      // the real npm's test publishes it under next-0.2.)
      expect(tags(run.calls)).toEqual(["next-0.1", "next-0.1"]);
      expect(run.log[0]).toBe(
        "tokenhud@0.1.2-rc.1 is older than next: it goes under next-0.1, and next stays",
      );
      expect(run.summary).toEqual([
        "**tokenhud 0.1.2-rc.1 is published under `next-0.1`**, not `next`, which holds a newer " +
          "prerelease. Install it with `bun add -g tokenhud@next-0.1` or " +
          "`npm install -g tokenhud@next-0.1`.",
      ]);
      // A prerelease never moves next with dist-tag: publishing set the tag.
      expect(run.calls.filter((c) => c.startsWith("dist-tag"))).toEqual([]);
    });
  });
});

describe("the release workflow", () => {
  // LF line ends: a Windows checkout may give them CRLF ones.
  const workflow = (name: string) =>
    readFileSync(
      join(import.meta.dir, "..", "..", ".github", "workflows", name),
      "utf8",
    ).replaceAll("\r\n", "\n");

  test("publishes with this script as a trusted publisher, on the Node and npm CI tests it with", () => {
    const release = workflow("release.yml");
    const ci = workflow("ci.yml");
    const job = release.slice(release.indexOf("\n  npm:\n"));
    // npm's own registry, which turns on the check that npm can be a trusted publisher.
    expect(job).toContain(
      "bun scripts/stage-npm.ts\n          bun scripts/publish-npm.ts --provenance\n",
    );
    expect(job).toContain("id-token: write");
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    const node = /^ {2}NODE_VERSION: (\S+)$/m.exec(release)?.[1] as string;
    const npm = /^ {2}NPM_VERSION: (\S+)$/m.exec(release)?.[1] as string;
    // What npm's trusted publishing needs, `npm dist-tag` included.
    expect([
      Bun.semver.satisfies(node, ">=22.14.0"),
      Bun.semver.satisfies(npm, TRUSTED_NPM),
    ]).toEqual([true, true]);
    expect(ci).toContain(`node-version: ${node}\n`);
    expect(ci).toContain(`npm install --global npm@${npm} `);
  });
});

// The script as the release workflow runs it, with the real npm.
const NPM = Bun.which("npm");

describe.skipIf(NPM === null || process.platform === "win32")("publishing with npm", () => {
  /** Runs the script on `out` against `r`, as the release job does but for the registry. */
  async function publish(
    r: FakeNpm,
    out: string,
    timeout = "30",
    extra: Record<string, string> = {},
  ) {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const npmrc = join(dir, "npmrc");
    writeFileSync(npmrc, `//${new URL(r.url).host}/:_authToken=${TOKEN}\n`);
    // Nothing that points npm at another registry, account or CI identity.
    const skip = /^(home|userprofile|ci|node_auth_token|npm_config_.*|actions_.*|github_.*)$/i;
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !skip.test(name)) env[name] = value;
    }
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "..", "scripts", "publish-npm.ts"),
        "--dir",
        out,
        "--registry",
        r.url,
        "--interval",
        "0.05",
        "--timeout",
        timeout,
      ],
      {
        env: {
          ...env,
          HOME: home,
          npm_config_userconfig: npmrc,
          npm_config_cache: join(dir, "npm-cache"),
          npm_config_registry: r.url,
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false",
          ...extra,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  test("the platform packages, a wait while one tarball 404s, then tokenhud, and its next moved up", async () => {
    const r = serve(
      [listed("tokenhud", "0.1.0"), listed("tokenhud", "0.2.0-rc.1")],
      { tokenhud: { latest: "0.1.0", next: "0.2.0-rc.1" } },
      (id, nth) => (id === `${LINUX}@0.2.0` && nth <= 3 ? "missing" : undefined),
    );
    const run = await publish(r, stage("0.2.0"));
    expect([run.code, run.stderr]).toEqual([0, expect.any(String)]);
    expect(run.stdout).toContain(
      "waiting for 1 of 2 platform tarballs (0 s): @tokenhud/linux-x64: its tarball answers 404",
    );
    const publishes = [`publish ${MAC}@0.2.0`, `publish ${LINUX}@0.2.0`];
    const done = ["publish tokenhud@0.2.0", "dist-tag tokenhud next=0.2.0"];
    expect(r.events.slice(0, 2)).toEqual(publishes);
    expect(r.events.slice(-2)).toEqual(done);
    // In between, every check: tokenhud only after both tarballs came back whole.
    expect(r.events.slice(2, -2).sort()).toEqual([
      `tarball ${MAC}@0.2.0 200`,
      `tarball ${LINUX}@0.2.0 200`,
      `tarball ${LINUX}@0.2.0 404`,
      `tarball ${LINUX}@0.2.0 404`,
      `tarball ${LINUX}@0.2.0 404`,
    ]);
    expect(r.tags("tokenhud")).toEqual({ latest: "0.2.0", next: "0.2.0" });
    // The platform packages' tags are left as publishing set them.
    expect(r.tags(LINUX)).toEqual({ latest: "0.2.0" });
  }, 120_000);

  test("a tarball that never downloads: no tokenhud and a failed job that says why; a re-run finishes", async () => {
    let served = false;
    const r = serve([], {}, (id) => (id === `${LINUX}@0.3.0` && !served ? "missing" : undefined));
    const out = stage("0.3.0");
    const failed = await publish(r, out, "0.3");
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(
      "::error::tokenhud@0.3.0 was not published: after 0 s, these platform packages still " +
        "couldn't be downloaded: @tokenhud/linux-x64 (its tarball answers 404). Re-run this " +
        "job: it skips what is published, and waits again.",
    );
    expect(r.events.filter((e) => e.startsWith("publish"))).toEqual([
      `publish ${MAC}@0.3.0`,
      `publish ${LINUX}@0.3.0`,
    ]);

    served = true;
    const from = r.events.length;
    const rerun = await publish(r, out);
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toContain(`${MAC}@0.3.0 is already on npm`);
    expect(rerun.stdout).toContain(`${LINUX}@0.3.0 is already on npm`);
    expect(r.events.slice(from).filter((e) => !e.startsWith("tarball"))).toEqual([
      "publish tokenhud@0.3.0",
      "dist-tag tokenhud next=0.3.0",
    ]);
  }, 120_000);

  test("a prerelease: published under next, latest left alone, no tag moved", async () => {
    const r = serve([listed("tokenhud", "0.1.0")], { tokenhud: { latest: "0.1.0" } });
    const run = await publish(r, stage("0.2.0-rc.1"));
    expect(run.code).toBe(0);
    expect(r.events.filter((e) => !e.startsWith("tarball"))).toEqual([
      `publish ${MAC}@0.2.0-rc.1`,
      `publish ${LINUX}@0.2.0-rc.1`,
      "publish tokenhud@0.2.0-rc.1",
    ]);
    expect(r.tags("tokenhud")).toEqual({ latest: "0.1.0", next: "0.2.0-rc.1" });
  }, 120_000);

  test("a backport's prerelease, older than next: under next-0.2, next left alone, and the summary says so", async () => {
    const r = serve([listed("tokenhud", "0.3.0-rc.1")], {
      tokenhud: { latest: "0.2.0", next: "0.3.0-rc.1" },
    });
    const summary = join(dir, "summary.md");
    const run = await publish(r, stage("0.2.1-rc.1"), "30", { GITHUB_STEP_SUMMARY: summary });
    expect(run.code).toBe(0);
    expect(r.events.filter((e) => !e.startsWith("tarball"))).toEqual([
      `publish ${MAC}@0.2.1-rc.1`,
      `publish ${LINUX}@0.2.1-rc.1`,
      "publish tokenhud@0.2.1-rc.1",
    ]);
    expect(r.tags("tokenhud")).toEqual({
      latest: "0.2.0",
      next: "0.3.0-rc.1",
      "next-0.2": "0.2.1-rc.1",
    });
    expect(readFileSync(summary, "utf8")).toContain(
      "**tokenhud 0.2.1-rc.1 is published under `next-0.2`**",
    );
  }, 120_000);
});
