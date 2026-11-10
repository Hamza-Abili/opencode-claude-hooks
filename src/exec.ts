import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { CommandHook, HookSource, Options } from "./types.ts";
import { truncate } from "./util.ts";

const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PWD",
]);

const ENV_PREFIXES = ["LC_"];

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly error?: string;
}

export interface ExecInput {
  readonly handler: CommandHook;
  readonly cwd: string;
  readonly source: HookSource;
  readonly options: Options;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

function substitute(value: string, source: HookSource, cwd: string, event: string): string {
  return value
    .split("${CLAUDE_PROJECT_DIR}")
    .join(cwd)
    .split("${CLAUDE_PLUGIN_ROOT}")
    .join(source.pluginRoot ?? "")
    .split("${CLAUDE_PLUGIN_DATA}")
    .join(source.pluginData ?? "")
    .split("${CLAUDE_HOOK_EVENT}")
    .join(event);
}

/** Build the environment a hook receives. Ambient secrets are excluded by default. */
export function hookEnvironment(input: ExecInput, event: string): Record<string, string> {
  const output: Record<string, string> = {};
  if (input.options.inheritEnv) {
    for (const [key, value] of Object.entries(input.env)) {
      if (value !== undefined) output[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(input.env)) {
      if (value === undefined) continue;
      if (ENV_ALLOWLIST.has(key) || ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        output[key] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(input.options.env)) output[key] = value;
  output.CLAUDE_PROJECT_DIR = input.cwd;
  output.CLAUDE_HOOK_EVENT = event;
  if (input.source.pluginRoot !== undefined) output.CLAUDE_PLUGIN_ROOT = input.source.pluginRoot;
  if (input.source.pluginData !== undefined) output.CLAUDE_PLUGIN_DATA = input.source.pluginData;
  output.PWD = input.cwd;
  return output;
}

function commandCwd(input: ExecInput): string {
  const cwd = input.cwd;
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const child = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
      child.on("close", () => resolveKill());
      child.on("error", () => resolveKill());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run a Claude command hook. Exit codes and output caps are enforced here so
 * the runtime only sees a bounded, structured result.
 */
export async function runCommand(input: ExecInput, event: string): Promise<ExecResult> {
  const command = substitute(input.handler.command, input.source, input.cwd, event);
  const args = input.handler.args?.map((arg) => substitute(arg, input.source, input.cwd, event));
  const env = hookEnvironment(input, event);
  const cwd = commandCwd(input);
  const maxBytes = input.options.maxOutputBytes;
  const timeoutMs =
    Math.min(
      input.handler.timeout ?? input.options.defaultTimeoutSec,
      input.options.maxTimeoutSec
    ) * 1000;

  let executable: string;
  let argv: string[];
  if (args !== undefined) {
    executable = command;
    argv = args;
  } else if (process.platform === "win32") {
    if (input.handler.shell === "powershell") {
      executable = "powershell.exe";
      argv = ["-NoProfile", "-NonInteractive", "-Command", command];
    } else if (input.handler.shell === "bash") {
      executable = "bash.exe";
      argv = ["-c", command];
    } else {
      executable = "cmd.exe";
      argv = ["/d", "/s", "/c", command];
    }
  } else if (input.handler.shell === "powershell") {
    executable = "pwsh";
    argv = ["-NoProfile", "-NonInteractive", "-Command", command];
  } else {
    executable = input.handler.shell === "bash" ? "bash" : "sh";
    argv = ["-c", command];
  }

  return await new Promise<ExecResult>((resolveResult) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };

    const onAbort = (): void => {
      void killTree(child?.pid);
      finish({
        exitCode: 130,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: false,
        truncated: stdoutTruncated || stderrTruncated,
        stdoutTruncated,
        stderrTruncated,
        error: "aborted",
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child?.pid);
      setTimeout(() => {
        if (settled) return;
        finish({
          exitCode: 124,
          stdout: truncate(Buffer.concat(stdout).toString("utf8"), maxBytes),
          stderr: truncate(Buffer.concat(stderr).toString("utf8"), maxBytes),
          timedOut: true,
          truncated: stdoutTruncated || stderrTruncated,
          stdoutTruncated,
          stderrTruncated,
          error: "timeout",
        });
      }, 2000);
    }, timeoutMs);

    try {
      child = spawn(executable, argv, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      finish({
        exitCode: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.stdin?.on("error", () => {
      // The hook may exit without reading stdin; EPIPE is not a failure.
    });
    child.stdin?.end(input.stdin ?? "");
    if (input.signal?.aborted === true) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) {
        stdoutTruncated = true;
        return;
      }
      const remaining = maxBytes - stdoutBytes;
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stdout.push(slice);
      stdoutBytes += slice.byteLength;
      if (slice.byteLength < chunk.byteLength) stdoutTruncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxBytes) {
        stderrTruncated = true;
        return;
      }
      const remaining = maxBytes - stderrBytes;
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr.push(slice);
      stderrBytes += slice.byteLength;
      if (slice.byteLength < chunk.byteLength) stderrTruncated = true;
    });
    child.on("error", (error) => {
      finish({
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: truncate(Buffer.concat(stderr).toString("utf8"), maxBytes),
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
        stdoutTruncated,
        stderrTruncated,
        error: error.message,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout: truncate(Buffer.concat(stdout).toString("utf8"), maxBytes),
        stderr: truncate(Buffer.concat(stderr).toString("utf8"), maxBytes),
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}
