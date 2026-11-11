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
import { discover } from "./sources.ts";
import {
  DOCTOR_COMMAND,
  STATUS_TOOL_DESCRIPTION,
  STATUS_TOOL_INPUT,
  STATUS_TOOL_NAME,
  statusTool,
} from "./tool.ts";
import {
  claudeToolInput,
  claudeToolName,
  opencodeToolInput,
  toolResponsePreview,
} from "./tools.ts";
import type { AdapterEnvironment, Host, ModelRef, RunScope, SkillLike } from "./types.ts";
import { redact } from "./util.ts";

type Json = Record<string, unknown>;

interface Disposable {
  dispose(): Promise<void> | void;
}

interface V2Context {
  readonly app?: { readonly version?: string };
  readonly location?: { readonly directory?: string };
  readonly options?: unknown;
  readonly skill?: { list(): Promise<unknown> };
  readonly mcp?: { list(): Promise<unknown> };
  readonly permission?: {
    assert(input: Json): Promise<void>;
    hook?(name: "evaluate", callback: (event: Json) => Promise<void> | void): Promise<Disposable>;
  };
  readonly experimental?: { generate?: { text(input: Json): Promise<{ text: string }> } };
  readonly generate?: { text(input: Json): Promise<{ text: string }> };
  readonly model?: { default(): Promise<unknown> };
  readonly session: {
    hook(
      name: string,
      callback: (event: Json) => Promise<void> | void,
      options?: Json
    ): Promise<Disposable>;
    get(input: { sessionID: string }): Promise<{ parentID?: string; agent?: string }>;
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
    interrupt(input: { sessionID: string; resume?: boolean }): Promise<unknown>;
    prompt(input: Json): Promise<unknown>;
  };
  readonly tool?: {
    transform(callback: (editor: { add(tool: Json): void }) => void): Promise<Disposable>;
    hook?(name: string, callback: (event: Json) => Promise<void> | void): Promise<Disposable>;
  };
  readonly command?: {
    transform(callback: (editor: { add(command: Json): void }) => void): Promise<Disposable>;
  };
  readonly event?: {
    subscribe(input: {
      types?: readonly string[];
      signal?: AbortSignal;
    }): AsyncIterable<{ type: string; data?: Json }>;
  };
}

