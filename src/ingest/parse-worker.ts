// A parse Worker of the ingest pool: reads the transcripts it is sent and posts back
// their per-key entries. It is stopped by a message, after which it exits on its own;
// the pool never calls terminate().
import { clearParentStreams } from "../sources/codex.ts";
import { type ReadContext, type ReadTask, readTask } from "./read.ts";

declare const self: Worker;

export type ParseRequest =
  | { type: "read"; id: number; tasks: ReadTask[]; context: ReadContext }
  | { type: "stop" };

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const message = event.data;
  if (message.type === "stop") {
    self.onmessage = null;
    process.exit(0);
  }
  clearParentStreams();
  const results = message.tasks.map((task) => readTask(task, message.context));
  postMessage({ type: "results", id: message.id, results });
};
