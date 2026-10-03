// A stand-in for the npm registry on localhost: package documents and tarballs laid out as
// registry.npmjs.org serves them, so `bun add -g` and `npm install -g` resolve dist-tags and
// choose optional dependencies by `os`, `cpu` and `libc` exactly as they would against npm.
// It takes `npm publish` and `npm dist-tag add` as the registry does, for
// scripts/publish-npm.ts.
//
// A package can be listed without a tarball (a platform not built here): its document
// says where it runs, so a package manager can skip it, and a request for its tarball is a
// 404. `tarballs` records every tarball asked for, which shows what was installed. A
// `fault` makes a tarball 404, or come back stale, for its first requests: what npm's CDN
// did for about 10 minutes after v0.1.0 was published.
import { readFileSync } from "node:fs";

export interface FakeNpmPackage {
  /** Its package.json, as published. */
  readonly manifest: { readonly name: string; readonly version: string } & Record<string, unknown>;
  /** The .tgz (`bun pm pack`), or undefined to list the package without serving it. */
  readonly tarball?: string;
}

export type TarballFault = "missing" | "corrupt";

export interface FakeNpmOptions {
  /** The token `npm publish` and `npm dist-tag` must send. Without one, writes are refused. */
  readonly token?: string;
  /**
   * What the `nth` request (from 1) for the tarball of `id` (`name@version`) gets instead of
   * it: a 404, or bytes that don't match the integrity its document gives.
   */
  readonly fault?: (id: string, nth: number) => TarballFault | undefined;
}

export interface FakeNpm {
  /** For BUN_CONFIG_REGISTRY and npm_config_registry. */
  readonly url: string;
  /** Every tarball asked for, as `name@version`, in order. */
  readonly tarballs: readonly string[];
  /**
   * Writes and tarball answers, in order: `publish name@version`, `dist-tag name tag=version`,
   * and `tarball name@version 200` (or `404`, or `corrupt`).
   */
  readonly events: readonly string[];
  /** A package's dist-tags as they are now. */
  tags(name: string): Readonly<Record<string, string>>;
  stop(): void;
}

/** The registry's tarball path for a version: `/@scope/name/-/name-1.0.0.tgz`. */
const tarballPath = (name: string, version: string) =>
  `/${name}/-/${name.replace(/^@[^/]+\//, "")}-${version}.tgz`;

/** The scripts npm runs at install: the registry marks a version with one `hasInstallScript`. */
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

interface Version {
  readonly manifest: Record<string, unknown>;
  /** undefined: listed, not served. */
  readonly bytes: Uint8Array | undefined;
}

