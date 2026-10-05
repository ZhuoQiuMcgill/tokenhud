// Where Workers start from (T31): from source, the files under src/; in a compiled binary,
// the entrypoints under Bun's bundle root, whatever chunk or thread asks and however the
// path is spelled. The compiled paths are the ones CI's runners printed (docs/notes/T31).
import { describe, expect, test } from "bun:test";
import { bundleRoot, workerUrl } from "../../src/ingest/worker-url.ts";
import { guard } from "../guard.ts";

guard();

describe("workerUrl", () => {
  test("from source: the file under src/", () => {
    expect(workerUrl("ingest/parse-worker.ts")).toBe(
      new URL("../../src/ingest/parse-worker.ts", import.meta.url).href,
    );
    expect(workerUrl("tui/vm/worker.ts", "/home/u/tokenhud/src/cli.ts")).toBe(
      new URL("../../src/tui/vm/worker.ts", import.meta.url).href,
    );
    expect(
      workerUrl(
        "ingest/parse-worker.ts",
        "C:\\src\\tokenhud\\src\\cli.ts",
        "file:///C:/t/src/ingest/x.ts",
      ),
    ).toBe("file:///C:/t/src/ingest/parse-worker.ts");
  });

  test("POSIX binary: under /$bunfs/root/, from the CLI's entry or a Worker's", () => {
    for (const main of ["/$bunfs/root/tokenhud", "/$bunfs/root/ingest/worker.js"]) {
      expect(workerUrl("ingest/parse-worker.ts", main)).toBe("/$bunfs/root/ingest/parse-worker.ts");
    }
  });

  test("Windows binary: under B:/~BUN/root/, from the CLI's entry or a Worker's", () => {
    for (const main of ["B:/~BUN/root/tokenhud", "B:/~BUN/root/tui/vm/worker.js"]) {
      expect(workerUrl("tui/vm/worker.ts", main)).toBe("B:/~BUN/root/tui/vm/worker.ts");
    }
  });

  test("the bundle is told by the entry, not by this module's chunk", () => {
    // 0.1.4 on Windows: the chunk's URL spells `~` as %7E, and missing it climbed out of root/.
    const chunk = "file:///B:/%7EBUN/root/chunk-0000aaaa.js";
    expect(workerUrl("tui/vm/worker.ts", "B:/~BUN/root/tokenhud", chunk)).toBe(
      "B:/~BUN/root/tui/vm/worker.ts",
    );
    expect(
      workerUrl("ingest/worker.ts", "/$bunfs/root/tokenhud", "file:///$bunfs/root/chunk-1.js"),
    ).toBe("/$bunfs/root/ingest/worker.ts");
  });
});

describe("bundleRoot", () => {
  test("POSIX: any path or file URL under /$bunfs/, chunks and entries alike", () => {
    for (const inside of [
      "/$bunfs/root/tokenhud",
      "/$bunfs/root/chunk-3q6j577j.js",
      "/$bunfs/root/ingest/worker.js",
      "file:///$bunfs/root/tokenhud",
      "file:///$bunfs/root/chunk-3q6j577j.js",
      "/$bunfs/chunk-3q6j577j.js",
    ]) {
      expect(bundleRoot(inside)).toBe("/$bunfs/root/");
    }
  });

  test("Windows: forward or back slashes, `~` or %7E, path or file URL, with or without root", () => {
    for (const inside of [
      "B:/~BUN/root/tokenhud",
      "B:\\~BUN\\root\\chunk-j23zvdjf.js",
      "B:\\~BUN\\root\\ingest\\worker.js",
      "file:///B:/~BUN/root/tokenhud.exe",
      "file:///B:/~BUN/root/chunk-j23zvdjf.js",
      "file:///B:/%7EBUN/root/chunk-j23zvdjf.js",
      "file:///B:/%7eBUN/root/tui/vm/worker.js",
      "B:\\~BUN\\chunk-j23zvdjf.js",
      "file:///B:/%7EBUN/chunk-j23zvdjf.js",
    ]) {
      expect(bundleRoot(inside)).toBe("B:/~BUN/root/");
    }
  });

  test("anything else is not a compiled binary", () => {
    for (const outside of [
      "/home/u/tokenhud/src/cli.ts",
      "file:///home/u/tokenhud/src/ingest/worker-url.ts",
      "C:\\Users\\u\\tokenhud\\src\\cli.ts",
      "file:///C:/Users/u/tokenhud/src/cli.ts",
      "/home/u/$bunfs/root/cli.ts",
      "C:\\x\\~BUN\\root\\cli.ts",
      "",
    ]) {
      expect(bundleRoot(outside)).toBeNull();
    }
  });
});
