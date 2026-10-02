// A stand-in for a GitHub release on localhost: the download URLs install.sh and install.ps1
// use, and the REST API `tokenhud update` reads, laid out as github.com and api.github.com
// lay them out. Assets come from a directory (release binaries and SHA256SUMS).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface FakeGitHub {
  /** For TOKENHUD_DOWNLOAD_BASE (github.com/<repo>/releases). */
  readonly downloads: string;
  /** For TOKENHUD_RELEASES_API (api.github.com/repos/<repo>). */
  readonly api: string;
  stop(): void;
}

export interface FakeRelease {
  readonly dir: string;
  readonly tag: string;
  /** Serve every binary with a byte changed, so checksums fail. */
  readonly tamper?: boolean;
}

export function fakeGitHub(release: FakeRelease, hostname = "127.0.0.1"): FakeGitHub {
  const prerelease = release.tag.includes("-");
  const names = readdirSync(release.dir).filter((name) => !name.startsWith("."));
  const server = Bun.serve({
    hostname,
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const origin: string = `http://${hostname}:${server.port}`;
      const download = (name: string): string =>
        `${origin}/releases/download/${release.tag}/${name}`;
      const meta: object = {
        tag_name: release.tag,
        draft: false,
        prerelease,
        assets: names.map((name) => ({ name, browser_download_url: download(name) })),
      };
      const path = url.pathname;
      if (path === "/api/releases/latest") {
        return prerelease
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json(meta);
      }
      if (path === "/api/releases") return Response.json([meta]);
      const latest = /^\/releases\/latest\/download\/([^/]+)$/.exec(path);
      if (latest !== null) {
        // GitHub redirects to the newest stable release's asset, and has none to give while
        // only prereleases exist.
        if (prerelease) return new Response("Not Found", { status: 404 });
        return Response.redirect(download(latest[1] as string), 302);
      }
      const asset = /^\/releases\/download\/([^/]+)\/([^/]+)$/.exec(path);
      if (asset === null || asset[1] !== release.tag || !names.includes(asset[2] as string)) {
        return new Response("Not Found", { status: 404 });
      }
      const file = join(release.dir, asset[2] as string);
      if (!existsSync(file)) return new Response("Not Found", { status: 404 });
      if (release.tamper && asset[2] !== "SHA256SUMS") {
        const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
        return new Response(bytes);
      }
      return new Response(Bun.file(file), {
        headers: { "content-type": "application/octet-stream" },
      });
    },
  });
  const origin = `http://${hostname}:${server.port}`;
  return {
    downloads: `${origin}/releases`,
    api: `${origin}/api`,
    stop: () => server.stop(true),
  };
}
