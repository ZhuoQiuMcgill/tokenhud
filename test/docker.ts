// Docker for the tests that run a real Linux userland (Alpine's BusyBox and musl, Debian's
// glibc), offline: the container has no network, and an image runs only if it is already
// here (`--pull=never`), so a test never downloads one. CI pulls them in a setup step
// (.github/workflows/ci.yml); elsewhere a test without its image is skipped, and says so.

let dockerHere: boolean | undefined;
const warned = new Set<string>();

/** Whether `image` can run here without a download: Linux, a running Docker, the image local. */
export function haveImage(image: string): boolean {
  if (process.platform !== "linux" || Bun.which("docker") === null) return false;
  dockerHere ??=
    Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (!dockerHere) return false;
  const local =
    Bun.spawnSync(["docker", "image", "inspect", image], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0;
  if (!local && !warned.has(image)) {
    warned.add(image);
    console.warn(
      `skipping the tests in ${image}: the image isn't here, and tests never download one ` +
        `(docker pull ${image} to run them)`,
    );
  }
  return local;
}

/** `docker run` for a test: removed afterwards, never pulled, no network. */
export const DOCKER_RUN = ["docker", "run", "--rm", "--pull=never", "--network", "none"];
