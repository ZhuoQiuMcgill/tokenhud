// Labels derived from a directory name name a new account but never rename one; only an
// explicit (configured, or imported) label renames, as cc-usage's ledger does.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore, type Store } from "../../src/store/store.ts";
import { guard } from "../guard.ts";
import { cleanup, row, tempDir, track } from "./helpers.ts";

guard();

afterEach(cleanup);

function store(): Store {
  return track(openStore(join(tempDir(), "tokenhud.db")));
}

const labels = (s: Store) => [...s.accounts().values()].map((a) => a.label);

test("a derived label names a new account", () => {
  const s = store();
  s.upsert([row(1n, { label: "claude-win", derivedLabel: true })]);
  expect(labels(s)).toEqual(["claude-win"]);
});

test("a derived label never renames an existing account", () => {
  const s = store();
  s.upsert([row(1n, { label: "win" })]);
  s.upsert([row(2n, { label: "claude-win", derivedLabel: true })]);
  expect(labels(s)).toEqual(["win"]);
  expect(s.rows([2n])).toHaveLength(1);
});

test("an explicit label renames, as before", () => {
  const s = store();
  s.upsert([row(1n, { label: "claude-win", derivedLabel: true })]);
  s.upsert([row(2n, { label: "work" })]);
  s.upsert([row(3n, { label: "work-2", derivedLabel: false })]);
  expect(labels(s)).toEqual(["work-2"]);
});

test("within one batch an explicit label wins over a derived one, in either order", () => {
  const a = store();
  a.upsert([row(1n, { label: "mine" }), row(2n, { label: "derived", derivedLabel: true })]);
  expect(labels(a)).toEqual(["mine"]);
  const b = store();
  b.upsert([row(1n, { label: "derived", derivedLabel: true }), row(2n, { label: "mine" })]);
  expect(labels(b)).toEqual(["mine"]);
});
