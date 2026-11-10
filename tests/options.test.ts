import { describe, expect, test } from "bun:test";
import { expandPath, parseOptions } from "../src/options.ts";

describe("parseOptions", () => {
  test("uses secure defaults", () => {
    const result = parseOptions(undefined, "/work/app", "/home/test");
    expect(result.trust).toBe("user");
    expect(result.trusted).toEqual([]);
    expect(result.allowHttpHooks).toBe(true);
    expect(result.allowPromptHooks).toBe(false);
    expect(result.inheritEnv).toBe(false);
    expect(result.defaultTimeoutSec).toBe(600);
    expect(result.maxOutputBytes).toBe(1024 * 1024);
  });

  test("ignores unknown trust modes", () => {
    expect(parseOptions({ trust: "yolo" }, "/work", "/home/test").trust).toBe("user");
    expect(parseOptions({ trust: "all" }, "/work", "/home/test").trust).toBe("all");
  });

  test("expands source and plugin paths", () => {
    const result = parseOptions(
      { sources: ["~/settings.json", "./local.json"], plugins: ["plugins/one"] },
      "/work/app",
      "/home/test"
    );
    expect(result.sources).toEqual(["/home/test/settings.json", "/work/app/local.json"]);
    expect(result.plugins).toEqual(["/work/app/plugins/one"]);
  });

  test("expands ~ and absolute paths", () => {
    expect(expandPath("~", "/work", "/home/test")).toBe("/home/test");
    expect(expandPath("~/x", "/work", "/home/test")).toBe("/home/test/x");
    expect(expandPath("/etc/x", "/work", "/home/test")).toBe("/etc/x");
  });

  test("parses prompt models in both shapes", () => {
    expect(parseOptions({ promptModel: "openai/gpt-5" }, "/work").promptModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
    expect(
      parseOptions({ promptModel: { providerID: "anthropic", modelID: "claude" } }, "/work")
        .promptModel
    ).toEqual({ providerID: "anthropic", modelID: "claude" });
    expect(
      parseOptions({ promptModel: { provider: "x", model: "y" } }, "/work").promptModel
    ).toEqual({
      providerID: "x",
      modelID: "y",
    });
    expect(parseOptions({ promptModel: "broken" }, "/work").promptModel).toBeUndefined();
  });

  test("clamps numeric limits", () => {
    const low = parseOptions(
      { defaultTimeoutSec: 0, maxOutputBytes: 1, maxStopContinuations: -1 },
      "/w"
    );
    expect(low.defaultTimeoutSec).toBe(1);
    expect(low.maxOutputBytes).toBe(1024);
    expect(low.maxStopContinuations).toBe(0);
    const high = parseOptions({ maxTimeoutSec: 999_999 }, "/w");
    expect(high.maxTimeoutSec).toBe(86_400);
  });

  test("filters disabled events to known names", () => {
    const result = parseOptions({ disabledEvents: ["PreToolUse", "Bogus"] }, "/w");
    expect(result.disabledEvents).toEqual(["PreToolUse"]);
  });

  test("keeps string env values only", () => {
    const result = parseOptions({ env: { A: "1", B: 2 } }, "/w");
    expect(result.env).toEqual({ A: "1" });
  });

  test("invalid values never disable security defaults", () => {
    const result = parseOptions(
      { allowHttpHooks: "no", inheritEnv: "yes", trusted: "not-an-array" },
      "/w"
    );
    expect(result.allowHttpHooks).toBe(true);
    expect(result.inheritEnv).toBe(false);
    expect(result.trusted).toEqual([]);
  });
});
