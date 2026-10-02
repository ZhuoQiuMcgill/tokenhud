// The real view-model Worker with one injected fault, for test/tui/supervisor.test.tsx. The
// fault rides in the start message (`testFault: {kind, marker}`), since a Worker doesn't see
// environment changes made after its process started:
// - "throw", "reject", "exit": after the first view models, an uncaught throw, an
//   unhandled rejection or `process.exit(3)`, once (the marker file records it), so the
//   restarted Worker runs normally;
// - "always": a throw on every start, before any view model.
import { existsSync, writeFileSync } from "node:fs";
import "../../../src/tui/vm/worker.ts";

declare const self: Worker;

type Fault = { kind: string; marker: string };
const real = self.onmessage as (event: MessageEvent) => void;

function fault(kind: string): void {
  if (kind === "throw" || kind === "always") throw new Error("injected fault");
  if (kind === "reject") void Promise.reject(new Error("injected rejection"));
  if (kind === "exit") process.exit(3);
}

self.onmessage = (event: MessageEvent<{ type: string; testFault?: Fault }>) => {
  const spec = event.data.type === "start" ? (event.data.testFault ?? null) : null;
  if (spec?.kind === "always") fault("always");
  real(event);
  if (spec !== null && !existsSync(spec.marker)) {
    writeFileSync(spec.marker, "");
    setTimeout(() => fault(spec.kind), 50);
  }
};
