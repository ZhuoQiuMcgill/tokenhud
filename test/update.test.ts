import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdate, type UpdateDeps } from "../src/commands/update.ts";
import { formatSums, sumFor } from "../src/release.ts";
import {
  availableUpdate,
  compareVersions,
  downloadVerified,
  installMethod,
  isCompiled,
  newestRelease,
  parseVersion,
  type Release,
  removeStaleOld,
  replaceBinary,
  type Version,
} from "../src/update.ts";

const v = (text: string) => parseVersion(text) as Version;
const sha256 = (data: string) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

describe("versions", () => {
  test("parses semver, with or without v, prerelease ids numeric where they are digits", () => {
    expect(parseVersion("v0.1.0-rc.1")).toEqual({ major: 0, minor: 1, patch: 0, pre: ["rc", 1] });
    expect(parseVersion("1.22.333")).toEqual({ major: 1, minor: 22, patch: 333, pre: [] });
    expect(parseVersion("1.0.0+build.5")).toEqual({ major: 1, minor: 0, patch: 0, pre: [] });
  });

  test.each(["1.0", "01.0.0", "1.0.0-", "1.0.0-rc..1", "latest", "v", ""])(
    "'%s' is not a version",
    (text) => {
      expect(parseVersion(text)).toBeNull();
    },
  );

  test("orders as semver §11 does, its own example included", () => {
    const ordered = [
      "0.0.9",
      "0.1.0-rc.1",
      "0.1.0-rc.2",
      "0.1.0-rc.11",
      "0.1.0",
      "0.1.1",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "2.0.0",
      "2.1.0",
      "2.1.1",
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        const order = Math.sign(compareVersions(v(ordered[i] as string), v(ordered[j] as string)));
        expect([ordered[i], ordered[j], order]).toEqual([ordered[i], ordered[j], Math.sign(i - j)]);
      }
    }
  });
});

describe("install method", () => {
  const prefix = (value: string | null) => {
    const calls: number[] = [];
    const ask = () => {
      calls.push(1);
      return value;
    };
    return { ask, calls };
  };

  test("Bun running src/ is a source checkout; a binary from Bun's bundle is compiled", () => {
    expect(installMethod("/home/u/.bun/bin/bun", false, () => null)).toEqual({ kind: "source" });
    expect(isCompiled("/$bunfs/root/cli.js")).toBe(true);
    expect(isCompiled("B:/~BUN/root/cli.exe")).toBe(true);
    expect(isCompiled("/home/u/tokenhud/src/cli.ts")).toBe(false);
  });

  test.each([
    ["/home/u/.local/bin/tokenhud", { kind: "binary" }],
    ["C:\\Users\\u\\AppData\\Local\\tokenhud\\bin\\tokenhud.exe", { kind: "binary" }],
    ["/home/u/.npm/_npx/6a1b/node_modules/@tokenhud/linux-x64/bin/tokenhud", { kind: "npx" }],
    [
      "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\6a1b\\node_modules\\@tokenhud\\win32-x64\\bin\\tokenhud.exe",
      { kind: "npx" },
    ],
    [
      "/tmp/bunx-1000-tokenhud@latest/node_modules/@tokenhud/linux-x64/bin/tokenhud",
      { kind: "bunx" },
    ],
    [
      "/home/u/.bun/install/global/node_modules/@tokenhud/linux-x64-musl/bin/tokenhud",
      { kind: "bun-global" },
    ],
  ])("%s is %j, without asking npm", (path, expected) => {
    const p = prefix("/usr/local");
    expect(installMethod(path, true, p.ask)).toEqual(expected as never);
    expect(p.calls).toEqual([]);
  });

  test("npm: global under `npm prefix -g`, otherwise a project's dependency", () => {
    const global =
      "/usr/local/lib/node_modules/tokenhud/node_modules/@tokenhud/linux-x64/bin/tokenhud";
    const project = "/home/u/app/node_modules/@tokenhud/linux-x64/bin/tokenhud";
    expect(installMethod(global, true, prefix("/usr/local").ask)).toEqual({
      kind: "npm",
      global: true,
    });
    expect(installMethod(project, true, prefix("/usr/local").ask)).toEqual({
      kind: "npm",
      global: false,
    });
    // A prefix that merely starts the same way is not a parent directory.
    expect(installMethod(global, true, prefix("/usr/loc").ask)).toEqual({
      kind: "npm",
      global: false,
    });
  });

  test("npm on Windows compares paths case-insensitively, either slash", () => {
    const exe =
      "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\tokenhud\\node_modules\\@tokenhud\\win32-x64\\bin\\tokenhud.exe";
    expect(installMethod(exe, true, prefix("c:\\users\\u\\appdata\\roaming\\npm\\").ask)).toEqual({
      kind: "npm",
      global: true,
    });
  });

  test("npm that can't be asked counts as global", () => {
    const exe = "/opt/node/lib/node_modules/tokenhud/node_modules/@tokenhud/linux-x64/bin/tokenhud";
    expect(installMethod(exe, true, prefix(null).ask)).toEqual({ kind: "npm", global: true });
  });
});

