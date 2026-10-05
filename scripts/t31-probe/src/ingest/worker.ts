// The nested case: the ingest Worker starts parse Workers.
import { probe } from "./probe.ts";

declare const self: Worker;
self.onmessage = async (e: MessageEvent<string>) => {
  if (e.data === "stop") process.exit(0);
  if (e.data === "go") {
    postMessage({ from: "ingest worker", url: import.meta.url, main: Bun.main });
    return;
  }
  const ok = await probe("ingest worker");
  postMessage({ from: "ingest worker", nestedOk: ok, url: import.meta.url, main: Bun.main });
};
