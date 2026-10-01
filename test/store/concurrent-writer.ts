// A second writer process for store.test.ts: upserts its own rows plus a shared set into
// one store, round after round, each round raising every row's output count.
// Usage: bun concurrent-writer.ts <store path> <name> <first own key> <own rows> <rounds>
import { openStore } from "../../src/store/store.ts";

const [path, name, first, own, rounds] = process.argv.slice(2);
if (path === undefined || name === undefined || first === undefined) {
  throw new Error("usage: <path> <name> <first own key> <own rows> <rounds>");
}
const store = openStore(path);
const base = 1_780_000_000_000;
for (let round = 0; round < Number(rounds); round++) {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({ key: BigInt(1000 + i), who: "shared" })),
    ...Array.from({ length: Number(own) }, (_, i) => ({
      key: BigInt(first) + BigInt(i),
      who: name,
    })),
  ].map(({ key, who }) => ({
    key,
    provider: "claude",
    identity: `id-${who}`,
    label: who,
    ts: base + Number(key % 7200n) * 1000,
    model: "claude-opus-4-8",
    inp: 1,
    outp: round,
    cr: 0,
    cc: 0,
    e5: null,
    e1: null,
    tier: 0,
  }));
  store.upsert(rows);
}
store.close();
