// The TUI with a view that throws when drawn (the History view, key 2), for the pty check
// that a crash restores the terminal (T10 AC 3).
import { VIEWS } from "../../../src/tui/views/index.ts";

VIEWS.history.sections = () => {
  throw new Error("simulated crash in a view");
};
const { runTui } = await import("../../../src/tui/main.ts");
process.exit(await runTui());
