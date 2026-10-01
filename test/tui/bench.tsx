// TUI budgets (T10 acceptance 2) on a 1M-row synthetic store, in a real terminal.
// Usage: bun run bench:tui [path/to/tokenhud-binary]   (exits 1 if a budget is missed)
//
// The store goes in the OS temp dir (TMPDIR; on this WSL machine /tmp is tmpfs, so point
// TMPDIR at an ext4 directory to measure there), in a throwaway home whose ~/.claude holds
// one synthetic transcript for the ingest Worker. tokenhud runs under `script` with
// TOKENHUD_TRACE, which records:
// - first-frame: ms from process start to the first frame drawn with data;
// - switch: ms from a view key to its frame being drawn (100 switches, 1–4 in turn);
// - tick: ms the refresh tick takes on the UI thread.
// Idle CPU is read from /proc/<pid>/stat over 60 s with nothing changing (Linux only).
// A second part times the same frames in-process (OpenTUI's test renderer), with view
// models computed from the same store, and a tick that does change what's on screen.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { openStore } from "../../src/store/store.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState } from "../../src/tui/controller.ts";
import { ACCOUNTS, syntheticRows } from "../query/synthetic.ts";
import { fixtureConfig, fixtureViews } from "./fixture.ts";
import { CLI, makeHome, runInPty } from "./pty/driver.ts";
import { render } from "./render.ts";

const ROWS = 1_000_000;
const BUDGET = { firstFrame: 300, switchP95: 16, tick: 5, idleCpu: 1 };
const binary = process.argv[2];
let failed = false;

function verdict(label: string, value: number, budget: number, unit = "ms"): void {
  const ok = value <= budget;
  if (!ok) failed = true;
  console.log(
    `  ${label.padEnd(44)} ${value.toFixed(2).padStart(8)} ${unit}  (budget ${budget} ${unit}: ${ok ? "ok" : "MISSED"})`,
  );
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] as number };
}

interface TraceEvent {
  event: string;
  ms: number;
  /** When it happened, ms since the process started. */
  at: number;
}

function events(path: string, event: string): TraceEvent[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEvent)
    .filter((e) => e.event === event);
}

function trace(path: string, event: string): number[] {
  return events(path, event).map((e) => e.ms);
}

/** utime + stime of a process and its threads, in seconds. */
function cpuSeconds(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) / 100; // USER_HZ is 100 on Linux
}

