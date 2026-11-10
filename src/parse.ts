import { basename } from "node:path";
import {
  type CommandHook,
  HOOK_EVENTS,
  type HookEntry,
  type HookEventName,
  type HookGroup,
  type HookHandler,
  type HttpHook,
  KNOWN_UNSUPPORTED_EVENTS,
  type PromptHook,
  type UnsupportedHook,
} from "./types.ts";
import { parseSimpleYaml } from "./yaml.ts";

const EVENT_SET = new Set<string>(HOOK_EVENTS);
const UNSUPPORTED_EVENT_SET = new Set<string>(KNOWN_UNSUPPORTED_EVENTS);

export interface ParsedHooks {
  readonly entries: HookEntry[];
  readonly warnings: string[];
  readonly unsupportedEvents: string[];
  readonly unsupportedHandlers: string[];
  readonly disabledAll: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function onFailure(value: unknown): "continue" | "block" | undefined {
  return value === "block" || value === "continue" ? value : undefined;
}

function base(value: Record<string, unknown>): {
  if?: string;
  timeout?: number;
  once?: boolean;
  onFailure?: "continue" | "block";
} {
  return {
    if: stringValue(value.if),
    timeout: positive(value.timeout),
    once: value.once === true ? true : undefined,
    onFailure: onFailure(value.onFailure),
  };
}

function normalizeCommand(value: Record<string, unknown>): CommandHook | UnsupportedHook {
  const command = stringValue(value.command);
  if (command === undefined) {
    return {
      type: "unknown",
      reason: "command hook without a command string",
      if: stringValue(value.if),
    };
  }
  const shell = value.shell === "bash" || value.shell === "powershell" ? value.shell : undefined;
  return {
    type: "command",
    command,
    args: stringList(value.args),
    async: value.async === true ? true : undefined,
    asyncRewake: value.asyncRewake === true ? true : undefined,
    shell,
    statusMessage: stringValue(value.statusMessage),
    ...base(value),
  };
}

function normalizeHttp(value: Record<string, unknown>): HttpHook | UnsupportedHook {
  const url = stringValue(value.url);
  if (url === undefined || !/^https?:\/\//i.test(url)) {
    return {
      type: "unknown",
      reason: "http hook without an http(s) url",
      if: stringValue(value.if),
    };
  }
  const headers: Record<string, string> = {};
  if (isObject(value.headers)) {
    for (const [key, entry] of Object.entries(value.headers)) {
      if (typeof entry === "string") headers[key] = entry;
    }
  }
  return {
    type: "http",
    url,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    allowedEnvVars: stringList(value.allowedEnvVars),
    ...base(value),
  };
}

function normalizePrompt(value: Record<string, unknown>): PromptHook | UnsupportedHook {
  const prompt = stringValue(value.prompt);
  if (prompt === undefined) {
    return { type: "unknown", reason: "prompt hook without a prompt", if: stringValue(value.if) };
  }
  return {
    type: "prompt",
    prompt,
    model: stringValue(value.model),
    ...base(value),
  };
}

function usesUserConfig(value: Record<string, unknown>): boolean {
  const strings = [value.command, value.url, value.prompt, value.if].filter(
    (entry): entry is string => typeof entry === "string"
  );
  if (Array.isArray(value.args)) {
    for (const entry of value.args) if (typeof entry === "string") strings.push(entry);
  }
  return strings.some((entry) => entry.includes("${user_config."));
}

export function normalizeHandler(value: unknown): HookHandler | UnsupportedHook {
  if (!isObject(value)) return { type: "unknown", reason: "handler is not an object" };
  if (usesUserConfig(value)) {
    return {
      type: "unknown",
      reason: "plugin user_config placeholders are not supported",
      if: stringValue(value.if),
    };
  }
  switch (value.type) {
    case "command":
      return normalizeCommand(value);
    case "http":
      return normalizeHttp(value);
    case "prompt":
      return normalizePrompt(value);
    case "mcp_tool":
      return {
        type: "mcp_tool",
        reason: "mcp_tool hooks need an MCP tool dispatcher",
        if: stringValue(value.if),
      };
    case "agent":
      return {
        type: "agent",
        reason: "agent hooks need a nested agent runner",
        if: stringValue(value.if),
      };
    default:
      return {
        type: "unknown",
        reason: `unsupported hook type ${JSON.stringify(value.type ?? null)}`,
        if: stringValue(value.if),
      };
  }
}

/**
 * Parse a Claude hooks map (`{ PreToolUse: [{ matcher, hooks: [...] }] }`).
 * Unknown events are reported, never silently dropped.
 */
export function parseHooksMap(value: unknown, label: string): ParsedHooks {
  const entries: HookEntry[] = [];
  const warnings: string[] = [];
  const unsupportedEvents: string[] = [];
  const unsupportedHandlers: string[] = [];
  if (!isObject(value)) {
    return {
      entries,
      warnings: [`${label}: hooks is not an object`],
      unsupportedEvents,
      unsupportedHandlers,
      disabledAll: false,
    };
  }

  for (const [event, groups] of Object.entries(value)) {
    if (!EVENT_SET.has(event)) {
      if (!UNSUPPORTED_EVENT_SET.has(event)) warnings.push(`${label}: unknown hook event ${event}`);
      unsupportedEvents.push(event);
      continue;
    }
    if (!Array.isArray(groups)) {
      warnings.push(`${label}: ${event} is not an array`);
      continue;
    }
    for (const groupValue of groups) {
      if (!isObject(groupValue)) {
        warnings.push(`${label}: ${event} contains a non-object group`);
        continue;
      }
      const matcher = stringValue(groupValue.matcher);
      const rawHooks = groupValue.hooks;
      if (!Array.isArray(rawHooks)) {
        warnings.push(`${label}: ${event} group has no hooks array`);
        continue;
      }
      const hooks: HookHandler[] = [];
      for (const raw of rawHooks) {
        const handler = normalizeHandler(raw);
        if (handler.type === "mcp_tool" || handler.type === "agent" || handler.type === "unknown") {
          unsupportedHandlers.push(`${event}:${handler.type} (${handler.reason})`);
        }
        hooks.push(handler);
      }
      if (hooks.length === 0) continue;
      const group: HookGroup = { matcher, hooks };
      entries.push({ event: event as HookEventName, group });
    }
  }

  return { entries, warnings, unsupportedEvents, unsupportedHandlers, disabledAll: false };
}

/**
 * A settings file wraps hooks under `hooks`; a plugin hook file also uses that
 * wrapper, while an inline plugin manifest value is the bare event map.
 */
export function parseSettingsHooks(value: unknown, label: string): ParsedHooks {
  if (!isObject(value)) {
    return {
      entries: [],
      warnings: [`${label}: settings is not an object`],
      unsupportedEvents: [],
      unsupportedHandlers: [],
      disabledAll: false,
    };
  }
  return parseHooksMap(value.hooks, label);
}

export function parsePluginHooksFile(value: unknown, label: string): ParsedHooks {
  if (isObject(value) && isObject(value.hooks)) return parseHooksMap(value.hooks, label);
  if (isObject(value) && Object.keys(value).some((key) => EVENT_SET.has(key))) {
    return parseHooksMap(value, label);
  }
  return {
    entries: [],
    warnings: [`${label}: not a hooks file (missing top-level "hooks" object)`],
    unsupportedEvents: [],
    unsupportedHandlers: [],
    disabledAll: false,
  };
}

export interface Frontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
}

