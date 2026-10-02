// A stand-in for the npm registry on localhost: package documents and tarballs laid out as
// registry.npmjs.org serves them, so `bun add -g` and `npm install -g` resolve dist-tags and
// choose optional dependencies by `os`, `cpu` and `libc` exactly as they would against npm.
//
// A package can be listed without a tarball (a platform not built here): its document
// says where it runs, so a package manager can skip it, and a request for its tarball is a
// 404. `tarballs` records every tarball asked for, which shows what was installed.
import { readFileSync } from "node:fs";

export interface FakeNpmPackage {
  /** Its package.json, as published. */
  readonly manifest: { readonly name: string; readonly version: string } & Record<string, unknown>;
  /** The .tgz (`bun pm pack`), or undefined to list the package without serving it. */
  readonly tarball?: string;
}

export interface FakeNpm {
  /** For BUN_CONFIG_REGISTRY and npm_config_registry. */
  readonly url: string;
  /** Every tarball asked for, as `name@version`, in order. */
  readonly tarballs: readonly string[];
  stop(): void;
}

/** The registry's tarball path for a version: `/@scope/name/-/name-1.0.0.tgz`. */
const tarballPath = (name: string, version: string) =>
  `/${name}/-/${name.replace(/^@[^/]+\//, "")}-${version}.tgz`;

/**
 * Serves `packages`; `tags` sets a name's dist-tags (by default `latest` is its highest
 * version).
 */
export function fakeNpm(
  packages: readonly FakeNpmPackage[],
  tags: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): FakeNpm {
  const tarballs: string[] = [];
  const files = new Map<string, { id: string; file: string | undefined }>();
  const documents = new Map<string, Record<string, unknown>>();
  let origin = "";
  const build = () => {
    const byName = new Map<string, FakeNpmPackage[]>();
    for (const p of packages)
      byName.set(p.manifest.name, [...(byName.get(p.manifest.name) ?? []), p]);
    for (const [name, versions] of byName) {
      const entries: Record<string, unknown> = {};
      for (const { manifest, tarball } of versions) {
        const bytes = tarball === undefined ? new Uint8Array(0) : readFileSync(tarball);
        const path = tarballPath(name, manifest.version);
        files.set(path, { id: `${name}@${manifest.version}`, file: tarball });
        entries[manifest.version] = {
          ...manifest,
          _id: `${name}@${manifest.version}`,
          dist: {
            tarball: `${origin}${path}`,
            integrity: `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`,
            shasum: new Bun.CryptoHasher("sha1").update(bytes).digest("hex"),
          },
        };
      }
      const highest = versions
        .map((v) => v.manifest.version)
        .reduce((a, b) => (Bun.semver.order(a, b) >= 0 ? a : b));
      documents.set(name, {
        name,
        "dist-tags": tags[name] ?? { latest: highest },
        versions: entries,
      });
    }
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const tarball = files.get(path);
      if (tarball !== undefined) {
        tarballs.push(tarball.id);
        return tarball.file === undefined
          ? new Response("Not Found", { status: 404 })
          : new Response(Bun.file(tarball.file), {
              headers: { "content-type": "application/octet-stream" },
            });
      }
      const document = documents.get(path.slice(1));
      return document === undefined
        ? Response.json({ error: "Not found" }, { status: 404 })
        : Response.json(document);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  build();
  return { url: `${origin}/`, tarballs, stop: () => server.stop(true) };
}
