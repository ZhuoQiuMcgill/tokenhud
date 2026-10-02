// The view-model Worker: owns a read-only store connection and computes every view model
// off the UI thread (T6 critic Q1). Stopped by a message, then it exits by itself; it is
// never terminate()d.
import { VmSession } from "./session.ts";
import type { VmFatal, VmMessage, VmRequest } from "./types.ts";

declare const self: Worker;

const post = (message: VmMessage | VmFatal) => postMessage(message);
let session: VmSession | null = null;

// An error nothing caught ends this Worker; the supervisor restarts it. Say why first, as
// one line: Bun's own error event carries a source excerpt instead.
const fatal = (error: unknown) => {
  const message = error instanceof Error ? error.message : `uncaught ${String(error)}`;
  post({ type: "fatal", message: message.split("\n")[0] as string });
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

self.onmessage = (event: MessageEvent<VmRequest>) => {
  const request = event.data;
  if (request.type === "start") {
    if (session !== null) return;
    session = new VmSession(request, post);
    session.begin();
  } else if (request.type === "stop") {
    session?.close();
    post({ type: "stopped" });
    self.onmessage = null;
    process.exit(0);
  } else {
    session?.handle(request);
  }
};
