import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexSessionIndex } from "../../src/ingest/pass.ts";
import { codexSessionId, readCodexFile } from "../../src/sources/codex.ts";
import { comparePyPaths } from "../../src/sources/pypath.ts";
import type { Root } from "../../src/sources/roots.ts";
import { cleanup, storedRows, tempDir } from "../ingest/helpers.ts";
import { openCodexEngine } from "./codex-helpers.ts";

afterEach(cleanup);

// Fake session ids only (the repo is public).
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const file = (n: number) => `rollout-2026-07-10T08-00-00-${sid(n)}.jsonl`;

const meta = (n: number, parent: number | null, ts: string | number | null, spawn = false) =>
  JSON.stringify({
    ...(ts === null ? {} : { timestamp: ts }),
    type: "session_meta",
    payload: {
      id: sid(n),
      ...(parent === null ? {} : { forked_from_id: sid(parent) }),
      ...(spawn && parent !== null
        ? { source: { subagent: { thread_spawn: { parent_thread_id: sid(parent) } } } }
        : {}),
    },
  });

/** A token_count carrying only `last_token_usage` (ccusage's `replay_token_count`). */
const lastOnly = (ts: string, input: number) =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: input, output_tokens: 1, total_tokens: input + 1 },
      },
    },
  });

const counted = (ts: string, total: number[] | null, last: number[] | null) =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        ...(total === null
          ? {}
          : {
              total_token_usage: {
                input_tokens: total[0],
                cached_input_tokens: total[1],
                output_tokens: total[2],
              },
            }),
        ...(last === null
          ? {}
          : {
              last_token_usage: {
                input_tokens: last[0],
                cached_input_tokens: last[1],
                output_tokens: last[2],
              },
            }),
      },
    },
  });

const taskStarted = (ts: string) =>
  JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "task_started" } });
const trigger = (ts: string, on = true, name = "inter_agent_communication_metadata") =>
  JSON.stringify({ timestamp: ts, type: name, payload: { trigger_turn: on } });

const at = (hms: string) => `2026-07-10T${hms}Z`;

