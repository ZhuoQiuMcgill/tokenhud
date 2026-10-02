import { StoreBusy, StoreCorrupt, StoreError } from "../store/errors.ts";

/**
 * What a tool call reports when it cannot answer. The client only ever sees a plain,
 * fixed-wording message: no stack trace, no path beyond an account's root dir, never a
 * credential. The full detail of an unexpected failure goes to stderr, which only the
 * local Claude Code log keeps.
 */

export type ToolErrorCode = "bad_argument" | "unknown_account" | "store_error" | "internal";

export class ToolError extends Error {
  override name = "ToolError";
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A store failure as a fixed message: store errors can quote SQLite and file paths. */
export function storeToolError(error: StoreError): ToolError {
  if (error instanceof StoreBusy) {
    return new ToolError(
      "store_error",
      "the usage store is busy (another process is writing); try again shortly",
    );
  }
  if (error instanceof StoreCorrupt) {
    return new ToolError(
      "store_error",
      "the usage store looks damaged; run `tokenhud doctor` for details",
    );
  }
  return new ToolError(
    "store_error",
    `the usage store cannot be used (${error.name}); run \`tokenhud doctor\` for details`,
  );
}

/** Any failure as a `ToolError`; `log` gets the detail of the unexpected ones. */
export function asToolError(error: unknown, log: (message: string) => void): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof StoreError) {
    log(`store error: ${error.message}`);
    return storeToolError(error);
  }
  const name = error instanceof Error ? error.name : "error";
  log(`unexpected ${name}: ${error instanceof Error ? error.message : String(error)}`);
  return new ToolError("internal", `tokenhud failed unexpectedly (${name}); see the MCP log`);
}
