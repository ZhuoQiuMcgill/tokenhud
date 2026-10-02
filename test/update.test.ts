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
  symlinkSync,
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
  packageManagerUpdate,
  parkingPath,
  parseVersion,
  platformPackageOf,
  type Release,
  type ReleaseSource,
  releaseSource,
  removeStaleOld,
  replaceBinary,
  type Version,
} from "../src/update.ts";
import { guard, takeSpawned } from "./guard.ts";

guard();

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
      { kind: "bun-global", root: "/home/u/.bun" },
    ],
    [
      "C:\\Users\\u\\.bun\\install\\global\\node_modules\\@tokenhud\\win32-x64\\bin\\tokenhud.exe",
      { kind: "bun-global", root: "C:\\Users\\u\\.bun" },
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

  test("bun's global packages under BUN_INSTALL, wherever it points; not elsewhere", () => {
    const exe = "/opt/bun/install/global/node_modules/@tokenhud/linux-x64/bin/tokenhud";
    const ask = prefix("/usr/local");
    expect(installMethod(exe, true, ask.ask, { BUN_INSTALL: "/opt/bun/" })).toEqual({
      kind: "bun-global",
      root: "/opt/bun",
    });
    expect(ask.calls).toEqual([]);
    // The same layout without BUN_INSTALL naming it is some other install/global dir.
    expect(installMethod(exe, true, prefix("/usr/local").ask, {})).toEqual({
      kind: "npm",
      global: false,
    });
    const win = "D:\\Bun\\install\\global\\node_modules\\@tokenhud\\win32-x64\\bin\\tokenhud.exe";
    expect(installMethod(win, true, prefix(null).ask, { BUN_INSTALL: "d:\\bun" })).toEqual({
      kind: "bun-global",
      root: "D:\\Bun",
    });
  });

  test.skipIf(process.platform === "win32")(
    "BUN_INSTALL through a link: the binary's own path has the link resolved",
    () => {
      const real = join(dir, "real-bun");
      mkdirSync(join(real, "install", "global", "node_modules"), { recursive: true });
      symlinkSync(real, join(dir, "linked-bun"));
      const exe = join(
        real,
        "install",
        "global",
        "node_modules",
        "@tokenhud",
        "linux-x64",
        "bin",
        "tokenhud",
      );
      expect(
        installMethod(exe, true, prefix(null).ask, { BUN_INSTALL: join(dir, "linked-bun") }),
      ).toEqual({ kind: "bun-global", root: real });
    },
  );

  test("the platform package a binary comes from", () => {
    expect(
      platformPackageOf(
        "/home/u/.bun/install/global/node_modules/@tokenhud/linux-x64-musl/bin/tokenhud",
      ),
    ).toBe("@tokenhud/linux-x64-musl");
    expect(
      platformPackageOf(
        "C:\\npm\\node_modules\\tokenhud\\node_modules\\@tokenhud\\win32-x64\\bin\\tokenhud.exe",
      ),
    ).toBe("@tokenhud/win32-x64");
    expect(platformPackageOf("/home/u/.local/bin/tokenhud")).toBeNull();
  });
});

