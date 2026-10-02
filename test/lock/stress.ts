// The ingest lock under stress: N contenders racing for it for a while, some of them
// killed with SIGKILL at random moments (a holder too), checked for any instant at which
// two processes held it. Used by lock.test.ts (a few rounds, every OS in CI) and run by
// hand for the acceptance count: `bun test/lock/stress.ts 300` (rounds, default 300).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../guard.ts";

const CONTENDER = join(import.meta.dir, "contender.ts");

export interface RoundResult {
  /** Logged hold intervals. */
  holds: number;
  kills: number;
  /** Pairs of holders whose intervals overlap: must be 0. */
  overlaps: number;
}

/**
 * A round that can't log its holds within this has found a lock that isn't freed: 24 holds
 * take a few hundred milliseconds even on a busy CI runner.
 */
const ROUND_DEADLINE_MS = 15_000;

interface Interval {
  pid: number;
  from: number;
  to: number;
}

/** Each contender's log as it stands: completed lines only (a write may be under way). */
function readLogs(dir: string): Map<number, string[]> {
  const logs = new Map<number, string[]>();
  for (const f of readdirSync(dir).filter((f) => f.startsWith("log-"))) {
    const text = readFileSync(join(dir, f), "utf8");
    logs.set(
      Number(f.slice(4)),
      text
        .slice(0, text.lastIndexOf("\n") + 1)
        .split("\n")
        .slice(0, -1),
    );
  }
  return logs;
}

function acquires(logs: Map<number, string[]>): number {
  let n = 0;
  for (const lines of logs.values()) for (const l of lines) if (l.startsWith("acquire")) n++;
  return n;
}

/**
 * One round: `n` contenders until `holds` holds are logged (and at least `ms` passed),
 * `kills` of them SIGKILLed along the way, half of those while holding the lock.
 *
 * The round runs on progress, not the clock: the kills land once the logged holds reach
 * random points, and it ends once every hold it asked for is logged. A slow or busy machine
 * (a CI runner whose fsyncs stall) only makes it take longer; with a 300 ms round it once
 * ended before any contender had taken the lock at all.
 */
export async function round(n = 16, ms = 300, kills = 4, holds = 24): Promise<RoundResult> {
  const base = mkdtempSync(join(tmpdir(), "tokenhud-lock-stress-"));
  try {
    const dir = join(base, "signals");
    mkdirSync(dir);
    const path = join(base, "config", "ingest.lock.db");
    // Contenders run until killed: every one ends with SIGKILL, at a recorded time.
    const until = Date.now() + 2 * ROUND_DEADLINE_MS;
    const procs = Array.from({ length: n }, () =>
      Bun.spawn([process.execPath, CONTENDER, path, dir, String(until)], {
        stdout: "ignore",
        stderr: "ignore",
        // Never a real config: the contenders' home is the round's temp dir.
        env: childEnv({ PATH: process.env.PATH, HOME: base, XDG_CONFIG_HOME: join(base, "xdg") }),
      }),
    );
    const ready = () => readdirSync(dir).filter((f) => f.startsWith("ready-")).length;
    const startBy = Date.now() + ROUND_DEADLINE_MS;
    while (ready() < n && Date.now() < startBy) await Bun.sleep(5);
    writeFileSync(join(dir, "go"), "");
    const t0 = Date.now();
    const killedAt = new Map<number, number>();
    const kill = (p: (typeof procs)[number]) => {
      killedAt.set(p.pid, performance.timeOrigin + performance.now()); // before the kill
      p.kill("SIGKILL");
    };
    // Kill when the logged holds reach these counts: random points through the round.
    const marks = Array.from({ length: kills }, () => 1 + Math.floor(Math.random() * holds)).sort(
      (a, b) => a - b,
    );
    const deadline = t0 + ROUND_DEADLINE_MS;
    for (;;) {
      const logs = readLogs(dir);
      const logged = acquires(logs);
      while (marks.length > 0 && logged >= (marks[0] as number)) {
        marks.shift();
        const live = procs.filter((p) => !killedAt.has(p.pid));
        // Half the time the holder, if one is holding: its last line is "acquire".
        const holding = live.filter((p) => logs.get(p.pid)?.at(-1)?.startsWith("acquire"));
        const pool = holding.length > 0 && Math.random() < 0.5 ? holding : live;
        const victim = pool[Math.floor(Math.random() * pool.length)];
        if (victim !== undefined) kill(victim);
      }
      // Every mark is at most `holds`, so every kill is made by the time the round ends.
      if ((logged >= holds && Date.now() - t0 >= ms) || Date.now() >= deadline) break;
      await Bun.sleep(2);
    }
    const injected = killedAt.size;
    for (const p of procs) if (!killedAt.has(p.pid)) kill(p);
    await Promise.all(procs.map((p) => p.exited));
    // Intervals: acquire → release, or → the kill (the kernel frees the lock after that).
    const intervals: Interval[] = [];
    for (const [pid, lines] of readLogs(dir)) {
      let open: number | null = null;
      for (const line of lines) {
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
        const a = intervals[i] as Interval;
        const b = intervals[j] as Interval;
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
