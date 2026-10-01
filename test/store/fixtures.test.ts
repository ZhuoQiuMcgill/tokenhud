// The repo is public: fixtures and test sources may hold only made-up identifiers, never
// one taken from this or any machine's transcripts. Every uuid must be one of the fakes
// the generators use, and every request or message id must say FAKE.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import expected from "../fixtures/store/cc-usage-ledger.expected.json";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FAKE_UUID = /^00000000-0000-4000-8000-0000000000\d\d$/;
const API_ID = /(?:req|msg)_[0-9A-Za-z]+/g;

const dirs = [join(import.meta.dir, "..", "fixtures", "store"), import.meta.dir];
const files = dirs.flatMap((dir) => readdirSync(dir).map((name) => join(dir, name)));

describe("no real identifiers", () => {
  test.each(files.map((f) => [f.slice(f.lastIndexOf("test")), f]))("%s", (_name, file) => {
    // latin1 keeps every byte, so ids inside the binary SQLite fixture are found too.
    const text = readFileSync(file).toString("latin1");
    for (const id of text.match(UUID) ?? []) expect(id).toMatch(FAKE_UUID);
    for (const id of text.match(API_ID) ?? []) expect(id).toContain("FAKE");
  });

  test("the fixture ledger's lineage is a fixed fake", () => {
    expect(expected.lineage).toBe("00000000000040008000000000000001");
  });
});