interface Tracked {
  agent?: string;
  parentID?: string;
  started: boolean;
  stopActive: boolean;
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

function mcpServers(value: unknown): string[] {
  const data = Array.isArray(value)
    ? value
    : Array.isArray(object(value).data)
      ? (object(value).data as unknown[])
      : [];
  return data
    .map((entry) => (typeof entry === "string" ? entry : stringField(entry, "name")))
    .filter((entry): entry is string => entry !== undefined);
}

function skillList(value: unknown): readonly SkillLike[] {
  const data = Array.isArray(value) ? value : object(value).data;
  return Array.isArray(data) ? (data as SkillLike[]) : [];
}

async function toolFailure(message: string): Promise<Error> {
  try {
    const specifier = "@opencode/plugin";
    const module = (await import(specifier)) as {
      Tool?: { Error?: new (input: { message: string }) => Error };
    };
    if (module.Tool?.Error !== undefined) return new module.Tool.Error({ message });
  } catch {
    // V1, or the authoring package is not resolvable at runtime.
  }
  const error = new Error(message);
  error.name = "Tool.Error";
  return error;
}

function contextBlock(text: string): string {
  return `<claude-hooks-context>\n${text}\n</claude-hooks-context>`;
}

/**
 * V2 adapter: translate OpenCode session/tool/shell events into Claude hook
 * executions. Every registration is disposed on unload.
 */
function debug(...values: unknown[]): void {
  if (process.env.OPENCODE_CLAUDE_HOOKS_DEBUG === "1") {
    console.error("[opencode-claude-hooks:debug]", ...values);
  }
}

export async function setup(
  input: unknown,
  environment: AdapterEnvironment = {}
): Promise<() => Promise<void>> {
  const ctx = input as V2Context;
  const directory = ctx.location?.directory ?? process.cwd();
  const home = environment.home ?? homedir();
  const options = parseOptions(ctx.options, directory, home);
  debug("setup", directory);
  const skills = ctx.skill === undefined ? [] : skillList(await ctx.skill.list());
  debug("skills", skills.length);
  const discovery = await discover({ directory, home, options, skills, env: process.env });
  const servers = ctx.mcp === undefined ? [] : mcpServers(await ctx.mcp.list());

  const generate = ctx.experimental?.generate?.text ?? ctx.generate?.text;
  const modelDefault = ctx.model;
  const permission = ctx.permission;
  const host: Host = {
    directory,
    home,
    env: process.env,
    generateText:
      generate === undefined
        ? undefined
        : async ({ model, prompt }) => {
            const result = await generate({
              model: { providerID: model.providerID, id: model.modelID },
              prompt,
            });
            return result.text;
          },
    defaultModel:
      modelDefault === undefined
        ? undefined
        : async (): Promise<ModelRef | undefined> => {
            const info = await modelDefault.default();
            const providerID = stringField(info, "providerID");
            const id = stringField(info, "id") ?? stringField(info, "modelID");
            return providerID !== undefined && id !== undefined
              ? { providerID, modelID: id }
              : undefined;
          },
    assertTrust:
      permission === undefined
        ? undefined
        : async ({ sessionID, fingerprint, summary, message }) => {
            if (sessionID === undefined) return false;
            try {
              await permission.assert({
                sessionID,
                action: "claude_hook",
                resources: [fingerprint.slice(0, 16)],
                save: [],
                metadata: { source: summary, message },
              });
              return true;
            } catch {
              return false;
            }
          },
    status: (message) => console.error(`[opencode-claude-hooks] ${redact(message)}`),
  };

  const runtime = new HookRuntime({
    sources: discovery.sources,
    options,
    host,
    warnings: discovery.warnings,
    unsupportedEvents: discovery.unsupportedEvents,
    unsupportedHandlers: discovery.unsupportedHandlers,
  });

  debug("sources", discovery.sources.length, "trust", options.trust);
  await runtime.prefetchTrust();

  const disposables: Disposable[] = [];
  if (permission?.hook !== undefined) {
    disposables.push(
      await permission.hook("evaluate", (event) => {
        if (event.action === "claude_hook") event.effect = "ask";
      })
    );
  }
  const controller = new AbortController();
  const sessions = new Map<string, Tracked>();

  const tracked = (sessionID: string): Tracked => {
    const current = sessions.get(sessionID);
    if (current !== undefined) return current;
    const created: Tracked = { started: false, stopActive: false, skills: new Set() };
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

  const register = async (
    name: string,
    callback: (event: Json) => Promise<void> | void
  ): Promise<void> => {
    disposables.push(await ctx.session.hook(name, callback));
  };

  const registerTool = async (
    name: string,
    callback: (event: Json) => Promise<void> | void
  ): Promise<void> => {
    if (ctx.tool?.hook === undefined) return;
    disposables.push(await ctx.tool.hook(name, callback));
  };

  // UserPromptSubmit ---------------------------------------------------------
  await register("prompt", async (event) => {
    debug("prompt hook", event.sessionID);
    const prompt = object(event.prompt);
    const text = typeof prompt.text === "string" ? prompt.text : "";
    if (text.length === 0) return;
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
    if (sessionID.length === 0) return;
    const current = tracked(sessionID);
    current.stopActive = false;
    runtime.noteActivity(sessionID);
    const contexts: string[] = [];
    if (!current.started) {
      current.started = true;
      const started = await runtime.run(
        "SessionStart",
        sessionStartPayload("SessionStart", scopeFor(sessionID), directory, "startup"),
        scopeFor(sessionID)
      );
      for (const message of started.decision.systemMessages) host.status?.(message);
      if (started.decision.stop) {
        throw new Error(started.decision.stopReason ?? "stopped by hook");
      }
      contexts.push(...started.decision.additionalContext);
    }
    const result = await runtime.run(
      "UserPromptSubmit",
      promptPayload("UserPromptSubmit", scopeFor(sessionID), directory, text),
      scopeFor(sessionID)
    );
    for (const message of result.decision.systemMessages) host.status?.(message);
    if (result.decision.stop || result.decision.blocked) {
      throw new Error(
        result.decision.stopReason ?? result.decision.reason ?? "blocked by Claude Code hook"
      );
    }
    contexts.push(...result.decision.additionalContext);
    if (contexts.length > 0) {
      prompt.text = `${contextBlock(contexts.join("\n\n"))}\n\n${text}`;
    }
  });

  // PreToolUse ---------------------------------------------------------------
  await registerTool("execute.before", async (event) => {
    debug("pre hook", event.tool);
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
    if (sessionID.length === 0) return;
    const current = tracked(sessionID);
    runtime.noteActivity(sessionID);
    const tool = typeof event.tool === "string" ? event.tool : "";
    if (tool === "skill") {
      const skillID = stringField(event.input, "name") ?? stringField(event.input, "id");
      if (skillID !== undefined) current.skills.add(skillID);
    }
    const claudeName = claudeToolName(tool, servers);
    const claudeInput = claudeToolInput(tool, event.input);
    const result = await runtime.run(
      "PreToolUse",
      toolPayload(
        "PreToolUse",
        scopeFor(sessionID),
        directory,
        claudeName,
        claudeInput,
        String(event.id ?? "")
      ),
      scopeFor(sessionID)
    );
    debug("pre decision", result.decision.permission, result.decision.blocked);
    for (const message of result.decision.systemMessages) host.status?.(message);
    const reason =
      result.decision.stopReason ?? result.decision.reason ?? "blocked by Claude Code hook";
    if (result.decision.blocked || result.decision.permission === "deny" || result.decision.stop) {
      throw await toolFailure(reason);
    }
    if (result.decision.permission === "ask") {
      if (ctx.permission === undefined) throw await toolFailure(reason);
      try {
        await ctx.permission.assert({
          sessionID,
          agent: event.agent,
          action: "claude_hook",
          resources: [claudeName],
          save: [],
          source: { type: "tool", messageID: event.messageID, id: event.id },
          metadata: { hook: "PreToolUse", tool: claudeName, message: reason },
        });
      } catch {
        throw await toolFailure(reason);
      }
    }
    if (result.decision.updatedInput !== undefined) {
      const updated = opencodeToolInput(
        tool,
        claudeName,
        result.decision.updatedInput,
        event.input
      );
      if (updated !== undefined) event.input = updated;
      else host.status?.(`ignored updatedInput for unsupported tool ${claudeName}`);
    }
  });

  // PostToolUse / PostToolUseFailure ----------------------------------------
  await registerTool("execute.after", async (event) => {
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
    if (sessionID.length === 0) return;
    runtime.noteActivity(sessionID);
    const tool = typeof event.tool === "string" ? event.tool : "";
    const claudeName = claudeToolName(tool, servers);
    const claudeInput = claudeToolInput(tool, event.input);
    const completed = event.status === "completed";
    const eventName = completed ? "PostToolUse" : "PostToolUseFailure";
    const response = completed
      ? toolResponsePreview(object(event.result).content)
      : (stringField(event.error, "message") ?? "tool failed");
    const result = await runtime.run(
      eventName,
      {
        ...toolPayload(
          eventName,
          scopeFor(sessionID),
          directory,
          claudeName,
          claudeInput,
          String(event.id ?? "")
        ),
        tool_response: response,
      },
      scopeFor(sessionID)
    );
    for (const message of result.decision.systemMessages) host.status?.(message);
    if (result.decision.stop) {
      await ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined);
    }
    if (!completed) {
      if (result.decision.blocked) {
        // Keep the Tool.Error instance: the V2 core yields it as an Effect
        // error, so replacing it with a plain object breaks the contract.
        const error = object(event.error);
        const current = stringField(error, "message");
        const reason = result.decision.reason ?? "blocked by Claude Code hook";
        error.message = current === undefined ? reason : `${current}\n\n${reason}`;
        event.error = error;
      }
      return;
    }
    const toolResult = object(event.result);
    if (result.decision.stop) {
      event.result = {
        content: result.decision.stopReason ?? result.decision.reason ?? "stopped by hook",
      };
      return;
    }
    if (result.decision.blocked) {
      event.result = { content: result.decision.reason ?? "blocked by Claude Code hook" };
      return;
    }
    if (result.decision.additionalContext.length > 0) {
      const extra = contextBlock(result.decision.additionalContext.join("\n\n"));
      const content = toolResult.content;
      if (typeof content === "string") toolResult.content = `${content}\n\n${extra}`;
      else if (Array.isArray(content)) content.push({ type: "text", text: extra });
      else toolResult.content = extra;
      event.result = toolResult;
    }
  });

  // SessionStart context ----------------------------------------------------
  await register("context", async (event) => {
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
    if (sessionID.length === 0) return;
    const current = tracked(sessionID);
    if (current.started) return;
    current.started = true;
    const result = await runtime.run(
      "SessionStart",
      sessionStartPayload("SessionStart", scopeFor(sessionID), directory, "startup"),
      scopeFor(sessionID)
    );
    for (const message of result.decision.systemMessages) host.status?.(message);
    if (result.decision.stop) {
      throw new Error(result.decision.stopReason ?? result.decision.reason ?? "stopped by hook");
    }
    const context = result.decision.additionalContext.join("\n\n");
    if (context.length > 0 && Array.isArray(event.system)) {
      event.system.push({ type: "text", text: contextBlock(context) });
    }
  });

  // PreCompact --------------------------------------------------------------
  await register("compaction", async (event) => {
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
    if (sessionID.length === 0) return;
    const result = await runtime.run(
      "PreCompact",
      compactPayload("PreCompact", scopeFor(sessionID), directory, "auto"),
      scopeFor(sessionID)
    );
    for (const message of result.decision.systemMessages) host.status?.(message);
    const instructions = [
      ...result.decision.customInstructions,
      ...result.decision.additionalContext,
    ].join("\n\n");
    if (instructions.length > 0 && Array.isArray(event.system)) {
      event.system.push({ type: "text", text: contextBlock(instructions) });
    }
  });

  // Stop / SubagentStop -----------------------------------------------------
  await register("experimental.idle", async (event) => {
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
    if (sessionID.length === 0) return;
    const current = sessions.get(sessionID);
    if (current === undefined || !current.started) return;
    const info = await ctx.session.get({ sessionID }).catch(() => undefined);
    const parentID = info?.parentID ?? current.parentID;
    const agent = info?.agent ?? current.agent ?? "general";
    const isChild = parentID !== undefined;
    const eventName = isChild ? "SubagentStop" : "Stop";
    const payload = isChild
      ? subagentPayload(eventName, scopeFor(sessionID), directory, sessionID, agent)
      : stopPayload(eventName, scopeFor(sessionID), directory, current.stopActive);
    if (isChild) payload.stop_hook_active = current.stopActive;
    const result = await runtime.run(eventName, payload, scopeFor(sessionID));
    for (const message of result.decision.systemMessages) host.status?.(message);
    if (result.decision.stop) {
      current.stopActive = false;
      return;
    }
    if (result.decision.blocked) {
      current.stopActive = true;
      await ctx.session.synthetic({
        sessionID,
        text: result.decision.reason ?? "Continue.",
      });
      return;
    }
    if (result.decision.additionalContext.length > 0) {
      current.stopActive = true;
      await ctx.session.synthetic({
        sessionID,
        text: result.decision.additionalContext.join("\n\n"),
      });
      return;
    }
    current.stopActive = false;
  });

  // Async lifecycle events --------------------------------------------------
  const eventDomain = ctx.event;
  if (eventDomain !== undefined) {
    void (async () => {
      for await (const event of eventDomain.subscribe({
        signal: controller.signal,
        types: [
          "session.created",
          "session.deleted",
          "permission.asked",
          "session.compaction.ended",
          "session.execution.failed",
          "session.skill.activated",
        ],
      })) {
        const data = object(event.data);
        const sessionID =
          typeof data.sessionID === "string" ? data.sessionID : stringField(data, "id");
        if (sessionID === undefined) continue;
        if (event.type === "session.created") {
          const created = tracked(sessionID);
          created.agent = typeof data.agent === "string" ? data.agent : undefined;
          created.parentID = typeof data.parentID === "string" ? data.parentID : undefined;
          if (created.parentID !== undefined) {
            void runtime.run(
              "SubagentStart",
              subagentPayload(
                "SubagentStart",
                scopeFor(sessionID),
                directory,
                sessionID,
                created.agent ?? "general"
              ),
              scopeFor(sessionID)
            );
          }
          continue;
        }
        if (event.type === "session.skill.activated") {
          const id =
            typeof data.id === "string"
              ? data.id
              : typeof data.name === "string"
                ? data.name
                : undefined;
          if (id !== undefined) tracked(sessionID).skills.add(id);
          continue;
        }
        if (event.type === "session.deleted") {
          void runtime.run(
            "SessionEnd",
            sessionEndPayload("SessionEnd", scopeFor(sessionID), directory, "other"),
            scopeFor(sessionID)
          );
          sessions.delete(sessionID);
          continue;
        }
        if (event.type === "permission.asked") {
          void runtime.run(
            "Notification",
            notificationPayload(
              "Notification",
              scopeFor(sessionID),
              directory,
              "permission_prompt",
              typeof data.message === "string"
                ? data.message
                : `Permission requested: ${String(data.action ?? "tool")}`,
              stringField(data, "title")
            ),
            scopeFor(sessionID)
          );
          continue;
        }
        if (event.type === "session.compaction.ended") {
          void runtime.run(
            "PostCompact",
            compactPayload("PostCompact", scopeFor(sessionID), directory, "auto"),
            scopeFor(sessionID)
          );
          void runtime.run(
            "SessionStart",
            sessionStartPayload("SessionStart", scopeFor(sessionID), directory, "compact"),
            scopeFor(sessionID)
          );
          continue;
        }
        if (event.type === "session.execution.failed") {
          const error = object(data.error);
          void runtime.run(
            "StopFailure",
            {
              ...stopPayload("StopFailure", scopeFor(sessionID), directory, false),
              error_type: typeof error.type === "string" ? error.type : "unknown",
              error_message: typeof error.message === "string" ? error.message : undefined,
            },
            scopeFor(sessionID)
          );
        }
      }
    })().catch(() => undefined);
  }

  // Doctor command + tool ---------------------------------------------------
  if (ctx.command !== undefined) {
    disposables.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: DOCTOR_COMMAND.name,
          description: DOCTOR_COMMAND.description,
          execute: async (input: Json) => {
            const prompt = object(input.prompt);
            await ctx.session.prompt({
              ...prompt,
              sessionID: input.sessionID,
              text: DOCTOR_COMMAND.template,
              delivery: input.delivery ?? "queue",
            });
          },
        });
      })
    );
  }
  if (ctx.tool !== undefined) {
    disposables.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: STATUS_TOOL_NAME,
          description: STATUS_TOOL_DESCRIPTION,
          input: STATUS_TOOL_INPUT,
          execute: async (toolInput: unknown) => ({
            content: (await statusTool(runtime, toolInput)).content,
          }),
        });
      })
    );
  }

  debug("registered", disposables.length);
  host.status?.(`ready (sources=${discovery.sources.length}, trust=${options.trust})`);

  return async () => {
    controller.abort();
    for (const disposable of disposables.reverse()) {
      try {
        await disposable.dispose();
      } catch {
        // Unload must not throw.
      }
    }
  };
}