/** A fetch that answers from a table of URL → response makers, and records what it was asked. */
function fakeFetch(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return route();
  }) as typeof fetch;
  return { fn, asked };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const API = "https://api.example/repos/o/r";

function rawRelease(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-"),
    assets: [
      { name: "tokenhud-linux-x64", browser_download_url: `https://dl.example/${tag}/bin` },
      { name: "SHA256SUMS", browser_download_url: `https://dl.example/${tag}/sums` },
    ],
    ...extra,
  };
}

describe("newest release", () => {
  test("stable asks GitHub's latest and reads tag, kind and assets", async () => {
    const f = fakeFetch({ [`${API}/releases/latest`]: json(rawRelease("v0.2.0")) });
    const r = (await newestRelease(API, false, f.fn)) as Release;
    expect(f.asked).toEqual([`${API}/releases/latest`]);
    expect(r.tag).toBe("v0.2.0");
    expect(r.prerelease).toBe(false);
    expect(r.version).toEqual(v("0.2.0"));
    expect([...r.assets.keys()]).toEqual(["tokenhud-linux-x64", "SHA256SUMS"]);
  });

  test("no stable release yet is null", async () => {
    const f = fakeFetch({});
    expect(await newestRelease(API, false, f.fn)).toBeNull();
  });

  test("with prereleases, the highest version wins, whatever the list order; drafts never", async () => {
    const f = fakeFetch({
      [`${API}/releases?per_page=30`]: json([
        rawRelease("v0.1.0-rc.2"),
        rawRelease("v0.2.0-rc.1", { draft: true }),
        rawRelease("v0.1.0-rc.10"),
        rawRelease("not-a-version"),
        rawRelease("v0.0.9"),
      ]),
    });
    expect(((await newestRelease(API, true, f.fn)) as Release).tag).toBe("v0.1.0-rc.10");
  });

  test("a non-JSON answer is a clear error", async () => {
    const html = fakeFetch({ [`${API}/releases/latest`]: () => new Response("<html>oops</html>") });
    await expect(newestRelease(API, false, html.fn)).rejects.toThrow("didn't answer with JSON");
  });

  test("a rate limit and an unreachable host are clear errors", async () => {
    const limited = fakeFetch({
      [`${API}/releases/latest`]: () => new Response("", { status: 403 }),
    });
    await expect(newestRelease(API, false, limited.fn)).rejects.toThrow("rate limit");
    const down = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(newestRelease(API, false, down)).rejects.toThrow(
      "can't reach api.example: connection refused",
    );
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenhud-update-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function release(tag: string): Release {
  return {
    tag,
    version: v(tag),
    prerelease: tag.includes("-"),
    assets: new Map([
      ["tokenhud-linux-x64", `https://dl.example/${tag}/bin`],
      ["SHA256SUMS", `https://dl.example/${tag}/sums`],
    ]),
  };
}

function releaseFetch(tag: string, binary: string, sums: string) {
  return fakeFetch({
    [`https://dl.example/${tag}/bin`]: () => new Response(binary),
    [`https://dl.example/${tag}/sums`]: () => new Response(sums),
  });
}

describe("download", () => {
  const sums = (binary: string) => formatSums(new Map([["tokenhud-linux-x64", sha256(binary)]]));

  test("writes the asset when its SHA-256 matches SHA256SUMS", async () => {
    const dest = join(dir, "new");
    const f = releaseFetch("v1.0.0", "NEW BINARY", sums("NEW BINARY"));
    const bytes = await downloadVerified(release("v1.0.0"), "tokenhud-linux-x64", dest, f.fn);
    expect(bytes).toBe(10);
    expect(readFileSync(dest, "utf8")).toBe("NEW BINARY");
  });

  test("a checksum mismatch leaves no file and names both sums", async () => {
    const dest = join(dir, "new");
    const f = releaseFetch("v1.0.0", "TAMPERED", sums("NEW BINARY"));
    const done = downloadVerified(release("v1.0.0"), "tokenhud-linux-x64", dest, f.fn);
    await expect(done).rejects.toThrow(
      `expected ${sha256("NEW BINARY")}, got ${sha256("TAMPERED")}`,
    );
    expect(existsSync(dest)).toBe(false);
  });

  test("an asset SHA256SUMS doesn't list is refused before downloading it", async () => {
    const f = releaseFetch("v1.0.0", "NEW", formatSums(new Map([["other", sha256("x")]])));
    await expect(
      downloadVerified(release("v1.0.0"), "tokenhud-linux-x64", join(dir, "n"), f.fn),
    ).rejects.toThrow("SHA256SUMS of v1.0.0 lists no tokenhud-linux-x64");
    expect(f.asked).toEqual(["https://dl.example/v1.0.0/sums"]);
  });

  test("SHA256SUMS is read in sha256sum's text and binary forms", () => {
    const hex = sha256("x");
    expect(sumFor(`${hex}  a\n${hex.toUpperCase()} *b\r\n`, "b")).toBe(hex);
    expect(sumFor(`${hex}  a\n`, "a")).toBe(hex);
    expect(sumFor(`${hex}  ab\n`, "a")).toBeNull();
  });
});

describe("replacing the binary", () => {
  test("POSIX: renames the new file over the old one", () => {
    const exe = join(dir, "tokenhud");
    writeFileSync(exe, "old");
    writeFileSync(join(dir, "fresh"), "new");
    replaceBinary(exe, join(dir, "fresh"), "linux");
    expect(readFileSync(exe, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["tokenhud"]);
  });

  test("Windows: parks the old exe as .old first, clearing a stale one", () => {
    const exe = join(dir, "tokenhud.exe");
    writeFileSync(exe, "old");
    writeFileSync(`${exe}.old`, "older");
    writeFileSync(join(dir, "fresh.exe"), "new");
    replaceBinary(exe, join(dir, "fresh.exe"), "win32");
    expect(readFileSync(exe, "utf8")).toBe("new");
    expect(readFileSync(`${exe}.old`, "utf8")).toBe("old");
    expect(readdirSync(dir).sort()).toEqual(["tokenhud.exe", "tokenhud.exe.old"]);
  });

  test("Windows: puts the old exe back when the new one can't take its place", () => {
    const exe = join(dir, "tokenhud.exe");
    writeFileSync(exe, "old");
    expect(() => replaceBinary(exe, join(dir, "missing.exe"), "win32")).toThrow();
    expect(readFileSync(exe, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["tokenhud.exe"]);
  });

  test("the next start deletes parked copies, and only those", () => {
    const exe = join(dir, "tokenhud.exe");
    const names = [
      "tokenhud.exe",
      "tokenhud.exe.old",
      "tokenhud.exe.1759363200000.old",
      "tokenhud.exe.oldish",
      "other.exe.old",
    ];
    for (const name of names) writeFileSync(join(dir, name), "x");
    removeStaleOld(exe);
    expect(readdirSync(dir).sort()).toEqual([
      "other.exe.old",
      "tokenhud.exe",
      "tokenhud.exe.oldish",
    ]);
  });
});

describe("tokenhud update", () => {
  /** A fake GitHub on localhost, serving `tags` with the asset downloads behind a redirect. */
  function serve(tags: Record<string, string>, opts: { stable?: string; tamper?: boolean } = {}) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req): Response {
        const url = new URL(req.url);
        const base: string = `http://127.0.0.1:${server.port}`;
        const meta = (tag: string): object => ({
          tag_name: tag,
          draft: false,
          prerelease: tag.includes("-"),
          assets: [
            { name: "tokenhud-linux-x64", browser_download_url: `${base}/dl/${tag}/bin` },
            { name: "SHA256SUMS", browser_download_url: `${base}/dl/${tag}/sums` },
          ],
        });
        if (url.pathname === "/api/releases/latest") {
          return opts.stable === undefined
            ? new Response("", { status: 404 })
            : Response.json(meta(opts.stable));
        }
        if (url.pathname === "/api/releases") return Response.json(Object.keys(tags).map(meta));
        const m = /^\/dl\/([^/]+)\/(bin|sums)$/.exec(url.pathname);
        if (m !== null) return Response.redirect(`${base}/blob/${m[1]}/${m[2]}`, 302);
        const b = /^\/blob\/([^/]+)\/(bin|sums)$/.exec(url.pathname);
        const body = b === null ? undefined : tags[b[1] as string];
        if (b === null || body === undefined) return new Response("", { status: 404 });
        if (b[2] === "bin") return new Response(opts.tamper ? `${body}!` : body);
        return new Response(formatSums(new Map([["tokenhud-linux-x64", sha256(body)]])));
      },
    });
    return server;
  }

  function deps(port: number | undefined, over: Partial<UpdateDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const exe = join(dir, "bin", "tokenhud");
    mkdirSync(join(dir, "bin"), { recursive: true });
    if (!existsSync(exe)) writeFileSync(exe, "OLD 0.0.9");
    const d: UpdateDeps = {
      env: { TOKENHUD_RELEASES_API: `http://127.0.0.1:${port}/api` },
      version: "0.0.9",
      execPath: exe,
      compiled: true,
      platform: "linux",
      target: "linux-x64",
      fetch,
      npmPrefix: () => null,
      // The fake binaries' content says which version they are; like a real one, a file
      // that isn't executable doesn't run.
      versionOf: (bin) =>
        process.platform !== "win32" && (statSync(bin).mode & 0o111) === 0
          ? "EACCES: permission denied"
          : `tokenhud ${readFileSync(bin, "utf8").replace(/^NEW /, "")}`,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...over,
    };
    return { d, out, err, exe };
  }

  test("replaces an older binary with the newest stable release and says old → new", async () => {
    using server = serve(
      { "v0.1.0": "NEW 0.1.0", "v0.2.0-rc.1": "NEW 0.2.0-rc.1" },
      { stable: "v0.1.0" },
    );
    const { d, out, err, exe } = deps(server.port);
    expect(await runUpdate([], d)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      "downloading tokenhud-linux-x64 from v0.1.0…",
      "checksum ok (0.0 MB)",
      `updated tokenhud 0.0.9 → 0.1.0 (${exe})`,
    ]);
    expect(readFileSync(exe, "utf8")).toBe("NEW 0.1.0");
    expect(readdirSync(join(dir, "bin"))).toEqual(["tokenhud"]);
    if (process.platform !== "win32") expect(statSync(exe).mode & 0o777).toBe(0o755);
  });

  test("--prerelease takes the newest release candidate", async () => {
    using server = serve({ "v0.1.0-rc.1": "NEW 0.1.0-rc.1" });
    const { d, out, exe } = deps(server.port);
    expect(await runUpdate(["--prerelease"], d)).toBe(0);
    expect(out.at(-1)).toBe(`updated tokenhud 0.0.9 → 0.1.0-rc.1 (${exe})`);
    expect(readFileSync(exe, "utf8")).toBe("NEW 0.1.0-rc.1");
  });

  test("without --prerelease, only a release candidate out says so and changes nothing", async () => {
    using server = serve({ "v0.1.0-rc.1": "NEW 0.1.0-rc.1" });
    const { d, out, exe } = deps(server.port);
    expect(await runUpdate([], d)).toBe(0);
    expect(out).toEqual([
      "no stable release yet; tokenhud update --prerelease includes prereleases",
    ]);
    expect(readFileSync(exe, "utf8")).toBe("OLD 0.0.9");
  });

  test("--check reports and changes nothing", async () => {
    using server = serve({ "v0.1.0-rc.1": "NEW 0.1.0-rc.1" });
    const { d, out, exe } = deps(server.port);
    expect(await runUpdate(["--check", "--prerelease"], d)).toBe(0);
    expect(out).toEqual([
      "update available: tokenhud 0.0.9 → 0.1.0-rc.1",
      "run: tokenhud update --prerelease",
    ]);
    expect(readFileSync(exe, "utf8")).toBe("OLD 0.0.9");
  });

  test("up to date, and newer than the latest release", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0" });
    const same = deps(server.port, { version: "0.1.0" });
    expect(await runUpdate([], same.d)).toBe(0);
    expect(same.out).toEqual(["tokenhud 0.1.0 is up to date"]);
    const ahead = deps(server.port, { version: "0.1.1-rc.1" });
    expect(await runUpdate([], ahead.d)).toBe(0);
    expect(ahead.out).toEqual(["tokenhud 0.1.1-rc.1 is newer than the latest release (0.1.0)"]);
  });

  test("a tampered download is refused and the old binary stays", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0", tamper: true });
    const { d, err, exe } = deps(server.port);
    expect(await runUpdate([], d)).toBe(1);
    expect(err[0]).toContain("tokenhud-linux-x64 failed its checksum");
    expect(err[0]).toEndWith("nothing was changed");
    expect(readFileSync(exe, "utf8")).toBe("OLD 0.0.9");
    expect(readdirSync(join(dir, "bin"))).toEqual(["tokenhud"]);
  });

  test("a download that doesn't run, or claims another version, is not installed", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0" });
    const { d, err, exe } = deps(server.port, { versionOf: () => "exit 127: not found" });
    expect(await runUpdate([], d)).toBe(1);
    expect(err).toEqual([
      "the downloaded binary didn't report version 0.1.0 (exit 127: not found); nothing was changed",
    ]);
    expect(readFileSync(exe, "utf8")).toBe("OLD 0.0.9");
    expect(readdirSync(join(dir, "bin"))).toEqual(["tokenhud"]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an install directory it can't write to fails before downloading",
    async () => {
      using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0" });
      const { d, out, err, exe } = deps(server.port);
      chmodSync(join(dir, "bin"), 0o555);
      try {
        expect(await runUpdate([], d)).toBe(1);
      } finally {
        chmodSync(join(dir, "bin"), 0o755);
      }
      expect(out).toEqual([]);
      expect(err[0]).toStartWith(`can't replace ${exe} (EACCES)`);
      expect(readFileSync(exe, "utf8")).toBe("OLD 0.0.9");
    },
  );

  test("an npm install gets the npm command instead of a self-update", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0" });
    const exe =
      "/usr/local/lib/node_modules/tokenhud/node_modules/@tokenhud/linux-x64/bin/tokenhud";
    const { d, out } = deps(server.port, { execPath: exe, npmPrefix: () => "/usr/local" });
    expect(await runUpdate([], d)).toBe(0);
    expect(out).toEqual([
      "update available: tokenhud 0.0.9 → 0.1.0",
      "installed with npm; update with:  npm install -g tokenhud@latest",
    ]);
  });

  test("npx with --prerelease points at the next dist-tag", async () => {
    using server = serve({ "v0.1.0-rc.1": "NEW 0.1.0-rc.1" });
    const exe = "/home/u/.npm/_npx/1/node_modules/@tokenhud/linux-x64/bin/tokenhud";
    const { d, out } = deps(server.port, { execPath: exe });
    expect(await runUpdate(["--prerelease"], d)).toBe(0);
    expect(out[1]).toBe(
      "run through npx, which keeps a cached copy; for the newest one run:  npx tokenhud@next",
    );
  });

  test("GitHub unreachable: exit 1 with the reason", async () => {
    const { d, err } = deps(1, { env: { TOKENHUD_RELEASES_API: "http://127.0.0.1:1/api" } });
    expect(await runUpdate([], d)).toBe(1);
    expect(err[0]).toStartWith("can't reach 127.0.0.1:1");
  });

  test("a binary that doesn't know its platform asks for a reinstall", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0" });
    const { d, err } = deps(server.port, { target: undefined });
    expect(await runUpdate([], d)).toBe(1);
    expect(err).toEqual([
      "this binary doesn't know its platform; reinstall it with install.sh or install.ps1",
    ]);
  });
});

