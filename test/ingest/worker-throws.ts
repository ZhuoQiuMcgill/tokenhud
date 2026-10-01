// A parse Worker that throws on the work it is sent, without replying.
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ type: string }>) => {
  if (event.data.type === "stop") process.exit(0);
  throw new Error("parse worker test failure");
};
