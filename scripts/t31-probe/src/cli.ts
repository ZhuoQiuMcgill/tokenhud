// Temporary T31 probe: what a compiled binary's modules see, and which Worker specifiers start.
const info = (where: string) =>
  console.log(
    JSON.stringify({
      where,
      url: import.meta.url,
      path: import.meta.path,
      dir: import.meta.dir,
      main: Bun.main,
      execPath: process.execPath.replace(/^.*[/\\]/, "<dir>/"),
    }),
  );
info("entry");
const { probe } = await import("./ingest/probe.ts");
const ok = await probe("main thread");
process.exit(ok ? 0 : 1);
