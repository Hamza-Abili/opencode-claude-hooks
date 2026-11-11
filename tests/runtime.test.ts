import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HookRuntime } from "../src/runtime.ts";
import { hookFingerprint } from "../src/trust.ts";
import type { HookHandler, HookSource, Options } from "../src/types.ts";
import { readTextFile } from "../src/util.ts";
import { handler, host, options, source, tempDir } from "./helpers.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

async function setup(
  sources: HookSource[],
  overrides: Record<string, unknown> = {},
  hostOverrides: Record<string, unknown> = {}
): Promise<{ runtime: HookRuntime; directory: string }> {
  const directory = await tempDir("och-run-");
  const parsed: Options = options(overrides, directory);
  const runtime = new HookRuntime({
    sources,
    options: parsed,
    host: host(directory, { home: directory, ...hostOverrides }),
  });
  return { runtime, directory };
}

function cmd(script: string, overrides: Partial<HookHandler> = {}): HookHandler {
  return handler({ type: "command", command: script, ...overrides });
}

const scope = { sessionID: "ses_1" };

describe("HookRuntime decisions", () => {
  test("PreToolUse deny blocks the call", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: {
              hooks: [
                cmd(
                  'printf \'%s\' \'{"permissionDecision":"deny","permissionDecisionReason":"no rm"}\''
                ),
              ],
            },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      scope
    );
    expect(result.decision.blocked).toBe(true);
    expect(result.decision.permission).toBe("deny");
    expect(result.decision.reason).toBe("no rm");
    expect(result.results[0]?.status).toBe("success");
  });

  test("exit code 2 blocks with stderr", async () => {
    const { runtime } = await setup([
      source([{ event: "PreToolUse", group: { hooks: [cmd("printf blocked >&2; exit 2")] } }], {
        trustedByDefault: true,
      }),
    ]);
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.blocked).toBe(true);
    expect(result.decision.reason).toBe("blocked");
    expect(result.results[0]?.status).toBe("blocked");
  });

  test("matcher filters by tool name", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: {
              matcher: "Edit",
              hooks: [cmd("printf '%s' '{\"permissionDecision\":\"deny\"}'")],
            },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const bash = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(bash.decision.blocked).toBe(false);
    const edit = await runtime.run("PreToolUse", { tool_name: "Edit", tool_input: {} }, scope);
    expect(edit.decision.blocked).toBe(true);
  });

  test("if rules filter shell commands", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: {
              hooks: [cmd("printf '%s' '{\"permissionDecision\":\"deny\"}'", { if: "Bash(rm *)" })],
            },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const safe = await runtime.run(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "ls" } },
      scope
    );
    expect(safe.decision.blocked).toBe(false);
    const danger = await runtime.run(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
      scope
    );
    expect(danger.decision.blocked).toBe(true);
  });

  test("updatedInput is merged", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: {
              hooks: [
                cmd('printf \'%s\' \'{"hookSpecificOutput":{"updatedInput":{"command":"ls"}}}\''),
              ],
            },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.updatedInput).toEqual({ command: "ls" });
  });

  test("PostToolUse adds context", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PostToolUse",
            group: {
              hooks: [
                cmd('printf \'%s\' \'{"hookSpecificOutput":{"additionalContext":"lint failed"}}\''),
              ],
            },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("PostToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.additionalContext).toEqual(["lint failed"]);
  });

  test("plain text on SessionStart becomes additional context", async () => {
    const { runtime } = await setup([
      source([{ event: "SessionStart", group: { hooks: [cmd("printf plain-context")] } }], {
        trustedByDefault: true,
      }),
    ]);
    const result = await runtime.run("SessionStart", { source: "startup" }, scope);
    expect(result.decision.additionalContext).toEqual(["plain-context"]);
  });

  test("SessionStart adds context", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "SessionStart",
            group: {
              hooks: [
                cmd('printf \'%s\' \'{"hookSpecificOutput":{"additionalContext":"remember"}}\''),
              ],
            },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("SessionStart", { source: "startup" }, scope);
    expect(result.decision.additionalContext).toEqual(["remember"]);
  });

  test("continue false stops the session", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "UserPromptSubmit",
            group: { hooks: [cmd('printf \'%s\' \'{"continue":false,"stopReason":"halt"}\'')] },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("UserPromptSubmit", { prompt: "hi" }, scope);
    expect(result.decision.stop).toBe(true);
    expect(result.decision.stopReason).toBe("halt");
  });

  test("once hooks run a single time", async () => {
    const directory = await tempDir("och-once-");
    const runtime = new HookRuntime({
      sources: [
        source(
          [
            {
              event: "PreToolUse",
              group: { hooks: [cmd("printf x >> once.txt", { once: true })] },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      options: options({}, directory),
      host: host(directory, { home: directory }),
    });
    await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(await readTextFile(join(directory, "once.txt"))).toBe("x");
  });

  test("onFailure block turns a crash into a block", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: { hooks: [cmd("exit 9", { onFailure: "block" })] },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.blocked).toBe(true);
    expect(result.decision.reason).toBe("hook exited 9");
  });

  test("onFailure block covers a failed hook that printed JSON", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: {
              hooks: [
                cmd("printf '%s' '{\"permissionDecision\":\"allow\"}'; exit 9", {
                  onFailure: "block",
                }),
              ],
            },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.results[0]?.exitCode).toBe(9);
    expect(result.decision.blocked).toBe(true);
    expect(result.decision.permission).toBeUndefined();
  });

  test("nonzero JSON keeps its decision without onFailure block", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: {
              hooks: [cmd("printf '%s' '{\"permissionDecision\":\"allow\"}'; exit 9")],
            },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.blocked).toBe(false);
    expect(result.decision.permission).toBe("allow");
  });

  test("unsupported handlers are skipped, not fatal", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: { hooks: [{ type: "mcp_tool", reason: "no dispatcher" }] },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.results[0]?.status).toBe("skipped");
    expect(result.decision.blocked).toBe(false);
  });

  test("untrusted project hooks are skipped", async () => {
    const { runtime } = await setup([
      source([
        {
          event: "PreToolUse",
          group: { hooks: [cmd("printf '%s' '{\"permissionDecision\":\"deny\"}'")] },
        },
      ]),
    ]);
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.results[0]?.status).toBe("untrusted");
    expect(result.decision.blocked).toBe(false);
    expect(runtime.pendingTrust()).toHaveLength(1);
  });

  test("trust all runs project hooks", async () => {
    const { runtime } = await setup(
      [
        source([
          {
            event: "PreToolUse",
            group: { hooks: [cmd("printf '%s' '{\"permissionDecision\":\"deny\"}'")] },
          },
        ]),
      ],
      { trust: "all" }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.blocked).toBe(true);
  });

  test("disabled events never run", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: { hooks: [cmd("printf '%s' '{\"permissionDecision\":\"deny\"}'")] },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { disabledEvents: ["PreToolUse"] }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.results).toHaveLength(0);
    expect(result.decision.blocked).toBe(false);
  });

  test("activator sources only run when active", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: { hooks: [cmd("printf '%s' '{\"permissionDecision\":\"deny\"}'")] },
          },
        ],
        { trustedByDefault: true, activator: { kind: "skill", id: "s1" } }
      ),
    ]);
    const inactive = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(inactive.decision.blocked).toBe(false);
    const active = await runtime.run(
      "PreToolUse",
      { tool_name: "Bash", tool_input: {} },
      {
        ...scope,
        activeSkills: new Set(["s1"]),
      }
    );
    expect(active.decision.blocked).toBe(true);
  });

  test("Stop hook loops are capped", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "Stop",
              group: { hooks: [cmd('printf \'%s\' \'{"decision":"block","reason":"again"}\'')] },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { maxStopContinuations: 1 }
    );
    const first = await runtime.run("Stop", {}, scope);
    expect(first.decision.blocked).toBe(true);
    const second = await runtime.run("Stop", {}, scope);
    expect(second.decision.blocked).toBe(false);
    expect(second.decision.systemMessages.join("\n")).toContain("allowing the session to stop");
  });

  test("noteActivity resets the Stop guard", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "Stop",
              group: { hooks: [cmd('printf \'%s\' \'{"decision":"block","reason":"again"}\'')] },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { maxStopContinuations: 1 }
    );
    await runtime.run("Stop", {}, scope);
    runtime.noteActivity("ses_1");
    const next = await runtime.run("Stop", {}, scope);
    expect(next.decision.blocked).toBe(true);
  });

  test("http hooks work end to end", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const body = (await request.json()) as { tool_name?: string };
        return Response.json({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: `blocked ${body.tool_name}`,
          },
        });
      },
    });
    servers.push(server);
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: { hooks: [handler({ type: "http", url: `http://127.0.0.1:${server.port}/` })] },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.blocked).toBe(true);
    expect(result.decision.reason).toBe("blocked Bash");
  });

  test("prompt hooks use the generated JSON", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: { hooks: [handler({ type: "prompt", prompt: "judge $ARGUMENTS" })] },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { allowPromptHooks: true },
      {
        defaultModel: async () => ({ providerID: "test", modelID: "test" }),
        generateText: async () =>
          '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"judged"}}',
      }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.blocked).toBe(true);
    expect(result.decision.reason).toBe("judged");
  });

  test("prompt hooks reject the native ok:false response", async () => {
    let seen = "";
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: { hooks: [handler({ type: "prompt", prompt: "judge $ARGUMENTS" })] },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { allowPromptHooks: true },
      {
        defaultModel: async () => ({ providerID: "test", modelID: "test" }),
        generateText: async ({ prompt }: { prompt: string }) => {
          seen = prompt;
          return '{"ok":false,"reason":"REGRESSION_DENY"}';
        },
      }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(seen).toContain('"ok":true');
    expect(result.decision.blocked).toBe(true);
    expect(result.decision.permission).toBe("deny");
    expect(result.decision.reason).toBe("REGRESSION_DENY");
  });

  test("prompt hooks allow the native ok:true response", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: { hooks: [handler({ type: "prompt", prompt: "judge" })] },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { allowPromptHooks: true },
      {
        defaultModel: async () => ({ providerID: "test", modelID: "test" }),
        generateText: async () => '{"ok":true}',
      }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.blocked).toBe(false);
    expect(result.decision.permission).toBeUndefined();
  });

  test("prompt hooks time out even when the model ignores the signal", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: {
                hooks: [
                  handler({
                    type: "prompt",
                    prompt: "judge",
                    timeout: 0.05,
                    onFailure: "block",
                  }),
                ],
              },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { allowPromptHooks: true },
      {
        defaultModel: async () => ({ providerID: "test", modelID: "test" }),
        generateText: async () => new Promise<string>(() => undefined),
      }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.results[0]?.status).toBe("error");
    expect(result.decision.blocked).toBe(true);
  });

  test("a synchronous prompt failure is returned as an error", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: {
                hooks: [handler({ type: "prompt", prompt: "judge", onFailure: "block" })],
              },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { allowPromptHooks: true },
      {
        defaultModel: async () => ({ providerID: "test", modelID: "test" }),
        generateText: () => {
          throw new Error("sync boom");
        },
      }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.results[0]?.status).toBe("error");
    expect(result.results[0]?.message).toContain("sync boom");
    expect(result.decision.blocked).toBe(true);
  });

  test("statusMessage reaches the host for prompt hooks", async () => {
    const seen: string[] = [];
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: {
                hooks: [handler({ type: "prompt", prompt: "judge", statusMessage: "judging" })],
              },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { allowPromptHooks: true },
      {
        status: (message: string) => seen.push(message),
        defaultModel: async () => ({ providerID: "test", modelID: "test" }),
        generateText: async () => '{"ok":true}',
      }
    );
    await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(seen).toContain("judging");
  });

  test("prompt hook failures apply onFailure", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: {
                hooks: [handler({ type: "prompt", prompt: "judge", onFailure: "block" })],
              },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      { allowPromptHooks: true },
      {
        defaultModel: async () => ({ providerID: "test", modelID: "test" }),
        generateText: async () => {
          throw new Error("model unavailable");
        },
      }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.decision.blocked).toBe(true);
    expect(result.decision.reason).toContain("model unavailable");
  });

  test("prompt hooks are skipped when disabled", async () => {
    const { runtime } = await setup(
      [
        source(
          [
            {
              event: "PreToolUse",
              group: { hooks: [handler({ type: "prompt", prompt: "judge" })] },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      {},
      {
        defaultModel: async () => ({ providerID: "test", modelID: "test" }),
        generateText: async () => '{"decision":"block"}',
      }
    );
    const result = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    expect(result.results[0]?.status).toBe("skipped");
    expect(result.decision.blocked).toBe(false);
  });

  test("trace writes redacted JSONL", async () => {
    const directory = await tempDir("och-trace-");
    const trace = join(directory, "trace.jsonl");
    const runtime = new HookRuntime({
      sources: [
        source(
          [
            {
              event: "PreToolUse",
              group: {
                hooks: [
                  cmd(
                    'printf \'%s\' \'{"decision":"block","reason":"token=sk-abcdefghijklmnopqrstuv"}\''
                  ),
                ],
              },
            },
          ],
          { trustedByDefault: true }
        ),
      ],
      options: options({ trace }, directory),
      host: host(directory, { home: directory }),
    });
    await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: {} }, scope);
    await Bun.sleep(10);
    const text = await readTextFile(trace);
    expect(text).toContain("PreToolUse");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  test("report lists pending trust fingerprints", async () => {
    const { runtime } = await setup(
      [source([{ event: "PreToolUse", group: { hooks: [cmd("true")] } }])],
      { trust: "user" }
    );
    await runtime.prefetchTrust();
    expect(runtime.report().pendingTrust).toHaveLength(1);
    expect(runtime.report().pendingTrust[0]).toContain("test source");
    expect(runtime.report().pendingTrust[0]?.split(" ")[0]).toHaveLength(64);
  });

  test("report ignores unsupported handlers when aggregating trust", async () => {
    const { runtime } = await setup([
      source(
        [
          {
            event: "PreToolUse",
            group: {
              hooks: [handler({ type: "command", command: "true" })],
            },
          },
          {
            event: "PreToolUse",
            group: { hooks: [{ type: "mcp_tool", reason: "no dispatcher" }] },
          },
        ],
        { trustedByDefault: true }
      ),
    ]);
    await runtime.prefetchTrust();
    expect(runtime.report().sources[0]?.trusted).toBe(true);
  });

  test("report trust aggregation ignores unsupported handlers for a project source", async () => {
    const trustedCommand = handler({ type: "command", command: "true" });
    const projectSource = source([
      { event: "PreToolUse", group: { hooks: [trustedCommand] } },
      { event: "PreToolUse", group: { hooks: [{ type: "mcp_tool", reason: "no dispatcher" }] } },
    ]);
    const fingerprint = hookFingerprint(projectSource, trustedCommand, "PreToolUse", undefined);
    const { runtime } = await setup([projectSource], { trusted: [fingerprint] });
    await runtime.prefetchTrust();
    expect(runtime.report().sources[0]?.trusted).toBe(true);
    expect(runtime.report().pendingTrust).toHaveLength(0);
  });

  test("report lists sources and unsupported entries", async () => {
    const { runtime } = await setup([
      source([{ event: "Stop", group: { hooks: [cmd("true")] } }], { label: "project settings" }),
    ]);
    const report = runtime.report();
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.label).toBe("project settings");
    expect(report.sources[0]?.events.Stop).toBe(1);
    expect(runtime.describe()).toContain("opencode-claude-hooks");
  });
});
