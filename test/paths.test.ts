import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ccUsageDir, configDir, pricingOverridesPath, storePath } from "../src/paths.ts";
import { guard } from "./guard.ts";

guard();

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
    expect(configDir({ XDG_CONFIG_HOME: join(".", "cfg") }, home)).toBe(
      join(home, ".config", "tokenhud"),
    );
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

describe("storePath", () => {
  test("is tokenhud.db in the config dir", () => {
    expect(storePath({}, home)).toBe(join(home, ".config", "tokenhud", "tokenhud.db"));
    const xdg = join("/", "srv", "cfg");
    expect(storePath({ XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, "tokenhud", "tokenhud.db"));
  });

  test("ignores a relative XDG_CONFIG_HOME, like every other tokenhud path", () => {
    expect(storePath({ XDG_CONFIG_HOME: join("relative", "cfg") }, home)).toBe(
      join(home, ".config", "tokenhud", "tokenhud.db"),
    );
  });
});

describe("ccUsageDir", () => {
  test("is ~/.config/cc-usage by default", () => {
    expect(ccUsageDir({}, home)).toBe(join(home, ".config", "cc-usage"));
    expect(ccUsageDir({ XDG_CONFIG_HOME: "" }, home)).toBe(join(home, ".config", "cc-usage"));
  });

  test("follows any XDG_CONFIG_HOME, relative too, as cc-usage did", () => {
    const xdg = join("/", "srv", "cfg");
    expect(ccUsageDir({ XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, "cc-usage"));
    expect(ccUsageDir({ XDG_CONFIG_HOME: "cfg" }, home)).toBe(join("cfg", "cc-usage"));
  });
});