function bunYaml(): { parse(text: string): unknown } | undefined {
  const candidate = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun;
  return candidate?.YAML;
}

/**
 * Parse YAML frontmatter. OpenCode runs on Bun, which ships a YAML parser; the
 * fallback keeps unit tests and older runtimes working for simple JSON-ish
 * frontmatter.
 */
export function parseFrontmatter(text: string): Frontmatter | undefined {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const raw = text.slice(3, end).replace(/^\r?\n/, "");
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const yaml = bunYaml();
  if (yaml !== undefined) {
    try {
      const parsed = yaml.parse(raw);
      return isObject(parsed) ? { data: parsed, body } : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const parsed = parseSimpleYaml(raw);
    return isObject(parsed) ? { data: parsed, body } : undefined;
  } catch {
    return undefined;
  }
}

export function frontmatterHooks(text: string, label: string): ParsedHooks & { name?: string } {
  const front = parseFrontmatter(text);
  if (front === undefined) {
    return {
      entries: [],
      warnings: [],
      unsupportedEvents: [],
      unsupportedHandlers: [],
      disabledAll: false,
    };
  }
  const hooks = front.data.hooks;
  const name = stringValue(front.data.name);
  if (hooks === undefined) {
    return {
      name,
      entries: [],
      warnings: [],
      unsupportedEvents: [],
      unsupportedHandlers: [],
      disabledAll: false,
    };
  }
  return { ...parseHooksMap(hooks, label), name };
}

export function unreadableHookFile(label: string, reason: string): ParsedHooks {
  return {
    entries: [],
    warnings: [`${label}: ${reason}`],
    unsupportedEvents: [],
    unsupportedHandlers: [],
    disabledAll: false,
  };
}

export function labelFor(path: string): string {
  return basename(path);
}
