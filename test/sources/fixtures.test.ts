// The repo is public: T4's fixtures and tests may hold only made-up identifiers. Every
// uuid must be one of the generators' fakes, and every request or message id must say FAKE.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FAKE_UUID = /^00000000-0000-4000-8000-0000000000\d\d$/;
const API_ID = /(?:req|msg)_[0-9A-Za-z]+/g;

const test_ = join(import.meta.dir, "..");
const dirs = ["fixtures/sources", "fixtures/config", "sources", "ingest", "commands"].map((d) =>
  join(test_, d),
);
const files = [
  ...dirs.flatMap((dir) => readdirSync(dir).map((name) => join(dir, name))),
  join(test_, "config.test.ts"),
];

test.each(files.map((f) => [f.slice(f.lastIndexOf("test")), f]))(
  "%s has only fake ids",
  (_name, file) => {
    let text = readFileSync(file).toString("latin1");
    // The Claude cases are stored base64-encoded; check the decoded transcripts too.
    if (file.endsWith("claude-cases.json")) {
      const cases = JSON.parse(text) as { files: Record<string, string> };
      text += Object.values(cases.files)
        .map((b64) => Buffer.from(b64, "base64").toString("latin1"))
        .join("\n");
    }
    for (const id of text.match(UUID) ?? []) expect(id).toMatch(FAKE_UUID);
    for (const id of text.match(API_ID) ?? []) expect(id).toContain("FAKE");
  },
);
