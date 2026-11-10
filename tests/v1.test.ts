import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { server } from "../src/v1.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

async function setup(settings: unknown, options: Record<string, unknown> = { trust: "all" }) {
  const directory = await tempDir("och-v1-");
  const home = join(directory, "home");
  await writeJson(join(directory, ".claude", "settings.json"), settings);
  const hooks = await server({ directory }, options, { home });
  return { hooks, directory };
}

const parts = () => [{ id: "p", sessionID: "s", messageID: "m", type: "text", text: "hello" }];

describe("V1 adapter", () => {
  test("SessionStart continue:false stops the prompt", async () => {
    const { hooks } = await setup({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: 'printf \'%s\' \'{"continue":false,"stopReason":"halt-start"}\'',
              },
            ],
          },
        ],
      },
    });
    await expect(hooks["chat.message"]?.({ sessionID: "s" }, { parts: parts() })).rejects.toThrow(
      "halt-start"
    );
  });

  test("adds UserPromptSubmit context", async () => {
    const { hooks } = await setup({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command:
                  'printf \'%s\' \'{"hookSpecificOutput":{"additionalContext":"remember"}}\'',
              },
            ],
          },
        ],
      },
    });
    const output = { parts: parts() };
    await hooks["chat.message"]?.({ sessionID: "s" }, output as never);
    expect((output.parts[0] as { text: string }).text).toContain("<claude-hooks-context>");
    expect((output.parts[0] as { text: string }).text).toContain("remember");
    expect((output.parts[0] as { text: string }).text).toEndWith("hello");
  });

  test("blocks a prompt with a thrown error", async () => {
    const { hooks } = await setup({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: 'printf \'%s\' \'{"decision":"block","reason":"nope"}\'',
              },
            ],
          },
        ],
      },
    });
    await expect(hooks["chat.message"]?.({ sessionID: "s" }, { parts: parts() })).rejects.toThrow(
      "nope"
    );
  });

  test("denies a tool call", async () => {
    const { hooks } = await setup({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  'printf \'%s\' \'{"permissionDecision":"deny","permissionDecisionReason":"no"}\'',
              },
            ],
          },
        ],
      },
    });
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "rm -rf /" } }
      )
    ).rejects.toThrow("no");
  });

  test("applies updatedInput", async () => {
    const { hooks } = await setup({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  'printf \'%s\' \'{"hookSpecificOutput":{"updatedInput":{"command":"echo changed"}}}\'',
              },
            ],
          },
        ],
      },
    });
    const output = { args: { command: "ls" } };
    await hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "s", callID: "c" }, output);
    expect(output.args).toEqual({ command: "echo changed" });
  });

  test("handles V1 filePath edits and if rules", async () => {
    const { hooks } = await setup({
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command:
                  'printf \'%s\' \'{"permissionDecision":"deny","permissionDecisionReason":"no-ts"}\'',
                if: "Edit(*.ts)",
              },
            ],
          },
        ],
      },
    });
    const js = { args: { filePath: "a.js", oldString: "a", newString: "b" } };
    await hooks["tool.execute.before"]?.({ tool: "edit", sessionID: "s", callID: "c" }, js);
    const ts = { args: { filePath: "a.ts", oldString: "a", newString: "b" } };
    await expect(
      hooks["tool.execute.before"]?.({ tool: "edit", sessionID: "s", callID: "c" }, ts)
    ).rejects.toThrow("no-ts");
  });

  test("applies V1 filePath updatedInput", async () => {
    const { hooks } = await setup({
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command:
                  'printf \'%s\' \'{"hookSpecificOutput":{"updatedInput":{"file_path":"b.ts"}}}\'',
              },
            ],
          },
        ],
      },
    });
    const output = { args: { filePath: "a.ts", oldString: "a", newString: "b" } };
    await hooks["tool.execute.before"]?.({ tool: "edit", sessionID: "s", callID: "c" }, output);
    expect(output.args.filePath).toBe("b.ts");
    expect(output.args.oldString).toBe("a");
  });

  test("activates agent frontmatter hooks", async () => {
    const directory = await tempDir("och-v1-agent-");
    const home = join(directory, "home");
    await writeJson(join(directory, ".claude", "settings.json"), {});
    await writeText(
      join(home, ".claude", "agents", "reviewer.md"),
      '---\nname: reviewer\nhooks:\n  PreToolUse:\n    - matcher: Edit\n      hooks:\n        - type: command\n          command: "printf \'%s\' \'{\\"permissionDecision\\":\\"deny\\",\\"permissionDecisionReason\\":\\"agent-no\\"}\'"\n---\n'
    );
    const hooks = await server({ directory }, { trust: "all" }, { home });
    await hooks["chat.message"]?.({ sessionID: "s", agent: "reviewer" }, { parts: parts() });
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "edit", sessionID: "s", callID: "c" },
        { args: { filePath: "a.ts", oldString: "a", newString: "b" } }
      )
    ).rejects.toThrow("agent-no");
  });

  test("continue:false denies a V1 tool call", async () => {
    const { hooks } = await setup({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: 'printf \'%s\' \'{"continue":false,"stopReason":"halt"}\'',
              },
            ],
          },
        ],
      },
    });
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "ls" } }
      )
    ).rejects.toThrow("halt");
  });

  test("appends PostToolUse context", async () => {
    const { hooks } = await setup({
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: 'printf \'%s\' \'{"hookSpecificOutput":{"additionalContext":"lint"}}\'',
              },
            ],
          },
        ],
      },
    });
    const output = { title: "shell", output: "done", metadata: {} };
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "s", callID: "c", args: { command: "ls" } },
      output
    );
    expect(output.output).toContain("done");
    expect(output.output).toContain("lint");
  });

  test("injects SessionStart system context once", async () => {
    const { hooks } = await setup({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: 'printf \'%s\' \'{"hookSpecificOutput":{"additionalContext":"startup"}}\'',
              },
            ],
          },
        ],
      },
    });
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s" }, output);
    expect(output.system).toHaveLength(1);
    const second = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s" }, second);
    expect(second.system).toHaveLength(0);
  });

  test("Stop hooks are evaluated on session.idle", async () => {
    const { hooks } = await setup({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: 'printf \'%s\' \'{"decision":"block","reason":"again"}\'',
              },
            ],
          },
        ],
      },
    });
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s" }, { system: [] });
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s" } } });
  });

  test("SessionEnd fires on session.deleted", async () => {
    const { hooks } = await setup({
      hooks: {
        SessionEnd: [{ hooks: [{ type: "command", command: "printf x >> ended.txt" }] }],
      },
    });
    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "s" } } } });
  });
});
