// Damaging a store file on purpose, for the backup and recovery tests. The usage table's
// B-tree is walked from the file's bytes (SQLite's documented page format), so a test can
// scribble over exactly one of its leaf pages and know which keys sat on it.
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";

const INTERIOR_TABLE = 0x05;
const LEAF_TABLE = 0x0d;

/** A SQLite varint at `at`: its value and length. */
function varint(buf: Buffer, at: number): [bigint, number] {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = buf[at + i] as number;
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, i + 1];
  }
  return [(value << 8n) | BigInt(buf[at + 8] as number), 9];
}

const signed = (v: bigint) => (v >= 2n ** 63n ? v - 2n ** 64n : v);

export interface UsagePages {
  pageSize: number;
  root: number;
  /** Leaf page number -> the keys (rowids) stored on it. */
  leaves: Map<number, bigint[]>;
}

/** The usage table's leaf pages and their keys. The store must be closed (WAL checkpointed). */
export function usagePages(path: string): UsagePages {
  const db = new Database(path, { readonly: true });
  let root: number;
  try {
    root = Number(
      db
        .query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name = 'usage'")
        .get()?.rootpage,
    );
  } finally {
    db.close();
  }
  const buf = readFileSync(path);
  const raw = buf.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  const leaves = new Map<number, bigint[]>();
  const visit = (page: number): void => {
    const start = (page - 1) * pageSize;
    const header = start + (page === 1 ? 100 : 0);
    const type = buf[header];
    const cells = buf.readUInt16BE(header + 3);
    if (type === INTERIOR_TABLE) {
      for (let i = 0; i < cells; i++) {
        const cell = start + buf.readUInt16BE(header + 12 + 2 * i);
        visit(buf.readUInt32BE(cell));
      }
      visit(buf.readUInt32BE(header + 8));
      return;
    }
    if (type !== LEAF_TABLE) throw new Error(`page ${page}: not a table b-tree page`);
    const keys: bigint[] = [];
    for (let i = 0; i < cells; i++) {
      let at = start + buf.readUInt16BE(header + 8 + 2 * i);
      at += varint(buf, at)[1]; // payload size
      keys.push(signed(varint(buf, at)[0]));
    }
    leaves.set(page, keys);
  };
  visit(root);
  return { pageSize, root, leaves };
}

/** Overwrites page `page` of `path` with 0xa5 bytes. */
export function scribblePage(path: string, page: number, pageSize: number): void {
  const buf = readFileSync(path);
  buf.fill(0xa5, (page - 1) * pageSize, page * pageSize);
  writeFileSync(path, buf);
}

/**
 * Scribbles over one leaf page of the usage table (not its root, not page 1): the last
 * one, or the one at `index` in page order. Returns the keys that were on it. Afterwards
 * reading every row fails, as cc-usage's `_corrupt_a_usage_leaf` asserts.
 */
export function corruptUsageLeaf(path: string, index = -1): bigint[] {
  const { pageSize, root, leaves } = usagePages(path);
  const pages = [...leaves.keys()].filter((p) => p !== root && p !== 1).sort((a, b) => a - b);
  const page = pages.at(index);
  if (page === undefined) throw new Error("the usage table has no leaf page to damage");
  scribblePage(path, page, pageSize);
  const db = new Database(path, { readonly: true });
  try {
    let failed = false;
    try {
      db.query("SELECT sum(inp) FROM usage").get();
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("the damaged page did not make the usage table unreadable");
  } finally {
    db.close();
  }
  return leaves.get(page) ?? [];
}
