import type { ExecResult } from "./exec.ts";
import type { HttpResult } from "./http.ts";
import type { Decision, HandlerStatus, HookEventName, RawHookOutput } from "./types.ts";
import { emptyDecision } from "./types.ts";
import { firstLine } from "./util.ts";

export interface ParsedOutput {
  readonly status: HandlerStatus;
  readonly output?: RawHookOutput;
  readonly message?: string;
  readonly exitCode?: number;
  /** Plain stdout from an exit-0 command hook, per the Claude contract. */
  readonly plainText?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fence === null ? trimmed : (fence[1] ?? "").trim();
}

function readOutput(value: unknown): RawHookOutput | undefined {
  if (!isObject(value)) return undefined;
  const specific = isObject(value.hookSpecificOutput) ? value.hookSpecificOutput : {};
  const permissionRaw = specific.permissionDecision ?? value.permissionDecision;
  const permission =
    permissionRaw === "allow" || permissionRaw === "ask" || permissionRaw === "deny"
      ? permissionRaw
      : undefined;
  const decisionRaw = value.decision;
  const decision = decisionRaw === "block" || decisionRaw === "approve" ? decisionRaw : undefined;
  return {
    continue: booleanValue(value.continue),
    stopReason: stringValue(value.stopReason),
    suppressOutput: booleanValue(value.suppressOutput),
    systemMessage: stringValue(value.systemMessage),
    decision,
    reason: stringValue(value.reason),
    permissionDecision: permission,
    permissionDecisionReason: stringValue(
      specific.permissionDecisionReason ?? value.permissionDecisionReason
    ),
    updatedInput: isObject(specific.updatedInput) ? specific.updatedInput : undefined,
    additionalContext: stringValue(specific.additionalContext ?? value.additionalContext),
    customInstructions: stringValue(specific.customInstructions ?? value.customInstructions),
    retry: booleanValue(specific.retry ?? value.retry),
  };
}

/** Parse a JSON hook decision. Invalid JSON is an error, never a silent allow. */
export function parseHookJson(text: string): RawHookOutput | undefined {
  const candidate = stripFences(text);
  if (candidate.length === 0) return {};
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return readOutput(parsed) ?? {};
  } catch {
    return undefined;
  }
}

export function parseCommandOutput(result: ExecResult): ParsedOutput {
  if (result.timedOut) {
    return {
      status: "timeout",
      message: `hook timed out${result.error === undefined ? "" : `: ${result.error}`}`,
    };
  }
  if (result.exitCode === 2) {
    const reason = result.stderr.trim().length > 0 ? result.stderr.trim() : result.stdout.trim();
    return {
      status: "blocked",
      exitCode: 2,
      output: {
        decision: "block",
        reason: reason.length > 0 ? reason : "blocked by hook (exit 2)",
      },
    };
  }

  const stdout = result.stdout.trim();
  if (result.stdoutTruncated && stdout.length > 0) {
    return { status: "error", exitCode: result.exitCode, message: "hook output was truncated" };
  }
  if (stdout.length > 0) {
    const output = parseHookJson(stdout);
    if (output !== undefined) {
      return {
        status: "success",
        exitCode: result.exitCode,
        output,
        message:
          result.exitCode === 0
            ? undefined
            : firstLine(`hook exited ${result.exitCode}; its JSON decision was applied`),
      };
    }
  }

  if (result.error !== undefined && result.exitCode !== 0 && stdout.length === 0) {
    return { status: "error", exitCode: result.exitCode, message: result.error };
  }

  if (result.exitCode === 0) {
    // Claude: plain text, or nothing, is a successful hook with no decision.
    return { status: "success", output: {}, plainText: stdout.length > 0 ? stdout : undefined };
  }

  return {
    status: "error",
    exitCode: result.exitCode,
    message: firstLine(result.stderr.trim() || stdout || `hook exited ${result.exitCode}`),
  };
}

export function parseHttpOutput(result: HttpResult): ParsedOutput {
  if (result.status === 0) return { status: "error", message: result.error ?? "http hook failed" };
  if (result.status < 200 || result.status > 299) {
    return { status: "error", message: `http hook returned ${result.status}` };
  }
  if (result.body.trim().length === 0) return { status: "success", output: {} };
  const output = parseHookJson(result.body);
  if (output === undefined)
    return { status: "error", message: "invalid JSON in http hook response" };
  return { status: "success", output };
}

export function parsePromptOutput(text: string): ParsedOutput {
  const output = parseHookJson(text);
  if (output === undefined) return { status: "error", message: "prompt hook did not return JSON" };
  return { status: "success", output };
}

const PERMISSION_RANK: Readonly<Record<"allow" | "ask" | "deny", number>> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

const TOOL_EVENTS = new Set<HookEventName>(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

export interface DecisionInput {
  readonly sourceID: string;
  readonly sourceLabel: string;
  readonly event: HookEventName;
  readonly status: HandlerStatus;
  readonly output?: RawHookOutput;
  readonly message?: string;
  readonly onFailure?: "continue" | "block";
}

/**
 * Merge hook decisions. Safety wins: deny beats ask beats allow, and any
 * remaining stop request stops the session. Context strings are concatenated
 * in registration order.
 */
export function mergeDecisions(event: HookEventName, inputs: readonly DecisionInput[]): Decision {
  const decision = emptyDecision();
  const reasons: string[] = [];
  for (const input of inputs) {
    if (input.status === "error" || input.status === "timeout") {
      if (input.onFailure === "block") {
        decision.blocked = true;
        reasons.push(input.message ?? `${input.event} hook failed`);
      }
      continue;
    }
    if (input.status !== "success" && input.status !== "blocked") continue;
    const output = input.output ?? {};
    if (output.continue === false) {
      decision.stop = true;
      decision.stopReason =
        output.stopReason ?? output.reason ?? input.message ?? "stopped by hook";
    }
    if (output.systemMessage !== undefined && output.systemMessage.length > 0) {
      decision.systemMessages.push(output.systemMessage);
    }
    if (output.permissionDecision !== undefined) {
      const current = decision.permission;
      if (
        current === undefined ||
        PERMISSION_RANK[output.permissionDecision] > PERMISSION_RANK[current]
      ) {
        decision.permission = output.permissionDecision;
        if (output.permissionDecisionReason !== undefined)
          reasons.push(output.permissionDecisionReason);
      }
    }
    if (output.decision === "approve" && decision.permission === undefined)
      decision.permission = "allow";
    if (output.decision === "block") {
      if (TOOL_EVENTS.has(event) && event !== "PreToolUse") decision.blocked = true;
      else if (event === "PreToolUse") {
        decision.permission = "deny";
      } else decision.blocked = true;
      if (output.reason !== undefined) reasons.push(output.reason);
      else if (input.message !== undefined) reasons.push(input.message);
    }
    if (output.updatedInput !== undefined && event === "PreToolUse") {
      decision.updatedInput = { ...(decision.updatedInput ?? {}), ...output.updatedInput };
    }
    if (output.additionalContext !== undefined && output.additionalContext.length > 0) {
      decision.additionalContext.push(output.additionalContext);
    }
    if (output.customInstructions !== undefined && output.customInstructions.length > 0) {
      decision.customInstructions.push(output.customInstructions);
    }
    if (output.retry === true) decision.retry = true;
  }
  if (decision.permission === "deny") decision.blocked = true;
  if (reasons.length > 0) decision.reason = reasons.join("\n");
  return decision;
}
