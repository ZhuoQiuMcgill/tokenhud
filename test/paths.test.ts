import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { configDir, pricingOverridesPath } from "../src/paths.ts";

const home = join("/", "home", "someone");

describe("configDir", () => {
  test("defaults to ~/.config/tokenhud", () => {
    expect(configDir({}, home)).toBe(join(home, ".config", "tokenhud"));
  });

  test("honours an absolute XDG_CONFIG_HOME", () => {
    const xdg = join("/", "srv", "cfg");
    expect(configDir({ XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, "tokenhud"));
  });

  test("ignores an empty or relative XDG_CONFIG_HOME, as the XDG spec requires", () => {
    expect(configDir({ XDG_CONFIG_HOME: "" }, home)).toBe(join(home, ".config", "tokenhud"));
    expect(configDir({ XDG_CONFIG_HOME: "cfg" }, home)).toBe(join(home, ".config", "tokenhud"));
  });

  test("reads the real environment by default", () => {
    expect(configDir()).toEndWith("tokenhud");
  });
});

test("pricingOverridesPath is in the config dir", () => {
  expect(pricingOverridesPath({}, home)).toBe(
    join(home, ".config", "tokenhud", "pricing.overrides.json"),
  );
});
