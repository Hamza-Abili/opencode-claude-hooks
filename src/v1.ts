import { homedir } from "node:os";
import { parseOptions } from "./options.ts";
import {
  compactPayload,
  notificationPayload,
  promptPayload,
  sessionEndPayload,
  sessionStartPayload,
  stopPayload,
  subagentPayload,
  toolPayload,
} from "./payload.ts";
import { HookRuntime } from "./runtime.ts";
import { loadOpenCodeSkills } from "./skills.ts";
import { discover } from "./sources.ts";
import { claudeToolInput, claudeToolName, opencodeToolInput } from "./tools.ts";
import type { AdapterEnvironment, Host, RunScope } from "./types.ts";
import { redact } from "./util.ts";

type Json = Record<string, unknown>;

interface V1PluginInput {
  readonly directory?: unknown;
  readonly worktree?: unknown;
  readonly client?: {
    readonly session?: {
      abort(input: { path: { id: string } }): Promise<unknown>;
    };
  };
}

interface V1ToolBefore {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
}

interface V1ToolAfter extends V1ToolBefore {
  readonly args: unknown;
}

interface V1Hooks {
  "chat.message"?: (
    input: { sessionID: string; agent?: string },
    output: { parts: Array<Json> }
  ) => Promise<void>;
  "tool.execute.before"?: (input: V1ToolBefore, output: { args: unknown }) => Promise<void>;
  "tool.execute.after"?: (
    input: V1ToolAfter,
    output: { title: string; output: string; metadata: unknown }
  ) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string },
    output: { system: string[] }
  ) => Promise<void>;
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string }
  ) => Promise<void>;
  event?: (input: { event: { type: string; properties?: Json } }) => Promise<void>;
  dispose?: () => Promise<void>;
}

interface Tracked {
  agent?: string;
  parentID?: string;
  started: boolean;
  skills: Set<string>;
}

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function stringField(value: unknown, key: string): string | undefined {
  const field = object(value)[key];
  return typeof field === "string" ? field : undefined;
}

function contextBlock(text: string): string {
  return `<claude-hooks-context>\n${text}\n</claude-hooks-context>`;
}

/**
 * V1 adapter. OpenCode V1 has no shell hook and no stateless generation, so
 * prompt and HTTP hooks still run but Stop continuation and interactive trust
 * prompts are not available. The doctor reports the exact limitations.
 */
