// `tokenhud hook` latency (T29: p95 under 60 ms on Linux, for the compiled binary).
// Usage: bun run build && bun run bench:hook [binary] [runs]   (exits 1 over budget)
//
// Runs a copy of the binary (dist/tokenhud by default) as Claude Code does, a fresh process
// per event with the event on stdin, on a temp machine in the OS temp dir: a fake HOME with
// a Claude config dir and a transcript, and a config home with limits.json and alerts.json.
// Nothing of this machine's own is read. The copy is there because an installed tokenhud
// lives on a local disk; run from the repo on /mnt/d under WSL (9P), every start reads the
// 97 MB binary over the network share, about 200 ms. Each case is timed from spawn to
// exit, after 5 warm-up runs; the files are reset before every run, so a firing case fires
// every time.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootIdentity } from "../../src/sources/roots.ts";

const BUDGET_P95_MS = 60;
const source = process.argv[2] ?? join(import.meta.dir, "..", "..", "dist", "tokenhud");
const runs = Number(process.argv[3] ?? 200);
const SESSION = "00000000-0000-4000-8000-000000000001";

const base = mkdtempSync(join(tmpdir(), "tokenhud-hook-bench-"));
const binary = join(base, "tokenhud");
copyFileSync(source, binary);
const home = join(base, "home");
const xdg = join(base, "xdg");
const claude = join(home, ".claude");
const transcript = join(claude, "projects", "-fake-project", `${SESSION}.jsonl`);
mkdirSync(join(claude, "projects", "-fake-project"), { recursive: true });
writeFileSync(transcript, "{}\n");
const config = join(xdg, "tokenhud");
mkdirSync(config, { recursive: true });
const id = rootIdentity(claude, home);
const now = Date.now();

function limits(pct: number): string {
  const s = now / 1000;
  const capture = {
    captured_at: s - 30,
    source: "claude",
    via: "api",
    rate_limits: {
      session: { label: "5-HOUR", used_percentage: pct, resets_at: s + 4000 },
      weekly_all: { label: "WEEKLY", used_percentage: 40, resets_at: s + 300_000 },
      weekly_scoped: { label: "FABLE WEEKLY", used_percentage: 10, resets_at: s + 300_000 },
    },
  };
  return JSON.stringify({ providers: { [id]: capture }, status: {} }, null, 2);
}

const account = { id, label: "personal", provider: "claude", group: null, members: [id] };
const alert = (n: number, window: string, at: number, session: string | null) => ({
  id: `a${n}`,
  created_at: now - 1000,
  session,
  account,
  window,
  at,
  note: "pause the refactor and commit",
  delivered: [],
});
const ALERTS = JSON.stringify(
  {
    alerts: [
      alert(1, "5h", 80, SESSION),
      alert(2, "weekly", 90, null),
      alert(3, "weekly_scoped", 50, SESSION),
    ],
  },
  null,
  2,
);

function event(name: string): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: transcript,
    cwd: home,
    permission_mode: "default",
    hook_event_name: name,
    tool_calls: [{ tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_01" }],
    tool_results: [
      { tool_use_id: "toolu_01", tool_name: "Bash", content: "x".repeat(2000), is_error: false },
    ],
  });
}

const env = {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdg,
  TOKENHUD_WSL_USERS: "",
  PATH: "/usr/bin:/bin",
};
const limitsFile = join(config, "limits.json");
const alertsFile = join(config, "alerts.json");
let failed = false;

function bench(label: string, name: string, reset: () => void, expectOutput: boolean): void {
  const times: number[] = [];
  for (let i = 0; i < runs + 5; i++) {
    reset();
    const t = performance.now();
    const run = Bun.spawnSync([binary, "hook"], {
      env,
      stdin: Buffer.from(event(name)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const ms = performance.now() - t;
    if (run.exitCode !== 0 || run.stdout.length > 0 !== expectOutput) {
      throw new Error(
        `${label}: exit ${run.exitCode}, stdout ${JSON.stringify(run.stdout.toString())}`,
      );
    }
    if (i >= 5) times.push(ms);
  }
  times.sort((a, b) => a - b);
  const at = (q: number) =>
    times[Math.min(times.length - 1, Math.floor(q * times.length))] as number;
  const p95 = at(0.95);
  const over = p95 >= BUDGET_P95_MS;
  failed ||= over;
  console.log(
    `${label.padEnd(44)} p50 ${at(0.5).toFixed(1)} ms  p95 ${p95.toFixed(1)} ms  max ${(times.at(-1) as number).toFixed(1)} ms${over ? "  OVER BUDGET" : ""}`,
  );
}

try {
  console.log(
    `${source} (a copy in ${tmpdir()}), ${runs} runs a case, budget p95 < ${BUDGET_P95_MS} ms`,
  );
  const armed = () => {
    writeFileSync(alertsFile, ALERTS);
    writeFileSync(limitsFile, limits(50));
  };
  bench(
    "PostToolBatch, no alerts.json",
    "PostToolBatch",
    () => {
      rmSync(alertsFile, { force: true });
      writeFileSync(limitsFile, limits(50));
    },
    false,
  );
  bench("PostToolBatch, 3 alerts armed, none fires", "PostToolBatch", armed, false);
  bench("UserPromptSubmit, 3 alerts armed, none fires", "UserPromptSubmit", armed, false);
  bench(
    "PostToolBatch, one alert fires",
    "PostToolBatch",
    () => {
      writeFileSync(alertsFile, ALERTS);
      writeFileSync(limitsFile, limits(82));
    },
    true,
  );
  bench("SessionEnd, 2 session alerts removed", "SessionEnd", armed, false);
} finally {
  rmSync(base, { recursive: true, force: true });
}
if (failed) process.exit(1);
