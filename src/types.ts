/**
 * Shared types. The runtime is deliberately independent from the OpenCode
 * plugin API: V1 and V2 adapters translate their events into these structures.
 */

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export const SUPPORTED_HANDLERS = ["command", "http", "prompt"] as const;
export type SupportedHandlerType = (typeof SUPPORTED_HANDLERS)[number];

/**
 * Claude Code events we recognise but cannot map faithfully. The doctor lists
 * them so a user never has to guess why a hook did not run.
 */
export const KNOWN_UNSUPPORTED_EVENTS = [
  "Setup",
  "PermissionRequest",
  "UserPromptExpansion",
  "PermissionDenied",
  "PostToolBatch",
  "MessageDisplay",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreModelSwitch",
  "PostModelSwitch",
  "Elicitation",
  "ElicitationResult",
] as const;

export const UNSUPPORTED_HANDLERS = ["mcp_tool", "agent"] as const;

export type Scope = "user" | "project" | "local" | "managed" | "plugin" | "skill" | "agent";

export interface CommandHook {
  readonly type: "command";
  readonly command: string;
  readonly args?: readonly string[];
  readonly async?: boolean;
  readonly asyncRewake?: boolean;
  readonly shell?: "bash" | "powershell";
  readonly timeout?: number;
  readonly statusMessage?: string;
  readonly once?: boolean;
  readonly onFailure?: "continue" | "block";
  readonly if?: string;
}

export interface HttpHook {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowedEnvVars?: readonly string[];
  readonly timeout?: number;
  readonly statusMessage?: string;
  readonly once?: boolean;
  readonly onFailure?: "continue" | "block";
  readonly if?: string;
}

export interface PromptHook {
  readonly type: "prompt";
  readonly prompt: string;
  readonly model?: string;
  readonly timeout?: number;
  readonly statusMessage?: string;
  readonly once?: boolean;
  readonly onFailure?: "continue" | "block";
  readonly if?: string;
}

export interface McpToolHook {
  readonly type: "mcp_tool";
  readonly if?: string;
  readonly reason: string;
}

export interface AgentHook {
  readonly type: "agent";
  readonly if?: string;
  readonly reason: string;
}

export interface UnknownHook {
  readonly type: "unknown";
  readonly if?: string;
  readonly reason: string;
}

export type UnsupportedHook = McpToolHook | AgentHook | UnknownHook;

export type HookHandler = CommandHook | HttpHook | PromptHook | UnsupportedHook;

export interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookHandler[];
}

export interface HookEntry {
  readonly event: HookEventName;
  readonly group: HookGroup;
}

export interface HookActivator {
  readonly kind: "skill" | "agent";
  readonly id: string;
}

export interface HookSource {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly scope: Scope;
  readonly trustedByDefault: boolean;
  readonly pluginRoot?: string;
  readonly pluginData?: string;
  readonly activator?: HookActivator;
  readonly entries: readonly HookEntry[];
  readonly warnings: readonly string[];
}

export type TrustMode = "user" | "all" | "none" | "prompt";

export interface ModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

export interface Options {
  readonly trust: TrustMode;
  readonly trusted: readonly string[];
  readonly trustFile?: string;
  readonly managedSettings?: string;
  readonly sources: readonly string[];
  readonly plugins: readonly string[];
  readonly disabledEvents: readonly HookEventName[];
  readonly allowHttpHooks: boolean;
  readonly allowPromptHooks: boolean;
  readonly httpAllowlist: readonly string[];
  readonly inheritEnv: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly defaultTimeoutSec: number;
  readonly maxTimeoutSec: number;
  readonly maxOutputBytes: number;
  readonly promptModel?: ModelRef;
  readonly trace?: string;
  readonly maxStopContinuations: number;
}

export interface Discovered {
  readonly sources: readonly HookSource[];
  readonly warnings: readonly string[];
  readonly unsupportedEvents: readonly string[];
  readonly unsupportedHandlers: readonly string[];
  readonly enabledPlugins: Readonly<Record<string, boolean>>;
}

export interface SkillLike {
  readonly id: string;
  readonly name?: string;
  readonly path?: string;
  readonly content?: string;
}

/** Test seam: adapters fall back to the real home directory. */
export interface AdapterEnvironment {
  readonly home?: string;
}

export interface Host {
  readonly directory: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generateText?: (input: {
    readonly model: ModelRef;
    readonly prompt: string;
    readonly signal?: AbortSignal;
  }) => Promise<string>;
  readonly defaultModel?: () => Promise<ModelRef | undefined>;
  /**
   * Ask the user to trust a hook. Return true to run it and remember the
   * decision. Adapters without a prompt capability omit this method.
   */
  readonly assertTrust?: (input: {
    readonly sessionID?: string;
    readonly fingerprint: string;
    readonly source: string;
    readonly summary: string;
    readonly message: string;
  }) => Promise<boolean>;
  readonly status?: (message: string) => void;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

export interface RunScope {
  readonly sessionID: string;
  readonly agent?: string;
  readonly permissionMode?: string;
  readonly activeSkills?: ReadonlySet<string>;
}

export interface RawHookOutput {
  readonly continue?: boolean;
  readonly stopReason?: string;
  readonly suppressOutput?: boolean;
  readonly systemMessage?: string;
  readonly decision?: "block" | "approve";
  readonly reason?: string;
  readonly permissionDecision?: "allow" | "ask" | "deny";
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly additionalContext?: string;
  readonly customInstructions?: string;
  readonly retry?: boolean;
  /** Native prompt-hook response: true allows, false rejects. */
  readonly ok?: boolean;
  /** Native prompt-hook response: only Stop/SubagentStop honor it. */
  readonly impossible?: boolean;
}

export interface Decision {
  blocked: boolean;
  stop: boolean;
  stopReason?: string;
  permission?: "allow" | "ask" | "deny";
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext: string[];
  customInstructions: string[];
  systemMessages: string[];
  retry: boolean;
}

export type HandlerStatus = "success" | "blocked" | "error" | "timeout" | "untrusted" | "skipped";

export interface HandlerResult {
  readonly sourceID: string;
  readonly sourceLabel: string;
  readonly event: HookEventName;
  readonly handlerType: HookHandler["type"];
  readonly status: HandlerStatus;
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly output?: RawHookOutput;
  readonly message?: string;
}

export interface RunResult {
  readonly event: HookEventName;
  readonly decision: Decision;
  readonly results: readonly HandlerResult[];
  readonly durationMs: number;
}

export interface DoctorSource {
  readonly id: string;
  readonly label: string;
  readonly scope: Scope;
  readonly path: string;
  readonly trusted: boolean;
  readonly activator?: HookActivator;
  readonly events: Readonly<Record<string, number>>;
  readonly handlers: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export interface DoctorReport {
  readonly version: string;
  readonly directory: string;
  readonly trust: TrustMode;
  readonly sources: readonly DoctorSource[];
  readonly unsupportedEvents: readonly string[];
  readonly unsupportedHandlers: readonly string[];
  readonly pendingTrust: readonly string[];
  readonly warnings: readonly string[];
}

export function emptyDecision(): Decision {
  return {
    blocked: false,
    stop: false,
    additionalContext: [],
    customInstructions: [],
    systemMessages: [],
    retry: false,
  };
}
