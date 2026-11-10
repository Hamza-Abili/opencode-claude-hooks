import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseOptions } from "../src/options.ts";
import type {
  HookEntry,
  HookEventName,
  HookGroup,
  HookHandler,
  HookSource,
  Host,
  Options,
  Scope,
} from "../src/types.ts";

export async function tempDir(prefix = "och-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

export function options(
  overrides: Record<string, unknown> = {},
  directory = process.cwd()
): Options {
  return parseOptions(overrides, directory, "/home/test");
}

export function host(directory: string, overrides: Partial<Host> = {}): Host {
  return {
    directory,
    home: "/home/test",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/home/test" },
    status: () => undefined,
    now: () => Date.now(),
    ...overrides,
  };
}

export function handler(
  value: { type: HookHandler["type"] } & Record<string, unknown>
): HookHandler {
  const { type, ...base } = value;
  if (type === "command") return { type: "command", command: "true", ...base } as HookHandler;
  if (type === "http") return { type: "http", url: "http://127.0.0.1:1/", ...base } as HookHandler;
  if (type === "prompt") return { type: "prompt", prompt: "review", ...base } as HookHandler;
  return { type, reason: "unsupported", ...base } as HookHandler;
}

export function group(hooks: HookHandler[], matcher?: string): HookGroup {
  return { matcher, hooks };
}

export function source(
  entries: Array<{ event: HookEventName; group: HookGroup }>,
  overrides: Partial<HookSource> = {}
): HookSource {
  const scope: Scope = overrides.scope ?? "project";
  return {
    id: overrides.id ?? `project:/tmp/${Math.random().toString(16).slice(2)}`,
    label: overrides.label ?? "test source",
    path: overrides.path ?? "/tmp/settings.json",
    scope,
    trustedByDefault: overrides.trustedByDefault ?? false,
    entries,
    warnings: [],
    ...overrides,
  };
}

export function entry(event: HookEventName, hooks: HookHandler[], matcher?: string): HookEntry {
  return { event, group: group(hooks, matcher) };
}

export const BASE_PAYLOAD = {
  session_id: "ses_test",
  cwd: "/tmp/project",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
};
