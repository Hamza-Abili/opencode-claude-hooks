import { describe, expect, test } from "bun:test";
import { hookEnvironment, runCommand } from "../src/exec.ts";
import type { CommandHook } from "../src/types.ts";
import { handler, options, source, tempDir } from "./helpers.ts";

async function run(
  hook: Parameters<typeof handler>[0],
  overrides: Record<string, unknown> = {},
  sourceOverrides: Parameters<typeof source>[1] = {},
  env: Record<string, string | undefined> = { PATH: process.env.PATH ?? "/usr/bin:/bin" }
) {
  const directory = await tempDir("och-exec-");
  const parsed = options(overrides, directory);
  return await runCommand(
    {
      handler: handler(hook) as CommandHook,
      cwd: directory,
      source: source([], sourceOverrides),
      options: parsed,
      env,
    },
    "PreToolUse"
  );
}

describe("runCommand", () => {
  test("passes the hook payload on stdin", async () => {
    const result = await runCommand(
      {
        handler: handler({ type: "command", command: "cat" }) as CommandHook,
        cwd: "/tmp",
        source: source([]),
        options: options(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdin: '{"hello":"world"}',
      },
      "PreToolUse"
    );
    expect(result.stdout).toBe('{"hello":"world"}');
  });

  test("captures stdout and exit 0", async () => {
    const result = await run({ type: "command", command: "printf hello" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  test("captures exit code 2 and stderr", async () => {
    const result = await run({ type: "command", command: "printf blocked >&2; exit 2" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("blocked");
  });

  test("captures other exit codes", async () => {
    const result = await run({ type: "command", command: "exit 7" });
    expect(result.exitCode).toBe(7);
  });

  test("enforces a timeout and kills the process", async () => {
    const started = Date.now();
    const result = await run({ type: "command", command: "sleep 5", timeout: 0.1 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("caps output", async () => {
    const result = await run(
      { type: "command", command: "head -c 5000 /dev/zero | tr '\\0' a" },
      { maxOutputBytes: 1024 }
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
  });

  test("uses exec form when args are present", async () => {
    const result = await run({ type: "command", command: "printf", args: ["%s", "arg-value"] });
    expect(result.stdout).toBe("arg-value");
  });

  test("substitutes project and plugin placeholders", async () => {
    const directory = await tempDir("och-place-");
    const result = await runCommand(
      {
        handler: handler({
          type: "command",
          command: "printf '%s' ${CLAUDE_PROJECT_DIR}:${CLAUDE_PLUGIN_ROOT}",
        }) as CommandHook,
        cwd: directory,
        source: source([], { pluginRoot: "/plugins/demo" }),
        options: options({}, directory),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      "PreToolUse"
    );
    expect(result.stdout).toBe(`${directory}:/plugins/demo`);
  });

  test("does not leak ambient secrets by default", async () => {
    const result = await run(
      { type: "command", command: "printf '%s' \"$SECRET\"" },
      {},
      {},
      { PATH: process.env.PATH ?? "/usr/bin:/bin", SECRET: "hunter2" }
    );
    expect(result.stdout).toBe("");
  });

  test("inherits ambient environment when explicitly enabled", async () => {
    const result = await run(
      { type: "command", command: "printf '%s' \"$SECRET\"" },
      { inheritEnv: true },
      {},
      { PATH: process.env.PATH ?? "/usr/bin:/bin", SECRET: "hunter2" }
    );
    expect(result.stdout).toBe("hunter2");
  });

  test("explicit env overrides the allowlist", async () => {
    const result = await run(
      { type: "command", command: "printf '%s' \"$SECRET\"" },
      { env: { SECRET: "explicit" } },
      {},
      { PATH: process.env.PATH ?? "/usr/bin:/bin", SECRET: "ambient" }
    );
    expect(result.stdout).toBe("explicit");
  });

  test("handles a missing executable", async () => {
    const result = await run({ type: "command", command: "/definitely/not/a/binary" });
    expect(result.exitCode).not.toBe(0);
    expect(result.error ?? result.stderr).toBeTruthy();
  });

  test("builds a claude environment", async () => {
    const directory = await tempDir("och-env-");
    const env = hookEnvironment(
      {
        handler: handler({ type: "command", command: "true" }) as CommandHook,
        cwd: directory,
        source: source([], { pluginRoot: "/p", pluginData: "/d" }),
        options: options(),
        env: { PATH: "/bin", SECRET: "no" },
      },
      "Stop"
    );
    expect(env.CLAUDE_PROJECT_DIR).toBe(directory);
    expect(env.CLAUDE_PLUGIN_ROOT).toBe("/p");
    expect(env.CLAUDE_PLUGIN_DATA).toBe("/d");
    expect(env.CLAUDE_HOOK_EVENT).toBe("Stop");
    expect(env.SECRET).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});
