declare const self: Worker;
self.onmessage = (e: MessageEvent<string>) => {
  if (e.data === "stop") process.exit(0);
  postMessage({ from: "vm worker", url: import.meta.url, main: Bun.main });
};