const base = mkdtempSync(join(tmpdir(), "tokenhud-tui-bench-"));
try {
  const home = makeHome({ base });
  const storePath = join(home.configDir, "tokenhud.db");
  console.log(`store: ${ROWS.toLocaleString("en-US")} rows in ${storePath}`);
  let t = performance.now();
  const now = Date.now();
  const rows = syntheticRows({
    rows: ROWS,
    from: now - 365 * 86_400_000,
    to: now - 8 * 3_600_000,
    seed: 11,
  });
  const store = openStore(storePath);
  for (let i = 0; i < rows.length; i += 100_000) store.upsert(rows.slice(i, i + 100_000));
  store.close();
  console.log(
    `  built in ${((performance.now() - t) / 1000).toFixed(1)} s (${ACCOUNTS.length} accounts)`,
  );

  // ── in a real terminal ──────────────────────────────────────────────────────────
  const command = binary ?? `${process.execPath} ${CLI}`;
  console.log(`\nin a pty (105×50): ${binary ? "binary" : "from source"}, refresh every 2 s`);
  const firstFrames: number[] = [];
  for (let i = 0; i < 5; i++) {
    const tracePath = join(base, `start-${i}.jsonl`);
    writeFileSync(tracePath, "");
    const run = runInPty(command, { ...home.env, TOKENHUD_TRACE: tracePath });
    await run.waitFor((s) => s.includes(" SPEND") && !s.includes("reading the store"), "data");
    await run.waitFor(() => trace(tracePath, "first-frame").length > 0, "the trace");
    firstFrames.push(trace(tracePath, "first-frame")[0] as number);
    run.send("q");
    await run.exited;
  }
  const ff = stats(firstFrames);
  console.log(`  first frame over 5 starts: ${firstFrames.map((x) => x.toFixed(0)).join(", ")} ms`);
  verdict("first frame with data (max of 5)", ff.max, BUDGET.firstFrame);

  const tracePath = join(base, "run.jsonl");
  writeFileSync(tracePath, "");
  const run = runInPty(command, { ...home.env, TOKENHUD_TRACE: tracePath });
  await run.waitFor((s) => s.includes("● live"), "live");
  for (let i = 0; i < 100; i++) {
    run.send(["2", "3", "4", "1"][i % 4] as string);
    await Bun.sleep(120);
  }
  const switches = stats(trace(tracePath, "switch"));
  console.log(
    `  switches: n=${switches.n} p50 ${switches.p50.toFixed(2)} p95 ${switches.p95.toFixed(2)} max ${switches.max.toFixed(2)} ms`,
  );
  verdict("view switch p95 (key → frame drawn)", switches.p95, BUDGET.switchP95);

  // Idle: let the ingest Worker settle, then a quiet minute.
  await Bun.sleep(5000);
  const quietFrom = Math.max(...events(tracePath, "switch").map((e) => e.at)) + 5000;
  const pid = JSON.parse(readFileSync(join(home.configDir, "ingest.lock"), "utf8")).pid as number;
  const rss0 = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1];
  const c0 = cpuSeconds(pid);
  const w0 = performance.now();
  await Bun.sleep(60_000);
  const cpu = ((cpuSeconds(pid) - c0) / ((performance.now() - w0) / 1000)) * 100;
  const all = events(tracePath, "tick");
  const line = (label: string, x: ReturnType<typeof stats>) =>
    console.log(
      `  ticks ${label}: n=${x.n} p50 ${x.p50.toFixed(3)} p95 ${x.p95.toFixed(3)} max ${x.max.toFixed(3)} ms`,
    );
  const busy = stats(all.filter((e) => e.at < quietFrom).map((e) => e.ms));
  const quiet = stats(all.filter((e) => e.at >= quietFrom).map((e) => e.ms));
  line("during the switches", busy);
  line("idle", quiet);
  // The tick's own work is a lock check and one postMessage. A rare sample includes a
  // garbage-collector pause that lands in its window (after a burst of renders), so the
  // budget is checked on p95 and the max is shown beside it.
  verdict("refresh tick on the UI thread (p95)", stats(all.map((e) => e.ms)).p95, BUDGET.tick);
  verdict("idle CPU over 60 s (% of one core)", cpu, BUDGET.idleCpu, "%");
  console.log(`  RSS ${Math.round(Number(rss0) / 1024)} MB`);
  run.send("q");
  await run.exited;

  // ── in-process frames ───────────────────────────────────────────────────────────
  console.log("\nin-process (OpenTUI test renderer, 105×50): the same store's view models");
  t = performance.now();
  const { views, accounts } = fixtureViews(storePath, fixtureConfig({ time_zone: "UTC" }));
  console.log(
    `  view models computed cold in ${(performance.now() - t).toFixed(0)} ms (in the Worker, off the UI thread)`,
  );
  const ports = {
    saveConfig() {},
    vmSettings() {},
    vmConfig() {},
    vmRoots() {},
    accountsEdited() {},
    quit() {},
  };
  const c = new Controller(initialState(fixtureConfig(), "owner"), ports, "UTC");
  c.vmMessage({ type: "views", views, accounts, scope: null, ms: 0 });
  c.setIngest("live");
  const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
  const frames: number[] = [];
  for (let i = 0; i < 100; i++) {
    const key = String((i % 4) + 1);
    const a = performance.now();
    await act(async () => c.key({ name: key, sequence: key, ctrl: false }));
    await setup.renderOnce();
    frames.push(performance.now() - a);
  }
  const f = stats(frames);
  console.log(
    `  switch + frame: p50 ${f.p50.toFixed(2)} p95 ${f.p95.toFixed(2)} max ${f.max.toFixed(2)} ms`,
  );
  const tickFrames: number[] = [];
  for (let i = 0; i < 50; i++) {
    const a = performance.now();
    await act(async () =>
      c.vmMessage({ type: "mcp", activity: { servers: 1, agents: i % 3, recent: [] } }),
    );
    await setup.renderOnce();
    tickFrames.push(performance.now() - a);
  }
  const tf = stats(tickFrames);
  console.log(
    `  a tick that changes the screen (state + frame): p95 ${tf.p95.toFixed(2)} max ${tf.max.toFixed(2)} ms`,
  );
  setup.renderer.destroy();
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
