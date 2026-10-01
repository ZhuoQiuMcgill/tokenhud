// Bun's bundler inlines JSON imports, so `bun build --compile` bakes the version into the
// binary at build time; the compiled program never reads package.json at runtime.
import { version } from "../package.json";

export const VERSION: string = version;