export async function server(
  input: unknown,
  options?: unknown,
  environment: AdapterEnvironment = {}
): Promise<V1Hooks> {
  const plugin = object(input) as unknown as V1PluginInput;
  const directory =
    typeof plugin.directory === "string"
      ? plugin.directory
      : typeof plugin.worktree === "string"
        ? plugin.worktree
        : process.cwd();
  const home = environment.home ?? homedir();
  const parsed = parseOptions(options, directory, home);
  const skills = await loadOpenCodeSkills(directory, home);
  const discovery = await discover({ directory, home, options: parsed, skills, env: process.env });
  const warnings = [...discovery.warnings];
  if (parsed.trust === "prompt") {
    warnings.push(
      "V1 has no interactive trust prompt; project hooks stay untrusted unless listed in options.trusted"
    );
  }

  const host: Host = {
    directory,
    home,
    env: process.env,
    status: (message) => console.error(`[opencode-claude-hooks] ${redact(message)}`),
  };
  const runtime = new HookRuntime({
    sources: discovery.sources,
    options: parsed,
    host,
    warnings,
    unsupportedEvents: discovery.unsupportedEvents,
    unsupportedHandlers: discovery.unsupportedHandlers,
  });
  await runtime.prefetchTrust();
  const sessions = new Map<string, Tracked>();

  const tracked = (sessionID: string): Tracked => {
    const current = sessions.get(sessionID);
    if (current !== undefined) return current;
    const created: Tracked = { started: false, skills: new Set() };
    sessions.set(sessionID, created);
    return created;
  };

  const scopeFor = (sessionID: string): RunScope => {
    const current = tracked(sessionID);
    return {
      sessionID,
      agent: current.agent,
      permissionMode: current.agent === "plan" ? "plan" : "default",
      activeSkills: current.skills,
    };
  };

  const hooks: V1Hooks = {
    "chat.message": async (event, output) => {
      const textPart = [...output.parts].reverse().find((part) => part.type === "text");
      if (textPart === undefined) return;
      const text = typeof textPart.text === "string" ? textPart.text : "";
      if (text.length === 0 || typeof event.sessionID !== "string") return;
      runtime.noteActivity(event.sessionID);
      const current = tracked(event.sessionID);
      if (typeof event.agent === "string") current.agent = event.agent;
      const contexts: string[] = [];
      if (!current.started) {
        current.started = true;
        const started = await runtime.run(
          "SessionStart",
          sessionStartPayload("SessionStart", scopeFor(event.sessionID), directory, "startup"),
          scopeFor(event.sessionID)
        );
        for (const message of started.decision.systemMessages) host.status?.(message);
        if (started.decision.stop) {
          throw new Error(started.decision.stopReason ?? "stopped by hook");
        }
        contexts.push(...started.decision.additionalContext);
      }
      const result = await runtime.run(
        "UserPromptSubmit",
        promptPayload("UserPromptSubmit", scopeFor(event.sessionID), directory, text),
        scopeFor(event.sessionID)
      );
      for (const message of result.decision.systemMessages) host.status?.(message);
      if (result.decision.stop || result.decision.blocked) {
        throw new Error(
          result.decision.stopReason ?? result.decision.reason ?? "blocked by Claude Code hook"
        );
      }
      contexts.push(...result.decision.additionalContext);
      if (contexts.length > 0) {
        textPart.text = `${contextBlock(contexts.join("\n\n"))}\n\n${text}`;
      }
    },

    "tool.execute.before": async (event, output) => {
      if (typeof event.sessionID !== "string") return;
      runtime.noteActivity(event.sessionID);
      const current = tracked(event.sessionID);
      if (event.tool === "skill") {
        const skillID = stringField(output.args, "name") ?? stringField(output.args, "id");
        if (skillID !== undefined) current.skills.add(skillID);
      }
      const claudeName = claudeToolName(event.tool);
      const claudeInput = claudeToolInput(event.tool, output.args, "v1");
      const result = await runtime.run(
        "PreToolUse",
        toolPayload(
          "PreToolUse",
          scopeFor(event.sessionID),
          directory,
          claudeName,
          claudeInput,
          event.callID
        ),
        scopeFor(event.sessionID)
      );
      for (const message of result.decision.systemMessages) host.status?.(message);
      const reason =
        result.decision.stopReason ?? result.decision.reason ?? "blocked by Claude Code hook";
      if (
        result.decision.blocked ||
        result.decision.permission === "deny" ||
        result.decision.permission === "ask" ||
        result.decision.stop
      ) {
        throw new Error(reason);
      }
      if (result.decision.updatedInput !== undefined) {
        const updated = opencodeToolInput(
          event.tool,
          claudeName,
          result.decision.updatedInput,
          output.args,
          "v1"
        );
        if (updated !== undefined && typeof output.args === "object" && output.args !== null) {
          // V1 retains the original args object, so mutate it instead of
          // replacing the reference.
          Object.assign(output.args, updated);
        } else if (updated === undefined) {
          host.status?.(`ignored updatedInput for unsupported tool ${claudeName}`);
        }
      }
    },

    "tool.execute.after": async (event, output) => {
      if (typeof event.sessionID !== "string") return;
      runtime.noteActivity(event.sessionID);
      const claudeName = claudeToolName(event.tool);
      const claudeInput = claudeToolInput(event.tool, event.args, "v1");
      const result = await runtime.run(
        "PostToolUse",
        {
          ...toolPayload(
            "PostToolUse",
            scopeFor(event.sessionID),
            directory,
            claudeName,
            claudeInput,
            event.callID
          ),
          tool_response: output.output,
        },
        scopeFor(event.sessionID)
      );
      for (const message of result.decision.systemMessages) host.status?.(message);
      if (result.decision.stop) {
        void plugin.client?.session
          ?.abort({ path: { id: event.sessionID } })
          .catch(() => undefined);
        output.output =
          result.decision.stopReason ?? result.decision.reason ?? "stopped by Claude Code hook";
        return;
      }
      if (result.decision.blocked) {
        output.output = result.decision.reason ?? "blocked by Claude Code hook";
        return;
      }
      if (result.decision.additionalContext.length > 0) {
        output.output = `${output.output}\n\n${contextBlock(result.decision.additionalContext.join("\n\n"))}`;
      }
    },

    "experimental.chat.system.transform": async (event, output) => {
      if (typeof event.sessionID !== "string") return;
      const current = tracked(event.sessionID);
      if (current.started) return;
      current.started = true;
      const result = await runtime.run(
        "SessionStart",
        sessionStartPayload("SessionStart", scopeFor(event.sessionID), directory, "startup"),
        scopeFor(event.sessionID)
      );
      for (const message of result.decision.systemMessages) host.status?.(message);
      if (result.decision.stop) {
        throw new Error(result.decision.stopReason ?? "stopped by hook");
      }
      const context = result.decision.additionalContext.join("\n\n");
      if (context.length > 0) output.system.push(contextBlock(context));
    },

    "experimental.session.compacting": async (event, output) => {
      if (typeof event.sessionID !== "string") return;
      const result = await runtime.run(
        "PreCompact",
        compactPayload("PreCompact", scopeFor(event.sessionID), directory, "auto"),
        scopeFor(event.sessionID)
      );
      for (const message of result.decision.systemMessages) host.status?.(message);
      const instructions = [
        ...result.decision.customInstructions,
        ...result.decision.additionalContext,
      ].join("\n\n");
      if (instructions.length > 0) output.context.push(contextBlock(instructions));
    },

    event: async ({ event }) => {
      const data = object(event.properties);
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
      const info = object(data.info);
      const id = sessionID ?? (typeof info.id === "string" ? info.id : undefined);
      if (event.type === "session.created") {
        if (id === undefined) return;
        const current = tracked(id);
        current.parentID = typeof info.parentID === "string" ? info.parentID : undefined;
        if (typeof info.agent === "string") current.agent = info.agent;
        if (current.parentID !== undefined) {
          await runtime.run(
            "SubagentStart",
            subagentPayload(
              "SubagentStart",
              scopeFor(id),
              directory,
              id,
              current.agent ?? "general"
            ),
            scopeFor(id)
          );
        }
        return;
      }
      if (id === undefined) return;
      if (event.type === "session.idle") {
        const current = tracked(id);
        if (!current.started) return;
        const isChild = current.parentID !== undefined;
        const eventName = isChild ? "SubagentStop" : "Stop";
        const payload = isChild
          ? subagentPayload(eventName, scopeFor(id), directory, id, current.agent ?? "general")
          : stopPayload(eventName, scopeFor(id), directory, false);
        const result = await runtime.run(eventName, payload, scopeFor(id));
        if (result.decision.blocked || result.decision.stop) {
          host.status?.(`a ${eventName} hook blocked this turn; V1 cannot continue automatically`);
        }
        return;
      }
      if (event.type === "session.deleted") {
        await runtime.run(
          "SessionEnd",
          sessionEndPayload("SessionEnd", scopeFor(id), directory, "other"),
          scopeFor(id)
        );
        sessions.delete(id);
        return;
      }
      if (event.type === "session.compacted") {
        await runtime.run(
          "PostCompact",
          compactPayload("PostCompact", scopeFor(id), directory, "auto"),
          scopeFor(id)
        );
        await runtime.run(
          "SessionStart",
          sessionStartPayload("SessionStart", scopeFor(id), directory, "compact"),
          scopeFor(id)
        );
        return;
      }
      if (event.type === "session.error") {
        const error = object(data.error);
        await runtime.run(
          "StopFailure",
          {
            ...stopPayload("StopFailure", scopeFor(id), directory, false),
            error_type: typeof error.name === "string" ? error.name : "unknown",
            error_message: typeof error.message === "string" ? error.message : undefined,
          },
          scopeFor(id)
        );
        return;
      }
      if (event.type === "permission.updated") {
        await runtime.run(
          "Notification",
          notificationPayload(
            "Notification",
            scopeFor(id),
            directory,
            "permission_prompt",
            String(data.title ?? "Permission requested")
          ),
          scopeFor(id)
        );
      }
    },
  };

  return hooks;
}
