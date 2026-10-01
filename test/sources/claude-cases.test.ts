// cc-usage's own parser on synthetic transcripts (test/fixtures/sources/gen_claude_cases.py)
// against tokenhud's ingest of the same bytes: every record cc-usage keeps must be stored
// with the same key, timestamp, raw model and counts.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ledgerKey } from "../../src/store/key.ts";
import { storedText } from "../../src/store/store.ts";
import cases from "../fixtures/sources/claude-cases.json";
import { cleanup, openEngine, storedRows, tempDir } from "../ingest/helpers.ts";

afterEach(cleanup);

const isCount = (v: number) => Number.isSafeInteger(v) && v >= 0;

function materialize(): string {
  const root = join(tempDir(), "root");
  for (const [name, b64] of Object.entries(cases.files)) {
    const path = join(root, "projects", ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(b64, "base64"));
  }
  return root;
}

const storable = cases.records.filter(
  (r) =>
    isCount(r.ts) &&
    [r.inp, r.outp, r.cr, r.cc].every(isCount) &&
    (r.e5 === null || isCount(r.e5)) &&
    (r.e1 === null || isCount(r.e1)),
);

test("the fixture exercises what it should", () => {
  expect(cases.records.length).toBe(39);
  // -5 input, 2^53 + 1 input, a timestamp before 1970
  expect(cases.records.length - storable.length).toBe(3);
  expect(cases.unkeyed).toBe(1);
  expect(cases.malformed).toBe(1);
});

test("every record cc-usage keeps is stored identically", async () => {
  const engine = openEngine([materialize()]);
  const report = await engine.fullPass();
  const rows = storedRows(engine.store);
  expect(rows.size).toBe(storable.length);
  for (const want of storable) {
    const got = rows.get(BigInt(want.key));
    expect(got).toBeDefined();
    expect({
      ts: got?.ts,
      model: got?.model,
      inp: got?.inp,
      outp: got?.outp,
      cr: got?.cr,
      cc: got?.cc,
      e5: got?.e5,
      e1: got?.e1,
    }).toEqual({
      ts: want.ts,
      model: storedText(want.model),
      inp: want.inp,
      outp: want.outp,
      cr: want.cr,
      cc: want.cc,
      e5: want.e5,
      e1: want.e1,
    });
  }
  const stats = report?.roots[0];
  expect(stats?.unkeyed).toBe(cases.unkeyed);
  expect(stats?.malformed).toBe(cases.malformed);
  expect(stats?.unstorable).toBe(cases.records.length - storable.length);
});

test("fast mode is tier 1, everything else tier 0", async () => {
  const engine = openEngine([materialize()]);
  await engine.fullPass();
  const fast = ledgerKey("c\x1freq_FAKE13\x1fmsg_FAKE13");
  for (const [key, row] of storedRows(engine.store)) expect(row.tier).toBe(key === fast ? 1 : 0);
});

test("a second pass over unchanged files reads nothing and changes nothing", async () => {
  const engine = openEngine([materialize()]);
  await engine.fullPass();
  const before = storedRows(engine.store);
  const again = await engine.fullPass();
  expect(again?.roots[0]?.read).toBe(0);
  expect(again?.event).toBeNull();
  expect(storedRows(engine.store)).toEqual(before);
});
