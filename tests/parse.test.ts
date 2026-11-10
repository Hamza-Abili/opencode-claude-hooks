import { describe, expect, test } from "bun:test";
import {
  frontmatterHooks,
  normalizeHandler,
  parseFrontmatter,
  parsePluginHooksFile,
  parseSettingsHooks,
} from "../src/parse.ts";

describe("parseSettingsHooks", () => {
  test("parses events, matchers and handlers", () => {
    const parsed = parseSettingsHooks(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "echo ok", timeout: 5, if: "Bash(git *)" },
                { type: "http", url: "https://example.com/hook" },
              ],
            },
          ],
        },
      },
      "settings.json"
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.event).toBe("PreToolUse");
    expect(parsed.entries[0]?.group.matcher).toBe("Bash");
    expect(parsed.entries[0]?.group.hooks).toHaveLength(2);
    expect(parsed.entries[0]?.group.hooks[0]).toMatchObject({
      type: "command",
      command: "echo ok",
      timeout: 5,
      if: "Bash(git *)",
    });
  });

  test("reports unsupported events without dropping known ones", () => {
    const parsed = parseSettingsHooks(
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }],
          UserPromptExpansion: [{ hooks: [{ type: "command", command: "true" }] }],
          NotARealEvent: [{ hooks: [{ type: "command", command: "true" }] }],
        },
      },
      "settings.json"
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.unsupportedEvents).toContain("UserPromptExpansion");
    expect(parsed.unsupportedEvents).toContain("NotARealEvent");
    expect(parsed.warnings.some((warning) => warning.includes("unknown hook event"))).toBe(true);
  });

  test("reports mcp_tool and agent handlers", () => {
    const parsed = parseSettingsHooks(
      {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "mcp_tool", server: "x", tool: "y" },
                { type: "agent", prompt: "x" },
              ],
            },
          ],
        },
      },
      "settings.json"
    );
    expect(parsed.unsupportedHandlers).toHaveLength(2);
    expect(parsed.entries[0]?.group.hooks.map((hook) => hook.type)).toEqual(["mcp_tool", "agent"]);
  });

  test("parses hooks even when disableAllHooks is set; discovery merges it", () => {
    const parsed = parseSettingsHooks(
      {
        disableAllHooks: true,
        hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
      },
      "settings.json"
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.disabledAll).toBe(false);
  });

  test("invalid files produce warnings, not throws", () => {
    expect(parseSettingsHooks(null, "x").warnings).toHaveLength(1);
    expect(parseSettingsHooks({ hooks: { Stop: "nope" } }, "x").warnings).toHaveLength(1);
    expect(parseSettingsHooks({ hooks: { Stop: [null] } }, "x").warnings).toHaveLength(1);
  });
});

describe("normalizeHandler", () => {
  test("keeps valid fields and drops invalid ones", () => {
    const result = normalizeHandler({
      type: "command",
      command: "run",
      args: ["a", 2],
      timeout: -1,
      shell: "fish",
      once: "yes",
      onFailure: "explode",
    });
    expect(result).toMatchObject({
      type: "command",
      command: "run",
      args: ["a"],
    });
    expect((result as { timeout?: number }).timeout).toBeUndefined();
    expect((result as { shell?: string }).shell).toBeUndefined();
    expect((result as { once?: boolean }).once).toBeUndefined();
    expect((result as { onFailure?: string }).onFailure).toBeUndefined();
  });

  test("rejects command without command", () => {
    expect(normalizeHandler({ type: "command" }).type).toBe("unknown");
  });

  test("rejects non-http urls", () => {
    expect(normalizeHandler({ type: "http", url: "file:///etc/passwd" }).type).toBe("unknown");
  });

  test("rejects prompt without text", () => {
    expect(normalizeHandler({ type: "prompt", prompt: "" }).type).toBe("unknown");
  });

  test("rejects plugin user_config placeholders", () => {
    expect(normalizeHandler({ type: "command", command: "node ${user_config.script}" }).type).toBe(
      "unknown"
    );
    expect(
      normalizeHandler({ type: "command", command: "node", args: ["${user_config.script}"] }).type
    ).toBe("unknown");
  });
});

describe("parsePluginHooksFile", () => {
  test("accepts a wrapped hooks file", () => {
    const parsed = parsePluginHooksFile(
      { description: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } },
      "hooks.json"
    );
    expect(parsed.entries).toHaveLength(1);
  });

  test("accepts a bare event map", () => {
    const parsed = parsePluginHooksFile(
      { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
      "hooks.json"
    );
    expect(parsed.entries).toHaveLength(1);
  });

  test("rejects unrelated JSON", () => {
    expect(parsePluginHooksFile({ nope: true }, "hooks.json").warnings).toHaveLength(1);
  });
});

describe("frontmatter", () => {
  test("parses YAML frontmatter and body", () => {
    const result = parseFrontmatter(
      "---\nname: review\nhooks:\n  Stop:\n    - hooks: []\n---\nBody\n"
    );
    expect(result?.data.name).toBe("review");
    expect(result?.body.trim()).toBe("Body");
  });

  test("returns undefined without frontmatter", () => {
    expect(parseFrontmatter("# Title")).toBeUndefined();
    expect(parseFrontmatter("---\nno end")).toBeUndefined();
  });

  test("extracts skill hooks and name", () => {
    const parsed = frontmatterHooks(
      "---\nname: secure\ndescription: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n---\n# Skill\n",
      "SKILL.md"
    );
    expect(parsed.name).toBe("secure");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.group.matcher).toBe("Bash");
  });

  test("frontmatter without hooks is empty, not an error", () => {
    const parsed = frontmatterHooks("---\nname: x\n---\n", "SKILL.md");
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.name).toBe("x");
  });
});
