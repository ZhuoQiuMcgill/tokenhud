// A stand-in for `tokenhud mcp`, for scripts/mcp-smoke.ts's tests: `bun fake-mcp.ts <mode>
// mcp`. Mode `ok` answers as tokenhud does; each other mode goes wrong in one way. It writes
// its pid to $HOME/fake-mcp.pid, so a test can check that it was stopped.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = Bun.argv[2] ?? "ok";
const TOOLS = ["limits", "should_wait", "wait_for_reset", "usage", "accounts"];

writeFileSync(join(process.env.HOME ?? ".", "fake-mcp.pid"), String(process.pid));

if (mode === "crash") {
  process.stderr.write("fake-mcp: crashed on start\n");
  process.exit(1);
}
if (mode === "noise") process.stdout.write("a stray log line on stdout\n");

const reply = (id: unknown, result: object) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

function answer(message: { id?: unknown; method?: string }): void {
  switch (message.method) {
    case "initialize":
      if (mode === "hang") return;
      reply(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tokenhud", version: "0.0.0" },
      });
      return;
    case "tools/list": {
      const names = mode === "missing-tool" ? TOOLS.filter((t) => t !== "wait_for_reset") : TOOLS;
      reply(message.id, {
        tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
      });
      return;
    }
    case "tools/call": {
      if (mode === "accounts-error") {
        reply(message.id, { content: [{ type: "text", text: "store unreadable" }], isError: true });
        return;
      }
      const accounts = [
        { label: "personal", provider: "claude" },
        { label: "codex", provider: "codex" },
      ];
      reply(message.id, {
        content: [{ type: "text", text: JSON.stringify({ accounts }) }],
        structuredContent: { accounts },
      });
      return;
    }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    answer(JSON.parse(buffer.slice(0, at)));
    buffer = buffer.slice(at + 1);
  }
});
process.stdin.on("end", () => {
  // Keeps running until it is killed.
  if (mode === "slow-exit") setInterval(() => {}, 1000);
  else process.exit(mode === "bad-exit" ? 3 : 0);
});
