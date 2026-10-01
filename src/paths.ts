import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

// tokenhud's own config dir: `$XDG_CONFIG_HOME/tokenhud`, else `~/.config/tokenhud`, the
// same layout cc-usage uses for `~/.config/cc-usage`. The XDG spec says a relative
// XDG_CONFIG_HOME is invalid and must be ignored; cc-usage didn't check, but following the
// spec keeps a stray relative value from scattering config into whatever directory the
// user happens to run tokenhud in.
export function configDir(env: Env = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "tokenhud");
}

export function pricingOverridesPath(env: Env = process.env, home: string = homedir()): string {
  return join(configDir(env, home), "pricing.overrides.json");
}