/** Writes `files` (name -> lines) under a sessions dir; returns their paths by name. */
function rollouts(files: Record<string, string[]>): Record<string, string> {
  const dir = join(tempDir(), ".codex", "sessions");
  const out: Record<string, string> = {};
  for (const [name, lines] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`);
    out[name] = path;
  }
  return out;
}

/** Each rollout's counted input (incl. cached) under scheme 2, in file order. */
function ownInputs(files: Record<string, string[]>): Record<string, number[]> {
  const paths = rollouts(files);
  const fake = { provider: "codex" } as Root;
  const index = codexSessionIndex(Object.values(paths).map((path) => ({ path, root: fake })));
  const parents = (id: string, child: string) => index[id]?.find((p) => p !== child) ?? null;
  const out: Record<string, number[]> = {};
  for (const [name, path] of Object.entries(paths).sort(([, a], [, b]) => comparePyPaths(a, b))) {
    const read = readCodexFile(path, 0, null, { parents });
    out[name] = read.entries.map((e) => (e.post?.inp ?? 0) + (e.post?.cr ?? 0));
  }
  return out;
}

test("the session id is the uuid of the file name, else its stem", () => {
  expect(codexSessionId(`/x/${file(1)}`)).toBe(sid(1));
  expect(codexSessionId("/x/odd.jsonl")).toBe("odd");
});

// The known edge cases of ccusage's replay.rs, from its loader.rs tests (ported fixtures,
// with cc-usage's counting).
describe("replay.rs edge cases", () => {
  test("a subagent's replayed parent history is skipped; a reset to its own total counts", () => {
    const parent = [
      counted(at("08:01:00"), [1000, 100, 200], [1000, 100, 200]),
      counted(at("08:02:00"), [1500, 150, 300], [500, 50, 100]),
    ];
    const child = [
      meta(2, 1, at("08:03:00"), true),
      counted(at("08:03:00"), [1000, 100, 200], [1000, 100, 200]),
      counted(at("08:03:00"), [1500, 150, 300], [500, 50, 100]),
      counted(at("08:04:00"), [100, 10, 20], [100, 10, 20]),
      counted(at("08:05:00"), [150, 15, 30], [50, 5, 10]),
    ];
    expect(ownInputs({ [file(1)]: parent, [file(2)]: child })).toEqual({
      [file(1)]: [1000, 500],
      [file(2)]: [100, 50],
    });
  });

  test("the replay is bounded at the fork time, also a numeric one", () => {
    const parent = [lastOnly(at("08:01:00"), 100), lastOnly(at("08:03:00"), 50)];
    // 1783670520 is 2026-07-10T08:02:00Z in epoch seconds.
    const child = [
      meta(2, 1, 1_783_670_520),
      lastOnly(at("08:02:00"), 100),
      lastOnly(at("08:04:00"), 50),
    ];
    expect(ownInputs({ [file(1)]: parent, [file(2)]: child })[file(2)]).toEqual([50]);
  });

  test("a replay that starts mid-parent falls back to the burst at the head", () => {
    const parent = [
      lastOnly(at("08:01:00"), 100),
      lastOnly(at("08:02:00"), 200),
      lastOnly(at("08:03:00"), 300),
    ];
    const child = [
      meta(2, 1, at("09:00:00")),
      lastOnly(at("09:00:00.100"), 200),
      lastOnly(at("09:00:00.200"), 300),
      lastOnly(at("09:05:00"), 400),
    ];
    expect(ownInputs({ [file(1)]: parent, [file(2)]: child })[file(2)]).toEqual([400]);
  });

  test("a burst straddling a second boundary is skipped whole", () => {
    const child = [
      meta(2, 99, at("09:00:00.985")),
      lastOnly(at("09:00:00.986"), 100),
      lastOnly(at("09:00:00.999"), 200),
      lastOnly(at("09:00:01.000"), 300),
      lastOnly(at("09:00:01.009"), 400),
      lastOnly(at("09:00:08.000"), 500),
    ];
    expect(ownInputs({ [file(2)]: child })[file(2)]).toEqual([500]);
  });

  test("usage after a burst is the fork's own, however much of it", () => {
    const child = [
      meta(2, 99, at("09:00:00")),
      lastOnly(at("09:00:00.100"), 100),
      lastOnly(at("09:00:00.200"), 200),
      lastOnly(at("09:00:30"), 300),
      lastOnly(at("09:01:00"), 400),
      lastOnly(at("09:01:30"), 500),
    ];
    expect(ownInputs({ [file(2)]: child })[file(2)]).toEqual([300, 400, 500]);
  });

  test("child usage equal to a parent event written after the fork is kept", () => {
    const parent = [lastOnly(at("08:01:00"), 100), lastOnly(at("08:03:00"), 50)];
    const child = [
      meta(2, 1, at("08:02:00")),
      lastOnly(at("08:02:00"), 100),
      lastOnly(at("08:04:00"), 50),
    ];
    expect(ownInputs({ [file(1)]: parent, [file(2)]: child })[file(2)]).toEqual([50]);
  });

  test("a parent's stream is matched whole, even the part it replayed itself", () => {
    const parent = [
      meta(1, 98, at("08:00:00")),
      lastOnly(at("08:00:00.100"), 100),
      lastOnly(at("08:00:00.200"), 200),
      lastOnly(at("08:01:00"), 300),
      lastOnly(at("08:02:00"), 400),
    ];
    const child = [
      meta(2, 1, at("09:00:00")),
      lastOnly(at("09:00:00.100"), 100),
      lastOnly(at("09:00:00.200"), 200),
      lastOnly(at("09:00:00.300"), 300),
      lastOnly(at("09:00:00.400"), 400),
      lastOnly(at("09:05:00"), 500),
    ];
    expect(ownInputs({ [file(1)]: parent, [file(2)]: child })).toEqual({
      [file(1)]: [300, 400],
      [file(2)]: [500],
    });
  });

  test("a session naming itself as its parent keeps its usage", () => {
    const self = [meta(1, 1, null), lastOnly(at("08:01:00"), 100), lastOnly(at("08:02:00"), 200)];
    expect(ownInputs({ [file(1)]: self })[file(1)]).toEqual([100, 200]);
  });

  test("a repeated snapshot does not end the burst of a fork whose parent is gone", () => {
    const usage = (ts: string, last: number, total: number) =>
      JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: last, output_tokens: 1 },
            total_token_usage: { input_tokens: total, output_tokens: 1 },
          },
        },
      });
    const child = [
      meta(2, 99, null),
      usage(at("08:00:00.100"), 100, 100),
      usage(at("08:00:00.200"), 100, 100),
      usage(at("08:00:08.000"), 50, 50),
    ];
    expect(ownInputs({ [file(2)]: child })[file(2)]).toEqual([50]);
  });

  test("nested replays are matched against each parent's immutable stream", () => {
    const files = {
      [file(1)]: [meta(1, null, null), lastOnly(at("08:01:00"), 100)],
      [file(2)]: [meta(2, 1, null), lastOnly(at("09:00:00"), 100), lastOnly(at("09:01:00"), 50)],
      [file(3)]: [
        meta(3, 2, null),
        lastOnly(at("10:00:00"), 100),
        lastOnly(at("10:00:01"), 50),
        lastOnly(at("10:01:00"), 25),
      ],
    };
    expect(ownInputs(files)).toEqual({ [file(1)]: [100], [file(2)]: [50], [file(3)]: [25] });
  });

  test("several subagents of one parent each skip their replay", () => {
    const parent = [counted(at("08:01:00"), [1000, 100, 200], [1000, 100, 200])];
    const sub = (n: number, born: string, own: string, input: number) => [
      meta(n, 1, born, true),
      meta(1, null, born),
      counted(born, [700, 70, 140], [700, 70, 140]),
      counted(born, [1000, 100, 200], [300, 30, 60]),
      counted(own, [input, 0, 10], [input, 0, 10]),
    ];
    const out = ownInputs({
      [file(1)]: parent,
      [file(2)]: sub(2, at("08:02:00"), at("08:04:00"), 50),
      [file(3)]: sub(3, at("08:06:00"), at("08:08:00"), 75),
      [file(4)]: sub(4, at("08:10:00"), at("08:12:00"), 25),
    });
    expect(
      Object.values(out)
        .flat()
        .reduce((a, b) => a + b, 0),
    ).toBe(1150);
  });

  test("skipping keeps the cumulative baseline", () => {
    const child = [
      meta(2, 99, at("08:03:00"), true),
      counted(at("08:03:00"), [1000, 100, 200], null),
      counted(at("08:03:00"), [1500, 150, 300], null),
      counted(at("08:04:00"), [1600, 160, 320], null),
    ];
    const paths = rollouts({ [file(2)]: child });
    const read = readCodexFile(paths[file(2)] as string, 0, null);
    expect(read.entries.map((e) => e.post)).toEqual([
      { inp: 90, outp: 20, cr: 10, cc: 0, e5: 0, e1: 0, tier: 0 },
    ]);
  });
});

describe("trigger-turn markers", () => {
  const parent = [
    counted(at("08:01:00"), [1000, 100, 200], [1000, 100, 200]),
    counted(at("08:02:00"), [1500, 150, 300], [500, 50, 100]),
  ];

  test("usage between the task_started before the trigger turn and the turn is the child's own", () => {
    // Out of the parent's stream and the head burst, but after the boundary.
    const child = [
      meta(2, 1, at("08:03:00"), true),
      counted(at("08:03:00"), [1000, 100, 200], [1000, 100, 200]),
      taskStarted(at("08:03:00")),
      counted(at("08:03:00.200"), [1500, 150, 300], [500, 50, 100]),
      trigger(at("08:03:00.300")),
      counted(at("08:04:00"), [1600, 150, 320], [100, 0, 20]),
    ];
    expect(ownInputs({ [file(1)]: parent, [file(2)]: child })[file(2)]).toEqual([500, 100]);
  });

  test("with several task_started markers, the last one before the trigger turn is the boundary", () => {
    const child = [
      meta(2, 99, at("08:03:00"), true),
      lastOnly(at("08:03:00.100"), 100),
      taskStarted(at("08:03:00.150")),
      lastOnly(at("08:03:00.200"), 200),
      taskStarted(at("08:03:00.250")),
      lastOnly(at("08:03:00.300"), 300),
      trigger(at("08:03:00.350")),
      lastOnly(at("08:03:00.400"), 400),
    ];
    // all four are in the head burst; the marker makes the last two the child's own
    expect(ownInputs({ [file(2)]: child })[file(2)]).toEqual([300, 400]);
  });

  // The critique's case: replay.rs judges both leading events own (no parent anchor, no
  // burst: they are 5 s apart), but the subagent's trigger turn comes later and wins.
  test.each([
    ["the parent is missing", false],
    ["the parent is present but does not anchor them", true],
  ])("markers overrule replay.rs's earlier judgement (%s)", (_name, withParent) => {
    const parent = [counted(at("07:00:00"), [10, 0, 1], [10, 0, 1])];
    const child = [
      meta(2, withParent ? 1 : 99, at("08:03:00"), true),
      counted(at("08:03:00"), [1000, 100, 200], [1000, 100, 200]),
      counted(at("08:03:05"), [2100, 100, 400], [1100, 0, 200]),
      taskStarted(at("08:03:06")),
      trigger(at("08:03:06")),
      counted(at("08:04:00"), [2650, 100, 450], [550, 0, 50]),
    ];
    const files = withParent ? { [file(1)]: parent, [file(2)]: child } : { [file(2)]: child };
    expect(ownInputs(files)[file(2)]).toEqual([550]);
  });

  test("a fork without thread_spawn follows replay.rs alone: markers do not apply", () => {
    const child = [
      meta(2, 99, at("08:03:00")),
      counted(at("08:03:00"), [1000, 100, 200], [1000, 100, 200]),
      counted(at("08:03:05"), [2100, 100, 400], [1100, 0, 200]),
      taskStarted(at("08:03:06")),
      trigger(at("08:03:06")),
      counted(at("08:04:00"), [2650, 100, 450], [550, 0, 50]),
    ];
    expect(ownInputs({ [file(2)]: child })[file(2)]).toEqual([1000, 1100, 550]);
  });

  test("a fork's open head ignores markers: what matched the parent stays inherited", () => {
    const parent = [
      counted(at("08:01:00"), [1000, 100, 200], [1000, 100, 200]),
      counted(at("08:02:00"), [1500, 150, 300], [500, 50, 100]),
    ];
    const fork = [
      meta(2, 1, at("08:03:00")),
      counted(at("08:01:00"), [1000, 100, 200], [1000, 100, 200]),
      taskStarted(at("08:03:01")),
      counted(at("08:02:00"), [1500, 150, 300], [500, 50, 100]),
      trigger(at("08:03:02")),
      counted(at("08:04:00"), [1600, 150, 310], [100, 0, 10]),
    ];
    expect(ownInputs({ [file(1)]: parent, [file(2)]: fork })[file(2)]).toEqual([100]);
  });

  test("trigger_turn false is not a marker", () => {
    const child = [
      meta(2, 99, at("08:03:00"), true),
      counted(at("08:03:00"), [1000, 100, 200], [1000, 100, 200]),
      counted(at("08:03:00"), [1500, 150, 300], [500, 50, 100]),
      taskStarted(at("08:03:00")),
      trigger(at("08:03:00"), false),
      counted(at("08:04:00"), [1600, 150, 320], [100, 0, 20]),
    ];
    // the burst rule decides: the head burst is inherited
    expect(ownInputs({ [file(2)]: child })[file(2)]).toEqual([100]);
  });

  test("the older event name is a marker too", () => {
    const child = [
      meta(2, 99, at("08:03:00"), true),
      counted(at("08:03:00"), [1000, 100, 200], [1000, 100, 200]),
      trigger(at("08:03:00"), true, "inter_agent_communication"),
      counted(at("08:03:00"), [1100, 100, 220], [100, 0, 20]),
    ];
    // without the marker the head burst would swallow the last event too
    expect(ownInputs({ [file(2)]: child })[file(2)]).toEqual([100]);
  });

  test("no markers and no parent rule: a rollout naming no parent counts everything", () => {
    const plain = [
      meta(1, null, at("08:00:00")),
      counted(at("08:00:00"), [10, 0, 1], [10, 0, 1]),
      counted(at("08:00:00.1"), [20, 0, 2], [10, 0, 1]),
      taskStarted(at("08:00:01")),
      trigger(at("08:00:02")),
      counted(at("08:00:03"), [30, 0, 3], [10, 0, 1]),
    ];
    expect(ownInputs({ [file(1)]: plain })[file(1)]).toEqual([10, 10, 10]);
  });
});

/** A stored row without its account, which differs between two temp homes. */
const content = ({
  acct: _a,
  identity: _i,
  label: _l,
  ...row
}: ReturnType<typeof storedRows> extends Map<bigint, infer R> ? R : never) => row;

// A live rollout is read in pieces; the stored result must not depend on where they fall.
describe("reading in pieces", () => {
  const scenarios: Record<string, Record<string, string[]>> = {
    "a burst decided by its second event": {
      [file(2)]: [
        meta(2, 99, at("09:00:00")),
        lastOnly(at("09:00:00.100"), 100),
        lastOnly(at("09:00:00.200"), 200),
        lastOnly(at("09:00:30"), 300),
      ],
    },
    "a burst event the trigger turn makes own": {
      [file(2)]: [
        meta(2, 99, at("09:00:00"), true),
        lastOnly(at("09:00:00.100"), 100),
        lastOnly(at("09:00:00.200"), 200),
        taskStarted(at("09:00:00.250")),
        lastOnly(at("09:00:00.300"), 300),
        trigger(at("09:00:00.400")),
        lastOnly(at("09:00:00.500"), 400),
      ],
    },
    "events replay.rs counted that a later trigger turn makes inherited": {
      [file(2)]: [
        meta(2, 99, at("08:03:00"), true),
        counted(at("08:03:00"), [1000, 100, 200], [1000, 100, 200]),
        counted(at("08:03:05"), [2100, 100, 400], [1100, 0, 200]),
        taskStarted(at("08:03:06")),
        trigger(at("08:03:06")),
        counted(at("08:04:00"), [2650, 100, 450], [550, 0, 50]),
      ],
    },
    "a counted first event the trigger turn makes inherited": {
      [file(2)]: [
        meta(2, 99, at("09:00:00"), true),
        lastOnly(at("09:00:00.100"), 100),
        trigger(at("09:00:00.150")),
        lastOnly(at("09:00:01.000"), 200),
      ],
    },
    "a parent's stream matched across pieces": {
      [file(1)]: [
        counted(at("08:01:00"), [1000, 100, 200], [1000, 100, 200]),
        counted(at("08:02:00"), [1500, 150, 300], [500, 50, 100]),
      ],
      [file(2)]: [
        meta(2, 1, at("08:03:00")),
        taskStarted(at("08:03:00")),
        counted(at("08:01:00"), [1000, 100, 200], [1000, 100, 200]),
        counted(at("08:02:00"), [1500, 150, 300], [500, 50, 100]),
        counted(at("08:04:00"), [1600, 160, 320], [100, 10, 20]),
      ],
    },
    "events before the first turn_context": {
      [file(3)]: [
        counted(at("08:00:01"), [10, 0, 1], [10, 0, 1]),
        counted(at("08:00:02"), [20, 0, 2], [10, 0, 1]),
        JSON.stringify({
          timestamp: at("08:00:03"),
          type: "turn_context",
          payload: { model: "gpt-test" },
        }),
        counted(at("08:00:04"), [30, 0, 3], [10, 0, 1]),
      ],
    },
  };

  for (const [name, files] of Object.entries(scenarios)) {
    test(`${name}: one pass per line stores what one pass over the whole file stores`, async () => {
      const whole = rollouts(files);
      const home = dirname(dirname(Object.values(whole)[0] as string));
      const once = openCodexEngine([home]);
      await once.fullPass();
      const want = [...storedRows(once.store).values()].map(content);

      const growing = rollouts(Object.fromEntries(Object.keys(files).map((n) => [n, []])));
      const growingHome = dirname(dirname(Object.values(growing)[0] as string));
      for (const path of Object.values(growing)) writeFileSync(path, "");
      const live = openCodexEngine([growingHome]);
      const longest = Math.max(...Object.values(files).map((l) => l.length));
      for (let i = 0; i < longest; i++) {
        for (const [n, lines] of Object.entries(files)) {
          const line = lines[i];
          if (line !== undefined) appendFileSync(growing[n] as string, `${line}\n`);
        }
        await live.fullPass();
      }
      const got = [...storedRows(live.store).values()].map(content);
      expect(got).toEqual(want);
    });
  }
});
