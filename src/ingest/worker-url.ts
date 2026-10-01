// Where to start a Worker from, given its entry file's path relative to src/.
//
// From source it resolves against src/, this file's parent directory. In a compiled binary every
// entrypoint is embedded under the bundle root (`/$bunfs/root/` on POSIX, `B:/~BUN/root/`
// on Windows) by its path relative to src/, while `import.meta.url` names the entry chunk
// this code was bundled into (the CLI, or the ingest Worker), so a path relative to it
// would point at the wrong directory. scripts/build.ts lists the Worker entrypoints.
const BUNDLE_ROOT = /^(.*?[/\\](?:\$bunfs|~BUN)[/\\]root[/\\])/;

/** `base` is this module's URL; tests pass a compiled binary's. */
export function workerUrl(fromSrc: string, base: string = import.meta.url): string {
  const bundled = BUNDLE_ROOT.exec(base);
  if (bundled !== null) return `${bundled[1]}${fromSrc}`;
  return new URL(`../${fromSrc}`, base).href;
}