describe("the TUI's once-a-day update check", () => {
  const DAY = 24 * 3_600_000;
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const env = { TOKENHUD_RELEASES_API: API };

  function check(over: { version?: string; now?: number; fetch?: typeof fetch } = {}) {
    return availableUpdate({
      statePath: join(dir, "update-check.json"),
      env,
      version: over.version ?? "0.1.0",
      now: over.now ?? NOW,
      ...(over.fetch === undefined ? {} : { fetch: over.fetch }),
    });
  }
  const state = () => JSON.parse(readFileSync(join(dir, "update-check.json"), "utf8"));
  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;

  test("asks GitHub when it never has, names a newer release, and remembers when", async () => {
    const f = fakeFetch({ [`${API}/releases/latest`]: json(rawRelease("v0.2.0")) });
    expect(await check({ fetch: f.fn })).toBe("0.2.0");
    expect(f.asked).toEqual([`${API}/releases/latest`]);
    expect(state()).toEqual({ checked_at: NOW, latest: "0.2.0" });
  });

  test("within a day, answers from the last check without asking", async () => {
    writeFileSync(
      join(dir, "update-check.json"),
      JSON.stringify({ checked_at: NOW - DAY + 1, latest: "0.2.0" }),
    );
    expect(await check({ fetch: offline })).toBe("0.2.0");
    expect(await check({ fetch: offline, version: "0.2.0" })).toBeNull();
  });

  test("a day later, or with the clock moved back, asks again", async () => {
    const f = fakeFetch({ [`${API}/releases/latest`]: json(rawRelease("v0.3.0")) });
    writeFileSync(
      join(dir, "update-check.json"),
      JSON.stringify({ checked_at: NOW - DAY, latest: "0.2.0" }),
    );
    expect(await check({ fetch: f.fn })).toBe("0.3.0");
    writeFileSync(
      join(dir, "update-check.json"),
      JSON.stringify({ checked_at: NOW + 60_000, latest: "0.2.0" }),
    );
    expect(await check({ fetch: f.fn })).toBe("0.3.0");
    expect(f.asked.length).toBe(2);
  });

  test("offline: keeps the last answer and doesn't ask again until tomorrow", async () => {
    writeFileSync(
      join(dir, "update-check.json"),
      JSON.stringify({ checked_at: NOW - 2 * DAY, latest: "0.2.0" }),
    );
    expect(await check({ fetch: offline })).toBe("0.2.0");
    expect(state()).toEqual({ checked_at: NOW, latest: "0.2.0" });
  });

  test("a prerelease build hears about prereleases; a release build doesn't", async () => {
    const f = fakeFetch({
      [`${API}/releases?per_page=30`]: json([rawRelease("v0.1.0-rc.2"), rawRelease("v0.1.0-rc.1")]),
      [`${API}/releases/latest`]: () => new Response("", { status: 404 }),
    });
    expect(await check({ fetch: f.fn, version: "0.1.0-rc.1" })).toBe("0.1.0-rc.2");
    rmSync(join(dir, "update-check.json"));
    expect(await check({ fetch: f.fn, version: "0.0.9" })).toBeNull();
    expect(f.asked).toEqual([`${API}/releases?per_page=30`, `${API}/releases/latest`]);
  });

  test("an unreadable state file is a first check", async () => {
    writeFileSync(join(dir, "update-check.json"), "{not json");
    const f = fakeFetch({ [`${API}/releases/latest`]: json(rawRelease("v0.1.0")) });
    expect(await check({ fetch: f.fn })).toBeNull();
    expect(f.asked.length).toBe(1);
  });
});
