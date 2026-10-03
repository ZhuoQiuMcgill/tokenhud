// The steps of quitting (T22). A step that throws stops neither the steps after it nor the
// exit, and it is never silent: once every step has run, the failures go to the log and, on
// one line, to stderr, and a quit that would have exited 0 exits 1.
import { errorLine, type Log } from "./log.ts";

export class QuitSteps {
  readonly #failed: string[] = [];

  /** Runs `step`, named `name` in the report; a throw or a rejection gives `undefined`. */
  async run<T>(name: string, step: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch (error) {
      this.#failed.push(`${name} failed: ${errorLine(String(error))}`);
      return undefined;
    }
  }

  /**
   * Reports the failed steps, if any: to `log`, and as one line to `stderr`. Returns the
   * exit code: `code`, but 1 for a quit (0) that had a step fail. A crash (1) or a signal
   * (128 + n) keeps its own.
   */
  finish(code: number, log: Log, stderr: (line: string) => void): number {
    if (this.#failed.length === 0) return code;
    const line = `quitting: ${this.#failed.join("; ")}`;
    log.write("error", line);
    stderr(`tokenhud: ${line}\n`);
    return code === 0 ? 1 : code;
  }
}
