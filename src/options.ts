import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { HookEventName, ModelRef, Options, TrustMode } from "./types.ts";
import { HOOK_EVENTS } from "./types.ts";

const DEFAULTS = {
  trust: "user" as TrustMode,
  trusted: [] as readonly string[],
  sources: [] as readonly string[],
  plugins: [] as readonly string[],
  disabledEvents: [] as readonly HookEventName[],
  allowHttpHooks: true,
  allowPromptHooks: false,
  httpAllowlist: [] as readonly string[],
  inheritEnv: false,
  env: {} as Readonly<Record<string, string>>,
  defaultTimeoutSec: 600,
  maxTimeoutSec: 3600,
  maxOutputBytes: 1024 * 1024,
  maxStopContinuations: 3,
} as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function stringRecord(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === "string") output[key] = entry;
  }
  return output;
}

function trust(value: unknown): TrustMode {
  return value === "all" || value === "none" || value === "prompt" || value === "user"
    ? value
    : DEFAULTS.trust;
}

function model(value: unknown): ModelRef | undefined {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash > 0 && slash < value.length - 1) {
      return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
    }
    return undefined;
  }
  const entry = record(value);
  if (typeof entry.providerID === "string" && typeof entry.modelID === "string") {
    return { providerID: entry.providerID, modelID: entry.modelID };
  }
  if (typeof entry.provider === "string" && typeof entry.model === "string") {
    return { providerID: entry.provider, modelID: entry.model };
  }
  return undefined;
}

function events(value: unknown): HookEventName[] {
  const allowed = new Set<string>(HOOK_EVENTS);
  return stringArray(value).filter((entry): entry is HookEventName => allowed.has(entry));
}

/** Expand a leading `~` and resolve relative paths against the project directory. */
export function expandPath(value: string, directory: string, home = homedir()): string {
  let output = value;
  if (output === "~") output = home;
  else if (output.startsWith("~/")) output = resolve(home, output.slice(2));
  return isAbsolute(output) ? resolve(output) : resolve(directory, output);
}

/**
 * Parse plugin options. Invalid values fall back to secure defaults instead of
 * failing the whole plugin load: a typo must never disable a security boundary.
 */
export function parseOptions(raw: unknown, directory: string, home = homedir()): Options {
  const input = record(raw);
  const promptModel = model(input.promptModel);
  const trustFile =
    typeof input.trustFile === "string" && input.trustFile.trim().length > 0
      ? expandPath(input.trustFile, directory, home)
      : undefined;
  const trace =
    typeof input.trace === "string" && input.trace.trim().length > 0
      ? expandPath(input.trace, directory, home)
      : undefined;
  const managedSettings =
    typeof input.managedSettings === "string" && input.managedSettings.trim().length > 0
      ? expandPath(input.managedSettings, directory, home)
      : undefined;

  return {
    trust: trust(input.trust),
    trusted: stringArray(input.trusted),
    trustFile,
    managedSettings,
    sources: stringArray(input.sources).map((entry) => expandPath(entry, directory, home)),
    plugins: stringArray(input.plugins).map((entry) => expandPath(entry, directory, home)),
    disabledEvents: events(input.disabledEvents),
    allowHttpHooks: boolean(input.allowHttpHooks, DEFAULTS.allowHttpHooks),
    allowPromptHooks: boolean(input.allowPromptHooks, DEFAULTS.allowPromptHooks),
    httpAllowlist: stringArray(input.httpAllowlist),
    inheritEnv: boolean(input.inheritEnv, DEFAULTS.inheritEnv),
    env: stringRecord(input.env),
    defaultTimeoutSec: number(
      input.defaultTimeoutSec,
      DEFAULTS.defaultTimeoutSec,
      1,
      DEFAULTS.maxTimeoutSec
    ),
    maxTimeoutSec: number(input.maxTimeoutSec, DEFAULTS.maxTimeoutSec, 1, 86_400),
    maxOutputBytes: number(input.maxOutputBytes, DEFAULTS.maxOutputBytes, 1024, 64 * 1024 * 1024),
    promptModel,
    trace,
    maxStopContinuations: number(input.maxStopContinuations, DEFAULTS.maxStopContinuations, 0, 50),
  };
}
