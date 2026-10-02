// The tokenhud package's preinstall (package.json: "preinstall": "node preinstall.cjs").
//
// bin/tokenhud, the command, is a POSIX sh script: on Linux and macOS it runs the binary
// with no JS runtime, and needs no install script. Windows can't run it. npm, which runs
// this under Node, links the command only after preinstall, and on Windows writes a
// tokenhud.cmd that starts the program the file's first line names. So on Windows, under
// Node, this puts lib/tokenhud.cjs (`#!/usr/bin/env node`) in its place, and the command
// runs on Node, which reads no .env or bunfig.toml. Elsewhere, and under Bun, it does
// nothing: bun makes its Windows shim before it runs any install script.
//
// It never fails the install: if the file can't be replaced, it says how to repair it.
"use strict";

const { copyFileSync, renameSync, rmSync } = require("node:fs");
const { join } = require("node:path");

if (process.platform === "win32" && !process.versions.bun) {
  const command = join(__dirname, "bin", "tokenhud");
  const tmp = `${command}.${process.pid}.tmp`;
  try {
    // A rename, so the command is never half written.
    copyFileSync(join(__dirname, "lib", "tokenhud.cjs"), tmp);
    renameSync(tmp, command);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    console.warn(
      `tokenhud: couldn't set up the Windows command (${error.message}).\n` +
        "Reinstall tokenhud, or install it with install.ps1: " +
        "https://github.com/ZhuoQiuMcgill/tokenhud#install",
    );
  }
}
