// Where to start a Worker from, given its entry file's path relative to src/.
//
// A compiled binary embeds every entrypoint (scripts/build.ts lists them) under its bundle
// root, by its path relative to src/: `/$bunfs/root/` on POSIX, `B:/~BUN/root/` on Windows.
// Whether this is a compiled binary is read from `Bun.main`, a path that is inside the
// bundle in every thread (the CLI's entry, or a Worker's own), and the root is Bun's fixed
// one, so the answer doesn't depend on which chunk this code was bundled into.
//
// `import.meta.url` can't tell: it names the chunk, and on Windows it spells the root
// `file:///B:/%7EBUN/root/` (seen on CI, T31), which a match on `~BUN` missed, so 0.1.4
// resolved `../tui/vm/worker.ts` against the chunk and asked for `B:\~BUN\tui\vm\worker.ts`.
// The match below takes either spelling, as a path or a file URL.
const BUNDLE = /^(?:file:\/\/)?(?:(\/\$bunfs[/\\])|\/?([A-Za-z]):[/\\](?:~|%7E)BUN[/\\])/i;

/** The bundle root of a compiled binary, from any path or URL inside it; null elsewhere. */
export function bundleRoot(inside: string): string | null {
  const match = BUNDLE.exec(inside);
  if (match === null) return null;
  return match[1] !== undefined ? "/$bunfs/root/" : `${match[2]}:/~BUN/root/`;
}

/**
 * `main` is the running entry's path (`Bun.main`), `base` this module's URL; tests pass a
 * compiled binary's. From source the entry resolves against src/, this file's parent.
 */
export function workerUrl(
  fromSrc: string,
  main: string = Bun.main,
  base: string = import.meta.url,
): string {
  const root = bundleRoot(main);
  if (root !== null) return `${root}${fromSrc}`;
  return new URL(`../${fromSrc}`, base).href;
}