const sha512 = (bytes: Uint8Array) =>
  `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

/**
 * Serves `packages`; `tags` sets a name's dist-tags (by default `latest` is its highest
 * version).
 */
export function fakeNpm(
  packages: readonly FakeNpmPackage[],
  tags: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  options: FakeNpmOptions = {},
): FakeNpm {
  const tarballs: string[] = [];
  const events: string[] = [];
  const store = new Map<string, Map<string, Version>>();
  const distTags = new Map<string, Record<string, string>>();
  const files = new Map<string, { name: string; version: string }>();
  const requests = new Map<string, number>();
  let origin = "";

  const add = (name: string, version: string, entry: Version) => {
    const versions = store.get(name) ?? new Map<string, Version>();
    versions.set(version, entry);
    store.set(name, versions);
    files.set(tarballPath(name, version), { name, version });
  };
  for (const { manifest, tarball } of packages) {
    add(manifest.name, manifest.version, {
      manifest,
      bytes: tarball === undefined ? undefined : new Uint8Array(readFileSync(tarball)),
    });
  }
  for (const [name, versions] of store) {
    const highest = [...versions.keys()].reduce((a, b) => (Bun.semver.order(a, b) >= 0 ? a : b));
    distTags.set(name, { ...(tags[name] ?? { latest: highest }) });
  }

  const document = (name: string) => {
    const versions = store.get(name);
    if (versions === undefined) return undefined;
    const entries: Record<string, unknown> = {};
    for (const [version, { manifest, bytes }] of versions) {
      const data = bytes ?? new Uint8Array(0);
      const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
      entries[version] = {
        ...manifest,
        _id: `${name}@${version}`,
        ...(INSTALL_SCRIPTS.some((s) => s in scripts) ? { hasInstallScript: true } : {}),
        dist: {
          tarball: `${origin}${tarballPath(name, version)}`,
          integrity: sha512(data),
          shasum: new Bun.CryptoHasher("sha1").update(data).digest("hex"),
        },
      };
    }
    return { name, "dist-tags": distTags.get(name), versions: entries };
  };

  const tarball = (path: string): Response | undefined => {
    const file = files.get(path);
    if (file === undefined) return undefined;
    const id = `${file.name}@${file.version}`;
    tarballs.push(id);
    const nth = (requests.get(id) ?? 0) + 1;
    requests.set(id, nth);
    const bytes = store.get(file.name)?.get(file.version)?.bytes;
    const fault = bytes === undefined ? "missing" : options.fault?.(id, nth);
    events.push(`tarball ${id} ${fault === undefined ? 200 : fault === "missing" ? 404 : fault}`);
    if (bytes === undefined || fault === "missing") {
      return new Response("Not Found", { status: 404 });
    }
    const body = fault === "corrupt" ? new Uint8Array([...bytes, 0]) : bytes;
    return new Response(body, { headers: { "content-type": "application/octet-stream" } });
  };

  /** `npm publish`: the version's manifest, its tarball as an attachment, and dist-tags. */
  const publish = async (name: string, req: Request): Promise<Response> => {
    const body = (await req.json()) as {
      versions?: Record<string, Record<string, unknown>>;
      "dist-tags"?: Record<string, string>;
      _attachments?: Record<string, { data: string }>;
    };
    const [version, manifest] = Object.entries(body.versions ?? {})[0] ?? [];
    const attachment = Object.values(body._attachments ?? {})[0];
    if (version === undefined || manifest === undefined || attachment === undefined) {
      return Response.json({ error: "bad publish" }, { status: 400 });
    }
    if (store.get(name)?.has(version)) {
      return Response.json(
        { error: `You cannot publish over the previously published versions: ${version}.` },
        { status: 403 },
      );
    }
    const { dist: _, ...rest } = manifest;
    add(name, version, {
      manifest: rest,
      bytes: new Uint8Array(Buffer.from(attachment.data, "base64")),
    });
    distTags.set(name, { ...distTags.get(name), ...body["dist-tags"] });
    events.push(`publish ${name}@${version}`);
    return Response.json({ ok: true }, { status: 201 });
  };

  /** `npm dist-tag add`: the version, as a JSON string. */
  const setTag = async (name: string, tag: string, req: Request): Promise<Response> => {
    const version = (await req.json()) as string;
    if (!store.get(name)?.has(version)) return notFound();
    distTags.set(name, { ...distTags.get(name), [tag]: version });
    events.push(`dist-tag ${name} ${tag}=${version}`);
    return Response.json({ ok: true }, { status: 201 });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const tagPath = /^\/-\/package\/(.+)\/dist-tags(?:\/([^/]+))?$/.exec(path);
      if (req.method !== "GET") {
        const auth = req.headers.get("authorization");
        if (options.token === undefined || auth !== `Bearer ${options.token}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (req.method !== "PUT") return notFound();
        if (tagPath?.[2] !== undefined) return setTag(tagPath[1] as string, tagPath[2], req);
        return path.includes("/-/") ? notFound() : publish(path.slice(1), req);
      }
      if (tagPath !== null && tagPath[2] === undefined) {
        const found = distTags.get(tagPath[1] as string);
        return found === undefined ? notFound() : Response.json(found);
      }
      const served = tarball(path);
      if (served !== undefined) return served;
      const doc = document(path.slice(1));
      return doc === undefined ? notFound() : Response.json(doc);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    url: `${origin}/`,
    tarballs,
    events,
    tags: (name) => ({ ...distTags.get(name) }),
    stop: () => server.stop(true),
  };
}
