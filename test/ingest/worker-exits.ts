// A parse Worker that exits as soon as it is sent work, without replying.
declare const self: Worker;

self.onmessage = () => {
  process.exit(0);
};