describe("the package manager's command", () => {
  const bun = { kind: "bun-global", root: "/home/u/.bun" } as const;
  const npm = { kind: "npm", global: true } as const;

  test("bun: add -g without its cached registry answers, in the bun install that has tokenhud", () => {
    expect(packageManagerUpdate(bun, "latest", "@tokenhud/linux-x64")).toEqual({
      argv: ["bun", "add", "-g", "--no-cache", "tokenhud@latest"],
      env: { BUN_INSTALL: "/home/u/.bun" },
    });
  });

  test("npm: install -g; --prerelease's tag is next", () => {
    expect(packageManagerUpdate(npm, "next", "@tokenhud/darwin-arm64")).toEqual({
      argv: ["npm", "install", "-g", "tokenhud@next"],
      env: {},
    });
  });

  test("a musl binary's package is named too: it is not a dependency of tokenhud", () => {
    expect(packageManagerUpdate(bun, "next", "@tokenhud/linux-arm64-musl")?.argv).toEqual([
      "bun",
      "add",
      "-g",
      "--no-cache",
      "tokenhud@next",
      "@tokenhud/linux-arm64-musl@next",
    ]);
  });

  test("none for what tokenhud leaves to the user, or updates itself", () => {
    for (const method of [
      { kind: "npm", global: false },
      { kind: "npx" },
      { kind: "bunx" },
      { kind: "binary" },
      { kind: "source" },
    ] as const) {
      expect(packageManagerUpdate(method, "latest", null)).toBeNull();
    }
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

const SRC: ReleaseSource = { api: API, overridden: true, insecure: false };

describe("where releases come from", () => {
  test("GitHub by default; an https:// override is used and flagged", () => {
    expect(releaseSource({})).toEqual({
      api: "https://api.github.com/repos/ZhuoQiuMcgill/tokenhud",
      overridden: false,
      insecure: false,
    });
    expect(releaseSource({ TOKENHUD_RELEASES_API: `${API}/` })).toEqual(SRC);
  });

  test("an override that isn't https:// is refused, unless TOKENHUD_INSECURE_TEST=1", () => {
    const local = { TOKENHUD_RELEASES_API: "http://127.0.0.1:8080/api" };
    expect(() => releaseSource(local)).toThrow(
      "TOKENHUD_RELEASES_API must be an https:// URL, not http://127.0.0.1:8080/api",
    );
    expect(() => releaseSource({ TOKENHUD_RELEASES_API: "file:///tmp/x" })).toThrow("https://");
    expect(() => releaseSource({ TOKENHUD_RELEASES_API: "not a url" })).toThrow("not a URL");
    expect(releaseSource({ ...local, TOKENHUD_INSECURE_TEST: "1" })).toEqual({
      api: "http://127.0.0.1:8080/api",
      overridden: true,
      insecure: true,
    });
    expect(() => releaseSource({ ...local, TOKENHUD_INSECURE_TEST: "yes" })).toThrow("https://");
  });
});

describe("newest release", () => {
  test("stable asks GitHub's latest and reads tag, kind and assets", async () => {
    const f = fakeFetch({ [`${API}/releases/latest`]: json(rawRelease("v0.2.0")) });
    const r = (await newestRelease(SRC, false, f.fn)) as Release;
    expect(f.asked).toEqual([`${API}/releases/latest`]);
    expect(r.tag).toBe("v0.2.0");
    expect(r.prerelease).toBe(false);
    expect(r.version).toEqual(v("0.2.0"));
    expect([...r.assets.keys()]).toEqual(["tokenhud-linux-x64", "SHA256SUMS"]);
  });

  test("no stable release yet is null", async () => {
    const f = fakeFetch({});
    expect(await newestRelease(SRC, false, f.fn)).toBeNull();
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
    expect(((await newestRelease(SRC, true, f.fn)) as Release).tag).toBe("v0.1.0-rc.10");
  });

  test("a non-JSON answer is a clear error", async () => {
    const html = fakeFetch({ [`${API}/releases/latest`]: () => new Response("<html>oops</html>") });
    await expect(newestRelease(SRC, false, html.fn)).rejects.toThrow("didn't answer with JSON");
  });

  test("a rate limit and an unreachable host are clear errors", async () => {
    const limited = fakeFetch({
      [`${API}/releases/latest`]: () => new Response("", { status: 403 }),
    });
    await expect(newestRelease(SRC, false, limited.fn)).rejects.toThrow("rate limit");
    const down = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(newestRelease(SRC, false, down)).rejects.toThrow(
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

  test("downloads must be https://, wherever redirects lead, unless insecure for tests", async () => {
    const plain: Release = {
      ...release("v1.0.0"),
      assets: new Map([
        ["tokenhud-linux-x64", "http://dl.example/bin"],
        ["SHA256SUMS", "http://dl.example/sums"],
      ]),
    };
    const f = releaseFetch("v1.0.0", "NEW", sums("NEW"));
    await expect(
      downloadVerified(plain, "tokenhud-linux-x64", join(dir, "n"), f.fn),
    ).rejects.toThrow("a release download must be an https:// URL, not http://dl.example/sums");
    expect(f.asked).toEqual([]);
    const downgraded = (async (url: string) => {
      const res = new Response("x");
      Object.defineProperty(res, "url", { value: String(url).replace("https:", "http:") });
      return res;
    }) as unknown as typeof fetch;
    await expect(
      downloadVerified(release("v1.0.0"), "tokenhud-linux-x64", join(dir, "n"), downgraded),
    ).rejects.toThrow("not http://dl.example/v1.0.0/sums");
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
  function serve(
    tags: Record<string, string>,
    opts: { stable?: string; tamper?: boolean; missingBinary?: boolean } = {},
  ) {
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
        if (b[2] === "bin" && opts.missingBinary) return new Response("", { status: 404 });
        if (b[2] === "bin") return new Response(opts.tamper ? `${body}!` : body);
        return new Response(formatSums(new Map([["tokenhud-linux-x64", sha256(body)]])));
      },
    });
    return server;
  }

  function deps(port: number | undefined, over: Partial<UpdateDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const warnings: string[] = [];
    const exe = join(dir, "bin", "tokenhud");
    mkdirSync(join(dir, "bin"), { recursive: true });
    if (!existsSync(exe)) writeFileSync(exe, "OLD 0.0.9");
    const d: UpdateDeps = {
      env: { TOKENHUD_RELEASES_API: `http://127.0.0.1:${port}/api`, TOKENHUD_INSECURE_TEST: "1" },
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
      copies: () => [],
      out: (line) => out.push(line),
      // The fake GitHub is an override, so every run warns first; tests look at the rest.
      err: (line) => (line.startsWith("WARNING:") ? warnings : err).push(line),
      ...over,
    };
    return { d, out, err, warnings, exe };
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

  test("--check on an npm install asks GitHub, and names what tokenhud update runs", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0" });
    const exe =
      "/usr/local/lib/node_modules/tokenhud/node_modules/@tokenhud/linux-x64/bin/tokenhud";
    const { d, out } = deps(server.port, { execPath: exe, npmPrefix: () => "/usr/local" });
    expect(await runUpdate(["--check"], d)).toBe(0);
    expect(out).toEqual([
      "update available: tokenhud 0.0.9 → 0.1.0",
      "run: tokenhud update  (it runs npm install -g tokenhud@latest)",
    ]);
  });

  test("a binary updated while an older copy comes first on PATH: a warning naming it", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0" });
    const other = { path: "/home/u/.local/bin/tokenhud", method: "binary" as const };
    const { d, out, err, warnings } = deps(server.port, { copies: () => [other] });
    expect(await runUpdate([], d)).toBe(0);
    expect(out.at(-1)).toStartWith("updated tokenhud 0.0.9 → 0.1.0");
    expect(err).toEqual([]);
    expect(warnings.slice(1)).toEqual([
      "WARNING: /home/u/.local/bin/tokenhud (a standalone binary) comes first on PATH, so " +
        "`tokenhud` runs that one, not the copy just updated. If you don't use it, remove it: " +
        "rm /home/u/.local/bin/tokenhud",
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
    const env = { TOKENHUD_RELEASES_API: "http://127.0.0.1:1/api", TOKENHUD_INSECURE_TEST: "1" };
    const { d, err } = deps(1, { env });
    expect(await runUpdate([], d)).toBe(1);
    expect(err[0]).toStartWith("can't reach 127.0.0.1:1");
  });

  test("another release server: a warning naming it, every time", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0" });
    const { d, warnings } = deps(server.port);
    expect(await runUpdate(["--check"], d)).toBe(0);
    expect(warnings).toEqual([
      `WARNING: releases come from http://127.0.0.1:${server.port}/api (TOKENHUD_RELEASES_API), ` +
        "not GitHub. Its SHA256SUMS comes from the same server, so use only a server you trust.",
    ]);
  });

  test("a plain-http release server without TOKENHUD_INSECURE_TEST: refused, nothing asked", async () => {
    let asked = 0;
    const counting = (async () => {
      asked++;
      return new Response("");
    }) as unknown as typeof fetch;
    const env = { TOKENHUD_RELEASES_API: "http://127.0.0.1:1/api" };
    const { d, err, exe } = deps(1, { env, fetch: counting });
    expect(await runUpdate([], d)).toBe(2);
    expect(err).toEqual([
      "TOKENHUD_RELEASES_API must be an https:// URL, not http://127.0.0.1:1/api " +
        "(TOKENHUD_INSECURE_TEST=1 allows http:// for tests)",
    ]);
    expect(asked).toBe(0);
    expect(readFileSync(exe, "utf8")).toBe("OLD 0.0.9");
  });

  test("an asset the release lists but the server doesn't have: its own error", async () => {
    using server = serve({ "v0.1.0": "NEW 0.1.0" }, { stable: "v0.1.0", missingBinary: true });
    const { d, err, exe } = deps(server.port);
    expect(await runUpdate([], d)).toBe(1);
    expect(err[0]).toEndWith("/dl/v0.1.0/bin is not there (HTTP 404)");
    expect(readFileSync(exe, "utf8")).toBe("OLD 0.0.9");
    expect(readdirSync(join(dir, "bin"))).toEqual(["tokenhud"]);
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

describe("tokenhud update on a bun or npm install", () => {
  const windows = process.platform === "win32";
  const noNetwork = (() => {
    throw new Error("no network in this test");
  }) as unknown as typeof fetch;

  /** A bun global install of tokenhud 0.0.9 under `<dir>/<root>`; returns the root and its binary. */
  function bunInstall(root = ".bun", id = "linux-x64") {
    const home = join(dir, root);
    const bin = join(home, "install", "global", "node_modules", "@tokenhud", id, "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, windows ? "tokenhud.exe" : "tokenhud");
    writeFileSync(exe, "tokenhud 0.0.9");
    return { home, exe };
  }

  /**
   * A stub `name` (bun or npm) in `where`: it logs its arguments, BUN_INSTALL and whether
   * `exe` was there while it ran, then "installs" `installs` by writing it to `exe` (as
   * `tokenhud <version>`), and exits `code`.
   */
  function stub(
    name: string,
    exe: string,
    over: { installs?: string | null; code?: number; where?: string } = {},
  ) {
    const where = over.where ?? join(dir, "stubs");
    mkdirSync(where, { recursive: true });
    const log = join(dir, `${name}.log`);
    const installs = over.installs === undefined ? "0.1.0" : over.installs;
    const code = over.code ?? 0;
    if (windows) {
      const lines = [
        "@echo off",
        `>>"${log}" echo %*`,
        `>>"${log}" echo BUN_INSTALL=%BUN_INSTALL%`,
        `if exist "${exe}" (>>"${log}" echo exe present) else (>>"${log}" echo exe absent)`,
        ...(installs === null ? [] : [`>"${exe}" echo tokenhud ${installs}`]),
        `exit /b ${code}`,
      ];
      writeFileSync(join(where, `${name}.cmd`), `${lines.join("\r\n")}\r\n`);
    } else {
      const lines = [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${log}'`,
        `printf 'BUN_INSTALL=%s\\n' "$BUN_INSTALL" >> '${log}'`,
        `if [ -e '${exe}' ]; then echo exe present >> '${log}'; else echo exe absent >> '${log}'; fi`,
        ...(installs === null ? [] : [`printf 'tokenhud ${installs}' > '${exe}'`]),
        `exit ${code}`,
      ];
      writeFileSync(join(where, name), `${lines.join("\n")}\n`);
      chmodSync(join(where, name), 0o755);
    }
    const ran = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== "")
        : [];
    return { dir: where, ran };
  }

  function deps(exe: string, path: string, over: Partial<UpdateDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const env: Record<string, string | undefined> = { ...process.env, PATH: path };
    for (const name of Object.keys(env)) {
      if (/^(path|bun_install|bun_config_registry|npm_config_registry)$/i.test(name)) {
        if (name !== "PATH") delete env[name];
      }
    }
    const d: UpdateDeps = {
      env,
      version: "0.0.9",
      execPath: exe,
      compiled: true,
      platform: process.platform,
      target: "linux-x64",
      fetch: noNetwork,
      npmPrefix: () => null,
      // The stubs write the version the "installed" binary would print.
      versionOf: (bin) => (existsSync(bin) ? readFileSync(bin, "utf8").trim() : "ENOENT"),
      copies: () => [],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...over,
    };
    return { d, out, err };
  }

  test("a bun install: runs bun add -g in that bun install, checks the version, says old → new", async () => {
    const { home, exe } = bunInstall();
    const bun = stub("bun", exe);
    const onPath = { path: join(home, "bin", "tokenhud"), method: "bun" as const };
    const { d, out, err } = deps(exe, bun.dir, { copies: () => [onPath] });
    expect(await runUpdate([], d)).toBe(0);
    expect(bun.ran()).toEqual([
      "add -g --no-cache tokenhud@latest",
      `BUN_INSTALL=${home}`,
      // On Windows it is moved out of the package meanwhile (tested below).
      windows ? "exe absent" : "exe present",
    ]);
    expect(out).toEqual([
      "running: bun add -g --no-cache tokenhud@latest",
      "updated tokenhud 0.0.9 → 0.1.0",
    ]);
    expect(err).toEqual([]);
  });

  test("an npm install with --prerelease: npm install -g tokenhud@next", async () => {
    const prefix = join(dir, "npm");
    const bin = join(
      prefix,
      "lib",
      "node_modules",
      "tokenhud",
      "node_modules",
      "@tokenhud",
      "linux-x64",
      "bin",
    );
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "tokenhud");
    writeFileSync(exe, "tokenhud 0.0.9");
    const npm = stub("npm", exe, { installs: "0.1.0-rc.2" });
    const { d, out } = deps(exe, npm.dir, { npmPrefix: () => prefix });
    expect(await runUpdate(["--prerelease"], d)).toBe(0);
    expect(npm.ran()[0]).toBe("install -g tokenhud@next");
    expect(out).toEqual([
      "running: npm install -g tokenhud@next",
      "updated tokenhud 0.0.9 → 0.1.0-rc.2",
    ]);
  });

  test("a musl binary: its package is updated by name too", async () => {
    const { exe } = bunInstall(".bun", "linux-x64-musl");
    const bun = stub("bun", exe);
    const { d } = deps(exe, bun.dir);
    expect(await runUpdate([], d)).toBe(0);
    expect(bun.ran()[0]).toBe("add -g --no-cache tokenhud@latest @tokenhud/linux-x64-musl@latest");
  });

  test("the same version again: up to date", async () => {
    const { exe } = bunInstall();
    const bun = stub("bun", exe, { installs: "0.0.9" });
    const { d, out } = deps(exe, bun.dir);
    expect(await runUpdate([], d)).toBe(0);
    expect(out.at(-1)).toBe("tokenhud 0.0.9 is up to date");
  });

  test("a package manager that fails: exit 1 with its exit code", async () => {
    const { exe } = bunInstall();
    const bun = stub("bun", exe, { installs: null, code: 3 });
    const { d, out, err } = deps(exe, bun.dir);
    expect(await runUpdate([], d)).toBe(1);
    expect(out).toEqual(["running: bun add -g --no-cache tokenhud@latest"]);
    expect(err).toEqual(["bun add -g --no-cache tokenhud@latest failed (exit 3)"]);
  });

  test("a binary that doesn't say a version afterwards: exit 1, with what it said", async () => {
    const { exe } = bunInstall();
    const bun = stub("bun", exe, { installs: null });
    const { d, err } = deps(exe, bun.dir, { versionOf: () => "exit 127: not found" });
    expect(await runUpdate([], d)).toBe(1);
    expect(err).toEqual([
      `bun add -g --no-cache tokenhud@latest finished, but ${exe} --version said: exit 127: not found`,
    ]);
  });

  test("bun not on PATH: the bun of that install runs; with neither, nothing runs", async () => {
    const { home, exe } = bunInstall();
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const none = deps(exe, empty);
    expect(await runUpdate([], none.d)).toBe(1);
    expect(none.err).toEqual([
      "couldn't run bun add -g --no-cache tokenhud@latest: bun is not on PATH",
    ]);
    const own = stub(windows ? "bun.exe" : "bun", exe, { where: join(home, "bin") });
    if (windows) return; // A .cmd can't stand in for bun.exe; the lookup is the same.
    const { d, out } = deps(exe, empty);
    expect(await runUpdate([], d)).toBe(0);
    expect(own.ran()[0]).toBe("add -g --no-cache tokenhud@latest");
    expect(out.at(-1)).toBe("updated tokenhud 0.0.9 → 0.1.0");
  });

  test("a real bun or npm is never run from a test: refused before it starts", async () => {
    const { exe } = bunInstall();
    // The real bun: Bun's own directory. The registry is local in name only, so a broken
    // refusal still couldn't reach npm's.
    const { d, err } = deps(exe, join(process.execPath, ".."), {
      env: {
        PATH: join(process.execPath, ".."),
        BUN_CONFIG_REGISTRY: "http://[::1]:9/",
        npm_config_registry: "http://[::1]:9/",
      },
    });
    expect(await runUpdate([], d)).toBe(1);
    expect(err[0]).toContain("refused to run bun");
    expect(takeSpawned()).toEqual([expect.stringMatching(/^bun(\.exe)? \(refused\)$/)]);
    expect(readFileSync(exe, "utf8")).toBe("tokenhud 0.0.9");
  });

  test("Windows: the running .exe is moved out of the package meanwhile, and deleted after", async () => {
    const { home, exe } = bunInstall();
    const bun = stub("bun", exe);
    const { d, out } = deps(exe, bun.dir, { platform: "win32" });
    expect(await runUpdate([], d)).toBe(0);
    expect(bun.ran()[2]).toBe("exe absent");
    expect(out.at(-1)).toBe("updated tokenhud 0.0.9 → 0.1.0");
    expect(readFileSync(exe, "utf8").trim()).toBe("tokenhud 0.1.0");
    // Not running here, so it is deleted at once; a running one waits for the next start.
    expect(readdirSync(join(home, "install", "global"))).toEqual(["node_modules"]);
  });

  test("Windows: put back when the package manager fails without replacing it", async () => {
    const { home, exe } = bunInstall();
    const bun = stub("bun", exe, { installs: null, code: 1 });
    const { d } = deps(exe, bun.dir, { platform: "win32" });
    expect(await runUpdate([], d)).toBe(1);
    expect(bun.ran()[2]).toBe("exe absent");
    expect(readFileSync(exe, "utf8")).toBe("tokenhud 0.0.9");
    expect(readdirSync(join(home, "install", "global"))).toEqual(["node_modules"]);
  });

  test("a parked .exe left by a running copy is deleted by the next start", () => {
    const { home, exe } = bunInstall();
    const parked = parkingPath(exe, 4242) as string;
    expect(parked).toBe(join(home, "install", "global", "tokenhud-update-4242.old"));
    writeFileSync(parked, "old");
    writeFileSync(join(home, "install", "global", "package.json"), "{}");
    removeStaleOld(exe);
    expect(readdirSync(join(home, "install", "global")).sort()).toEqual([
      "node_modules",
      "package.json",
    ]);
    expect(parkingPath("/home/u/.local/bin/tokenhud")).toBeNull();
  });

  test("after updating: a warning when another copy comes first on PATH, or none does", async () => {
    const { home, exe } = bunInstall();
    const bun = stub("bun", exe);
    const curl = { path: join(dir, "local", "tokenhud"), method: "binary" as const };
    const shadowed = deps(exe, bun.dir, { copies: () => [curl] });
    expect(await runUpdate([], shadowed.d)).toBe(0);
    expect(shadowed.err).toEqual([
      `WARNING: ${curl.path} (a standalone binary) comes first on PATH, so ` +
        "`tokenhud` runs that one, not the copy just updated. If you don't use it, remove it: " +
        (windows ? `del "${curl.path}"` : `rm ${curl.path}`),
    ]);
    const missing = deps(exe, bun.dir);
    expect(await runUpdate([], missing.d)).toBe(0);
    expect(missing.err).toEqual([
      `WARNING: ${join(home, "bin")} is not on PATH, so the tokenhud command isn't found: ` +
        "add it to PATH (bun's installer does)",
    ]);
    const own = { path: join(home, "bin", "tokenhud"), method: "bun" as const };
    const first = deps(exe, bun.dir, { copies: () => [own, curl] });
    expect(await runUpdate([], first.d)).toBe(0);
    expect(first.err).toEqual([]);
  });

  test("--print prints the command, and runs and asks nothing", async () => {
    const { exe: bunExe } = bunInstall();
    const bun = stub("bun", bunExe);
    const cases: Array<[string, string[], Partial<UpdateDeps>, string]> = [
      [bunExe, [], {}, "bun add -g --no-cache tokenhud@latest"],
      [bunExe, ["--prerelease"], {}, "bun add -g --no-cache tokenhud@next"],
      [
        "/usr/lib/node_modules/tokenhud/node_modules/@tokenhud/linux-x64/bin/tokenhud",
        [],
        { npmPrefix: () => "/usr" },
        "npm install -g tokenhud@latest",
      ],
      [
        "/home/u/app/node_modules/@tokenhud/linux-x64/bin/tokenhud",
        ["--prerelease"],
        { npmPrefix: () => "/usr" },
        "npm install tokenhud@next",
      ],
      [
        "/home/u/.npm/_npx/1/node_modules/@tokenhud/linux-x64/bin/tokenhud",
        [],
        {},
        "npx tokenhud@latest",
      ],
      [
        "/tmp/bunx-1000-tokenhud@latest/node_modules/@tokenhud/linux-x64/bin/tokenhud",
        [],
        {},
        "bunx tokenhud@latest",
      ],
      ["/home/u/.local/bin/tokenhud", ["--prerelease"], {}, "tokenhud update --prerelease"],
    ];
    for (const [exe, args, over, printed] of cases) {
      const { d, out, err } = deps(exe, bun.dir, over);
      expect([exe, await runUpdate(["--print", ...args], d), out, err]).toEqual([
        exe,
        0,
        [printed],
        [],
      ]);
    }
    expect(bun.ran()).toEqual([]);
  });
});
