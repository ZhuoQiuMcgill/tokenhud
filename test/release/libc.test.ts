// install.sh picks the musl or glibc binary by asking the host's C library, not by finding
// a musl loader on disk (T14 critique m2). Its `host_libc` function runs in two real hosts:
// Alpine (musl) and Debian (glibc), each also with a musl loader added, offline. Linux with
// Docker only; CI's Linux runner has it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(import.meta.dir, "..", "..", "install.sh"), "utf8");
const hostLibc = /^host_libc\(\) \{\n[\s\S]*?\n\}$/m.exec(script)?.[0] ?? "";

function docker(): boolean {
  if (process.platform !== "linux" || Bun.which("docker") === null) return false;
  return Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/** host_libc's answer in `image`, before and after a musl loader appears in /lib. */
async function answers(image: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      image,
      "sh",
      "-c",
      `${hostLibc}\nhost_libc\ntouch "/lib/ld-musl-$(uname -m).so.1"\nhost_libc`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out.trim().split("\n");
}

describe.skipIf(!docker())("install.sh's libc detection, on real hosts", () => {
  test("the function is there to test", () => {
    expect(hostLibc).toContain("getconf GNU_LIBC_VERSION");
  });

  test("Alpine is musl", async () => {
    expect(await answers("alpine:3.22")).toEqual(["musl", "musl"]);
  }, 120_000);

  test("Debian is glibc, even with a musl loader installed", async () => {
    expect(await answers("debian:13-slim")).toEqual(["glibc", "glibc"]);
  }, 120_000);
});
