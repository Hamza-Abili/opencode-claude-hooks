import { describe, expect, test } from "bun:test";
import {
  claudeToolInput,
  claudeToolName,
  opencodeToolInput,
  toolResponsePreview,
} from "../src/tools.ts";

describe("claudeToolName", () => {
  test("maps built-in tools", () => {
    expect(claudeToolName("shell")).toBe("Bash");
    expect(claudeToolName("edit")).toBe("Edit");
    expect(claudeToolName("write")).toBe("Write");
    expect(claudeToolName("webfetch")).toBe("WebFetch");
    expect(claudeToolName("task")).toBe("Task");
  });

  test("maps MCP tools with the longest server prefix", () => {
    expect(claudeToolName("db_query", ["db"])).toBe("mcp__db__query");
    expect(claudeToolName("my_db_query", ["my", "my_db"])).toBe("mcp__my_db__query");
  });

  test("keeps unknown tools unchanged", () => {
    expect(claudeToolName("custom_tool")).toBe("custom_tool");
  });
});

describe("claudeToolInput", () => {
  test("translates shell arguments", () => {
    expect(claudeToolInput("shell", { command: "ls", timeout: 5, background: true })).toEqual({
      command: "ls",
      timeout: 5,
      run_in_background: true,
    });
  });

  test("translates edit, write and read", () => {
    expect(
      claudeToolInput("edit", { path: "a.ts", oldString: "a", newString: "b", replaceAll: true })
    ).toEqual({ file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true });
    expect(claudeToolInput("write", { path: "a.ts", content: "x" })).toEqual({
      file_path: "a.ts",
      content: "x",
    });
    expect(claudeToolInput("read", { path: "a.ts", offset: 1, limit: 2 })).toEqual({
      file_path: "a.ts",
      offset: 1,
      limit: 2,
    });
  });

  test("translates grep glob", () => {
    expect(claudeToolInput("grep", { pattern: "x", path: "src", include: "*.ts" })).toEqual({
      pattern: "x",
      path: "src",
      glob: "*.ts",
    });
  });

  test("keeps unknown input unchanged", () => {
    expect(claudeToolInput("custom", { a: 1 })).toEqual({ a: 1 });
  });

  test("supports the V1 filePath dialect", () => {
    expect(
      claudeToolInput("edit", { filePath: "a.ts", oldString: "a", newString: "b" }, "v1")
    ).toMatchObject({ file_path: "a.ts", old_string: "a", new_string: "b" });
    expect(
      opencodeToolInput("edit", "Edit", { file_path: "b.ts" }, { filePath: "a.ts" }, "v1")
    ).toMatchObject({ filePath: "b.ts" });
  });
});

describe("opencodeToolInput", () => {
  test("merges updated shell fields into the original", () => {
    expect(
      opencodeToolInput(
        "shell",
        "Bash",
        { command: "ls", timeout: 3 },
        { command: "old", workdir: "/x" }
      )
    ).toEqual({
      command: "ls",
      workdir: "/x",
      timeout: 3,
    });
  });

  test("translates edit fields", () => {
    expect(
      opencodeToolInput(
        "edit",
        "Edit",
        { file_path: "b.ts", new_string: "y" },
        { path: "a.ts", oldString: "x" }
      )
    ).toEqual({ path: "b.ts", oldString: "x", newString: "y", replaceAll: undefined });
  });

  test("passes through MCP args", () => {
    expect(
      opencodeToolInput("db_query", "mcp__db__query", { sql: "select 1" }, { sql: "" })
    ).toEqual({
      sql: "select 1",
    });
  });

  test("ignores updates for unknown tools", () => {
    expect(opencodeToolInput("custom", "Custom", { x: 1 }, {})).toBeUndefined();
  });

  test("ignores empty updates", () => {
    expect(opencodeToolInput("shell", "Bash", {}, {})).toBeUndefined();
  });
});

describe("toolResponsePreview", () => {
  test("stringifies and truncates", () => {
    expect(toolResponsePreview("abc", 2)).toBe("ab");
    expect(toolResponsePreview({ a: 1 })).toBe('{"a":1}');
  });
});
