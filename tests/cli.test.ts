import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  test("--trust none does not consume the next flag", () => {
    const args = parseArgs(["--trust", "none", "--json"]);
    expect(args.trust).toBe("none");
    expect(args.json).toBe(true);
  });

  test("supports all trust modes", () => {
    expect(parseArgs(["--trust", "all"]).trust).toBe("all");
    expect(parseArgs(["--trust", "prompt"]).trust).toBe("prompt");
    expect(parseArgs(["--trust", "user"]).trust).toBe("user");
  });

  test("unknown trust modes fall back to user", () => {
    expect(parseArgs(["--trust", "banana"]).trust).toBe("user");
    expect(parseArgs(["--trust"]).trust).toBe("user");
  });
});
