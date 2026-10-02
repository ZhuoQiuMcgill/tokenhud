#!/usr/bin/env node
// The `tokenhud` command of the npm package: finds the platform package npm installed as an
// optional dependency (@tokenhud/<platform>-<arch>[-musl]) and runs its binary with the same
// arguments, exit code and signals. tokenhud itself is a standalone binary; Node only
// launches it.

const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const SUPPORTED = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
];

/** Whether this Linux runs on musl (Alpine), as npm decides it for the `libc` field. */
function isMusl() {
  try {
    const ldd = readFileSync("/usr/bin/ldd", "latin1");
    if (ldd.includes("musl")) return true;
    if (ldd.includes("GNU C Library") || ldd.includes("glibc")) return false;
  } catch {}
  try {
    process.report.excludeNetwork = true;
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function candidates() {
  const base = `${process.platform}-${process.arch}`;
  if (process.platform !== "linux") return [base];
  // npm installs only the package for this libc; an npm too old to read `libc` installs
  // both, and the matching one goes first.
  return isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`];
}

function findBinary() {
  const exe = process.platform === "win32" ? "tokenhud.exe" : "tokenhud";
  for (const id of candidates()) {
    if (!SUPPORTED.includes(id)) continue;
    try {
      return join(dirname(require.resolve(`@tokenhud/${id}/package.json`)), "bin", exe);
    } catch {}
  }
  return null;
}

const id = candidates()[0];
if (!SUPPORTED.includes(id)) {
  console.error(
    `tokenhud: there is no tokenhud binary for ${id}. Supported: ${SUPPORTED.join(", ")}.`,
  );
  process.exit(1);
}

const bin = findBinary();
if (bin === null) {
  console.error(
    `tokenhud: the package with the tokenhud binary for this machine, @tokenhud/${id},\n` +
      "is not installed. npm installs it as an optional dependency, so it is missing when\n" +
      "optional dependencies were skipped (--omit=optional, --no-optional, or a lockfile\n" +
      "made on another platform). Reinstall tokenhud the same way, without --omit=optional:\n" +
      "  npm install -g tokenhud      (a global install)\n" +
      "  npm install tokenhud         (in a project)\n" +
      "or install the binary directly: https://github.com/ZhuoQiuMcgill/tokenhud#install",
  );
  process.exit(1);
}

// Signals that stop this launcher stop tokenhud: each is passed on to it. Windows sends
// Ctrl-C, Ctrl-Break and a closing console window as SIGINT, SIGBREAK and SIGHUP.
const FORWARD =
  process.platform === "win32"
    ? ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];

let child = null;
const running = () => child !== null && child.exitCode === null && child.signalCode === null;

// Registered before tokenhud starts. A runtime can hand a handler to the OS a moment after
// `process.on` returns (Bun does), and a signal landing in that moment, with tokenhud already
// running, would kill this launcher and leave tokenhud running on its own.
for (const signal of FORWARD) {
  try {
    process.on(signal, () => {
      if (running()) child.kill(signal);
    });
  } catch {
    // A signal this runtime can't listen for on this platform.
  }
}
// However this launcher ends (an uncaught error, a forced exit), tokenhud doesn't outlive it.
process.on("exit", () => {
  if (running()) child.kill("SIGTERM");
});

child = spawn(bin, process.argv.slice(2), { stdio: "inherit", windowsHide: false });

child.on("error", (error) => {
  console.error(`tokenhud: couldn't start ${bin}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    // Die of the same signal, so whoever started this launcher sees what stopped tokenhud.
    for (const s of FORWARD) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
