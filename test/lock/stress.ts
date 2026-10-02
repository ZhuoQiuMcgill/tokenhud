// The ingest lock under stress: N contenders racing for it for a while, some of them
// killed with SIGKILL at random moments (a holder too), checked for any instant at which
// two processes held it. Used by lock.test.ts (a few rounds, every OS in CI) and run by
// hand for the acceptance count: `bun test/lock/stress.ts 300` (rounds, default 300).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTENDER = join(import.meta.dir, "contender.ts");

export interface RoundResult {
  /** Logged hold intervals. */
  holds: number;
  kills: number;
  /** Pairs of holders whose intervals overlap: must be 0. */
  overlaps: number;
}

/** One round: `n` contenders for `ms`, `kills` of them SIGKILLed at random times. */
export async function round(n = 16, ms = 300, kills = 4): Promise<RoundResult> {
  const base = mkdtempSync(join(tmpdir(), "tokenhud-lock-stress-"));
  try {
    const dir = join(base, "signals");
    mkdirSync(dir);
    const path = join(base, "config", "ingest.lock.db");
    // Contenders run until killed: every one ends with SIGKILL, at a recorded time.
    const until = Date.now() + 120_000;
    const procs = Array.from({ length: n }, () =>
      Bun.spawn([process.execPath, CONTENDER, path, dir, String(until)], {
        stdout: "ignore",
        stderr: "ignore",
        // Never a real config: the contenders' home is the round's temp dir.
        env: { PATH: process.env.PATH ?? "", HOME: base, XDG_CONFIG_HOME: join(base, "xdg") },
      }),
    );
    const ready = () => readdirSync(dir).filter((f) => f.startsWith("ready-")).length;
    const startBy = Date.now() + 60_000;
    while (ready() < n && Date.now() < startBy) await Bun.sleep(5);
    writeFileSync(join(dir, "go"), "");
    const t0 = Date.now();
    const killedAt = new Map<number, number>();
    const kill = (p: (typeof procs)[number]) => {
      killedAt.set(p.pid, performance.timeOrigin + performance.now()); // before the kill
      p.kill("SIGKILL");
    };
    const times = Array.from({ length: kills }, () => Math.random() * ms).sort((a, b) => a - b);
    for (const at of times) {
      await Bun.sleep(Math.max(0, t0 + at - Date.now()));
      const live = procs.filter((p) => !killedAt.has(p.pid));
      const victim = live[Math.floor(Math.random() * live.length)];
      if (victim === undefined) break;
      kill(victim);
    }
    await Bun.sleep(Math.max(0, t0 + ms - Date.now()));
    const injected = killedAt.size;
    for (const p of procs) if (!killedAt.has(p.pid)) kill(p);
    await Promise.all(procs.map((p) => p.exited));
    // Intervals: acquire → release, or → the kill (the kernel frees the lock after that).
    const intervals: { pid: number; from: number; to: number }[] = [];
    for (const f of readdirSync(dir).filter((f) => f.startsWith("log-"))) {
      const pid = Number(f.slice(4));
      let open: number | null = null;
      for (const line of readFileSync(join(dir, f), "utf8").trim().split("\n")) {
        const [what, , at] = line.split(" ");
        if (what === "acquire") open = Number(at);
        else if (what === "release" && open !== null) {
          intervals.push({ pid, from: open, to: Number(at) });
          open = null;
        }
      }
      if (open !== null)
        intervals.push({ pid, from: open, to: killedAt.get(pid) ?? Number.POSITIVE_INFINITY });
    }
    intervals.sort((a, b) => a.from - b.from);
    let overlaps = 0;
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        const a = intervals[i] as (typeof intervals)[number];
        const b = intervals[j] as (typeof intervals)[number];
        if (b.from >= a.to) break;
        if (a.pid !== b.pid) overlaps++;
      }
    }
    return { holds: intervals.length, kills: injected, overlaps };
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (import.meta.main) {
  const rounds = Number(process.argv[2] ?? 300);
  let bad = 0;
  let holds = 0;
  let kills = 0;
  for (let r = 0; r < rounds; r++) {
    const result = await round();
    holds += result.holds;
    kills += result.kills;
    if (result.overlaps > 0) {
      bad++;
      console.log(`round ${r}: ${result.overlaps} overlapping holds`);
    }
  }
  console.log(
    `${rounds} rounds, 16 contenders: ${holds} holds, ${kills} kills, ${bad} rounds with two holders`,
  );
  process.exit(bad === 0 ? 0 : 1);
}
