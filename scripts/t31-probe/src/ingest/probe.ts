const BUNDLE_ROOT = /^(.*?[/\\](?:\$bunfs|~BUN)[/\\]root[/\\])/;
function currentWorkerUrl(fromSrc: string, base: string = import.meta.url): string {
  const bundled = BUNDLE_ROOT.exec(base);
  if (bundled !== null) return `${bundled[1]}${fromSrc}`;
  return new URL(`../${fromSrc}`, base).href;
}

function candidates(fromSrc: string): Array<[string, string]> {
  const posix = Bun.main.startsWith("/$bunfs/");
  const js = fromSrc.replace(/\.ts$/, ".js");
  const out: Array<[string, string]> = [["current workerUrl", currentWorkerUrl(fromSrc)]];
  if (posix) {
    out.push(["posix path .ts", `/$bunfs/root/${fromSrc}`]);
    out.push(["posix file url .ts", `file:///$bunfs/root/${fromSrc}`]);
    out.push(["posix path .js", `/$bunfs/root/${js}`]);
  } else {
    out.push(["win fwd path .ts", `B:/~BUN/root/${fromSrc}`]);
    out.push(["win back path .ts", `B:\\~BUN\\root\\${fromSrc.replaceAll("/", "\\")}`]);
    out.push(["win file url .ts", `file:///B:/~BUN/root/${fromSrc}`]);
    out.push(["win fwd path .js", `B:/~BUN/root/${js}`]);
    out.push(["win back path .js", `B:\\~BUN\\root\\${js.replaceAll("/", "\\")}`]);
  }
  out.push(["dot relative .ts", `./${fromSrc}`]);
  return out;
}

function attempt(spec: string, message = "go"): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s);
    };
    const timer = setTimeout(() => finish("TIMEOUT"), 8000);
    let w: Worker;
    try {
      w = new Worker(spec);
    } catch (e) {
      finish(`THROW ${String(e).split("\n")[0]}`);
      return;
    }
    w.onmessage = (e) => {
      finish(`OK ${JSON.stringify(e.data)}`);
      w.postMessage("stop");
    };
    w.onerror = (e) => finish(`ERR ${String(e.message).split("\n")[0]}`);
    w.addEventListener("close", (e) => finish(`CLOSE ${(e as CloseEvent).code}`));
    w.postMessage(message);
  });
}

export async function probe(thread: string): Promise<boolean> {
  console.log(
    JSON.stringify({
      where: `chunk (${thread})`,
      url: import.meta.url,
      path: import.meta.path,
      dir: import.meta.dir,
      main: Bun.main,
      pathname: (() => {
        try {
          return new URL(import.meta.url).pathname;
        } catch (e) {
          return String(e);
        }
      })(),
      fileURLToPath: (() => {
        try {
          return Bun.fileURLToPath(import.meta.url);
        } catch (e) {
          return String(e);
        }
      })(),
    }),
  );
  const targets =
    thread === "main thread"
      ? ["tui/vm/worker.ts", "ingest/worker.ts"]
      : ["ingest/parse-worker.ts"];
  let any = false;
  let ingestSpec: string | null = null;
  for (const fromSrc of targets) {
    for (const [name, spec] of candidates(fromSrc)) {
      const result = await attempt(spec);
      if (result.startsWith("OK")) {
        any = true;
        if (fromSrc === "ingest/worker.ts") ingestSpec ??= spec;
      }
      console.log(`[${thread}] ${fromSrc} | ${name} | ${JSON.stringify(spec)} -> ${result}`);
    }
  }
  if (ingestSpec !== null) {
    console.log(`[${thread}] nested, via ${JSON.stringify(ingestSpec)}:`);
    console.log(`[${thread}] nested -> ${await attempt(ingestSpec, "nested")}`);
  }
  return any;
}
