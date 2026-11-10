import { describe, expect, test } from "bun:test";
import { bashSubcommands, globMatch, isToolEvent, matchesIf, matchesTool } from "../src/matcher.ts";

describe("matchesTool", () => {
  test("empty and wildcard match everything", () => {
    expect(matchesTool(undefined, "Bash")).toBe(true);
    expect(matchesTool("", "Bash")).toBe(true);
    expect(matchesTool("*", "Bash")).toBe(true);
  });

  test("exact and list matchers", () => {
    expect(matchesTool("Bash", "Bash")).toBe(true);
    expect(matchesTool("Edit|Write", "Write")).toBe(true);
    expect(matchesTool("Edit, Write", "Edit")).toBe(true);
    expect(matchesTool("Edit", "Write")).toBe(false);
  });

  test("regex matchers", () => {
    expect(matchesTool("mcp__.*__write.*", "mcp__db__write_rows")).toBe(true);
    expect(matchesTool("^Edit$", "NotebookEdit")).toBe(false);
  });

  test("invalid regex never matches", () => {
    expect(matchesTool("[", "Bash")).toBe(false);
  });
});

describe("globMatch", () => {
  test("matches paths and wildcards", () => {
    expect(globMatch("*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("*.ts", "src/a.js")).toBe(false);
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("**/test/**", "pkg/test/a.ts")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
  });
});

describe("bashSubcommands", () => {
  test("splits commands and strips assignments", () => {
    expect(bashSubcommands("FOO=bar git push")).toEqual(["git push"]);
    expect(bashSubcommands("npm test && git push")).toEqual(["npm test", "git push"]);
    expect(bashSubcommands("echo $(rm -rf /)")).toContain("rm -rf /");
  });
});

describe("matchesIf", () => {
  test("no rule always matches", () => {
    expect(matchesIf(undefined, "Bash", { command: "rm -rf /" })).toBe(true);
    expect(matchesIf("", "Bash", { command: "rm -rf /" })).toBe(true);
  });

  test("Bash patterns match subcommands", () => {
    expect(matchesIf("Bash(git *)", "Bash", { command: "git push" })).toBe(true);
    expect(matchesIf("Bash(git *)", "Bash", { command: "FOO=1 git push" })).toBe(true);
    expect(matchesIf("Bash(git *)", "Bash", { command: "npm test && git push" })).toBe(true);
    expect(matchesIf("Bash(git *)", "Bash", { command: "npm test" })).toBe(false);
  });

  test("supports Claude's trailing :* wildcard and wrappers", () => {
    expect(matchesIf("Bash(git push:*)", "Bash", { command: "git push origin main" })).toBe(true);
    expect(matchesIf("Bash(rm *)", "Bash", { command: "echo x & rm -rf build" })).toBe(true);
    expect(matchesIf("Bash(npm test *)", "Bash", { command: "timeout 30 npm test" })).toBe(true);
    expect(matchesIf("Bash(git push *)", "Bash", { command: "git push" })).toBe(true);
  });

  test("runs the hook when a dynamic command is uncertain", () => {
    expect(matchesIf("Bash(git push *)", "Bash", { command: "echo $(date)" })).toBe(true);
    expect(matchesIf("Bash(git:*)", "Bash", { command: "$GIT status" })).toBe(true);
    expect(matchesIf("Bash(git:*)", "Bash", { command: "$(which git) status" })).toBe(true);
    for (const command of [
      "$1 status",
      "$? status",
      "$$ status",
      "$@ status",
      "$# status",
      "$! status",
      "$- status",
      "${1} status",
      "$[1+1] status",
    ]) {
      expect(matchesIf("Bash(git:*)", "Bash", { command })).toBe(true);
    }
    expect(matchesIf("Bash(rm *)", "Bash", { command: "echo $(rm -rf /)" })).toBe(true);
  });

  test("file patterns match paths", () => {
    expect(matchesIf("Edit(*.ts)", "Edit", { file_path: "src/a.ts" })).toBe(true);
    expect(matchesIf("Edit(*.ts)", "Edit", { file_path: "src/a.js" })).toBe(false);
    expect(matchesIf("Write(src/**)", "Write", { file_path: "src/a/b.ts" })).toBe(true);
  });

  test("tool name must match", () => {
    expect(matchesIf("Bash(git *)", "Edit", { command: "git push" })).toBe(false);
  });

  test("malformed rules never run", () => {
    expect(matchesIf("Bash", "Bash", { command: "git push" })).toBe(false);
    expect(matchesIf("Bash(", "Bash", { command: "git push" })).toBe(false);
  });
});

describe("isToolEvent", () => {
  test("classifies tool events", () => {
    expect(isToolEvent("PreToolUse")).toBe(true);
    expect(isToolEvent("PostToolUse")).toBe(true);
    expect(isToolEvent("PostToolUseFailure")).toBe(true);
    expect(isToolEvent("Stop")).toBe(false);
  });
});
