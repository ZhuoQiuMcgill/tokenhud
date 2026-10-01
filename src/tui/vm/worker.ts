// The view-model Worker: owns a read-only store connection and computes every view model
// off the UI thread (T6 critic Q1). Stopped by a message, then it exits by itself; it is
// never terminate()d.
import { VmSession } from "./session.ts";
import type { VmMessage, VmRequest } from "./types.ts";

declare const self: Worker;

const post = (message: VmMessage) => postMessage(message);
let session: VmSession | null = null;

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
