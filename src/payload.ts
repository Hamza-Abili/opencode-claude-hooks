import type { HookEventName, RunScope } from "./types.ts";

export function basePayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string
): Record<string, unknown> {
  return {
    session_id: scope.sessionID,
    transcript_path: "",
    cwd,
    permission_mode: scope.permissionMode ?? "default",
    hook_event_name: event,
  };
}

export function promptPayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string,
  prompt: string
): Record<string, unknown> {
  return { ...basePayload(event, scope, cwd), prompt };
}

export function toolPayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseID: string
): Record<string, unknown> {
  return {
    ...basePayload(event, scope, cwd),
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  };
}

export function sessionStartPayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string,
  source: "startup" | "resume" | "compact" | "fork"
): Record<string, unknown> {
  return { ...basePayload(event, scope, cwd), source };
}

export function stopPayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string,
  stopHookActive: boolean
): Record<string, unknown> {
  return { ...basePayload(event, scope, cwd), stop_hook_active: stopHookActive };
}

export function subagentPayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string,
  agentID: string,
  agentType: string
): Record<string, unknown> {
  return {
    ...basePayload(event, scope, cwd),
    agent_id: agentID,
    agent_type: agentType,
    stop_hook_active: false,
  };
}

export function notificationPayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string,
  type: string,
  message: string,
  title?: string
): Record<string, unknown> {
  return {
    ...basePayload(event, scope, cwd),
    notification_type: type,
    message,
    title,
  };
}

export function compactPayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string,
  trigger: "auto" | "manual"
): Record<string, unknown> {
  return { ...basePayload(event, scope, cwd), trigger, custom_instructions: "" };
}

export function sessionEndPayload(
  event: HookEventName,
  scope: RunScope,
  cwd: string,
  reason: string
): Record<string, unknown> {
  return { ...basePayload(event, scope, cwd), reason };
}
