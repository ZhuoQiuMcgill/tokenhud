// One Claude fetch against a loopback fake of the usage endpoint, run as its own process so
// secrets.test.ts can set BUN_CONFIG_VERBOSE_FETCH and read everything it prints.
// "control" sends the same request without tokenhud's `verbose: false`, to prove the test
// would see a leak.
import { fetchClaudeLimits, quietFetch } from "../../src/limits/claude.ts";
import { CLAUDE_RESPONSE, FAKE_TOKEN, writeCredentials } from "./helpers.ts";

const [mode, dir] = process.argv.slice(2) as [string, string];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json(CLAUDE_RESPONSE),
});
const local = `http://127.0.0.1:${server.port}/api/oauth/usage`;
writeCredentials(dir, FAKE_TOKEN, Date.now() + 3_600_000);
try {
  const capture = await fetchClaudeLimits(
    { path: dir, source: "config" },
    {
      fetch:
        mode === "control"
          ? (_url, { verbose: _, ...init }) => fetch(local, init)
          : (_url, init) => quietFetch(local, init),
    },
  );
  process.stdout.write(`ok ${Object.keys(capture.rate_limits).length}\n`);
} finally {
  server.stop(true);
}
