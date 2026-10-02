// The real ingest Worker with mocked limit fetchers, for test/tui/limits-worker.test.ts. No
// network: every fetch is answered here and logged, one line per fetch ("<label> <ms>"),
// to fetches.log beside the start message's limits.json.
// - "flaky" fails like an outage (its last-good capture stays, and ages);
// - "signedout" is refused like a lost login (detected history-only: never fetched again);
// - any other account gets fresh limits.
// The schedule runs every second instead of every 5 minutes, without Claude's 30 s gap.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IngestRequest } from "../../../src/ingest/client.ts";
import { limitsOverrides } from "../../../src/ingest/worker.ts";
import { LimitFetchError, SignedOut } from "../../../src/limits/capture.ts";

declare const self: Worker;

const real = self.onmessage as (event: MessageEvent<IngestRequest>) => void;

self.onmessage = (event: MessageEvent<IngestRequest>) => {
  const request = event.data;
  if (request.type === "start" && request.options.limits !== undefined) {
    const log = join(dirname(request.options.limits.limitsPath), "fetches.log");
    limitsOverrides.timing = { intervalMs: 1000, claudeMinGapMs: 0, backoffMinMs: 60_000 };
    limitsOverrides.fetchClaude = async (root) => {
      appendFileSync(log, `${root.label} ${Date.now()}\n`);
      if (root.label === "flaky") throw new LimitFetchError("Claude usage endpoint answered 503");
      if (root.label === "signedout") throw new SignedOut("no Claude login on this machine");
      const now = Date.now() / 1000;
      return {
        captured_at: now,
        source: "claude",
        via: "api",
        rate_limits: {
          session: { label: "5-HOUR", used_percentage: 35, resets_at: now + 3 * 3600 },
          weekly_all: { label: "WEEKLY", used_percentage: 12, resets_at: now + 4 * 86_400 },
        },
      };
    };
  }
  real(event);
};
