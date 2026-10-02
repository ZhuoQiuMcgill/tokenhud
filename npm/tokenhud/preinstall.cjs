// The tokenhud package's preinstall (package.json: "preinstall": "node preinstall.cjs").
//
// bin/tokenhud.cjs starts with `#!/usr/bin/env bun`, the one line that lets `bun add -g
// tokenhud` work on a machine without Node: bun runs no install script of a package it
// doesn't trust, so the launcher must work as published. npm (and pnpm and yarn) run this
// under Node, and link the command only after preinstall: on Windows from this line (npm
// writes a tokenhud.cmd that starts the program it names), elsewhere as a symlink whose
// first line the system reads. So under Node, the line becomes `#!/usr/bin/env node` and
// the command needs no Bun. Under Bun (when the package is trusted), nothing changes.
//
// It never fails the install: if the file can't be rewritten, it says the command needs Bun.
"use strict";

const { readFileSync, renameSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const BUN = "#!/usr/bin/env bun";
const NODE = "#!/usr/bin/env node";

if (!process.versions.bun) {
  const launcher = join(__dirname, "bin", "tokenhud.cjs");
  const tmp = `${launcher}.${process.pid}.tmp`;
  try {
    const text = readFileSync(launcher, "utf8");
    const eol = text.indexOf("\n");
    if (eol > 0 && text.slice(0, eol).replace(/\r$/, "") === BUN) {
      // A rename, so the launcher is never half written.
      writeFileSync(tmp, NODE + text.slice(eol), { mode: statSync(launcher).mode & 0o777 });
      renameSync(tmp, launcher);
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    console.warn(
      `tokenhud: couldn't switch ${launcher} to Node (${error.message});\n` +
        "the tokenhud command will need Bun (https://bun.com).",
    );
  }
}
