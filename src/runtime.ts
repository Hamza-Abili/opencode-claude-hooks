import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { runCommand } from "./exec.ts";
import { runHttp } from "./http.ts";
import { isToolEvent, matchesIf, matchesTool } from "./matcher.ts";
import {
  type DecisionInput,
  mergeDecisions,
  parseCommandOutput,
  parseHttpOutput,
  parsePromptOutput,
} from "./output.ts";
import { hookFingerprint, hookSummary, TrustManager } from "./trust.ts";
import type {
  Decision,
  DoctorReport,
  DoctorSource,
  HandlerResult,
  HookEntry,
  HookEventName,
  HookHandler,
  HookSource,
  Host,
  Options,
  RunResult,
  RunScope,
} from "./types.ts";
import { emptyDecision } from "./types.ts";
import { firstLine, redact } from "./util.ts";
import { VERSION } from "./version.ts";

const CONCURRENCY = 8;

export interface RuntimeInput {
  readonly sources: readonly HookSource[];
  readonly options: Options;
  readonly host: Host;
  readonly warnings?: readonly string[];
  readonly unsupportedEvents?: readonly string[];
  readonly unsupportedHandlers?: readonly string[];
}

interface Execution {
  readonly source: HookSource;
  readonly entry: HookEntry;
  readonly handler: HookHandler;
  readonly groupMatcher?: string;
}

function matcherValue(event: HookEventName, payload: Record<string, unknown>): string | undefined {
  const value = (key: string): string | undefined =>
    typeof payload[key] === "string" ? (payload[key] as string) : undefined;
  switch (event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      return value("tool_name");
    case "SessionStart":
      return value("source");
    case "Notification":
      return value("notification_type");
    case "SubagentStart":
    case "SubagentStop":
      return value("agent_type");
    case "PreCompact":
    case "PostCompact":
      return value("trigger");
    case "StopFailure":
      return value("error_type");
    case "SessionEnd":
      return value("reason");
    default:
      return undefined;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      output[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return output;
}

export class HookRuntime {
  private readonly trust: TrustManager;
  private readonly once = new Set<string>();
  private readonly stops = new Map<string, number>();
  private readonly warnings: string[];
  private readonly unsupportedEvents: string[];
  private readonly unsupportedHandlers: string[];

  constructor(private readonly input: RuntimeInput) {
    this.trust = new TrustManager(input.options, input.host.home, input.host.env, input.host);
    this.warnings = [...(input.warnings ?? [])];
    this.unsupportedEvents = [...(input.unsupportedEvents ?? [])];
    this.unsupportedHandlers = [...(input.unsupportedHandlers ?? [])];
  }

  get options(): Options {
    return this.input.options;
  }

  get sources(): readonly HookSource[] {
    return this.input.sources;
  }

  pendingTrust(): readonly string[] {
    return this.report().pendingTrust;
  }

  /** Reset the Stop-hook continuation counter after real user or tool activity. */
  noteActivity(sessionID: string): void {
    this.stops.delete(sessionID);
  }

  async prefetchTrust(): Promise<void> {
    await this.trust.prefetch();
  }

  private active(source: HookSource, scope: RunScope): boolean {
    if (source.activator === undefined) return true;
    if (source.activator.kind === "skill") {
      return scope.activeSkills?.has(source.activator.id) === true;
    }
    const agent = scope.agent ?? "";
    return agent === source.activator.id || agent.endsWith(`:${source.activator.id}`);
  }

  private executions(
    event: HookEventName,
    payload: Record<string, unknown>,
    scope: RunScope
  ): Execution[] {
    if (this.input.options.disabledEvents.includes(event)) return [];
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    const value = matcherValue(event, payload);
    const output: Execution[] = [];
    for (const source of this.input.sources) {
      if (!this.active(source, scope)) continue;
      for (const entry of source.entries) {
        if (entry.event !== event) continue;
        if (value !== undefined && !matchesTool(entry.group.matcher, value)) continue;
        for (const handler of entry.group.hooks) {
          if (handler.if !== undefined) {
            if (!isToolEvent(event) || toolName === undefined) continue;
            if (!matchesIf(handler.if, toolName, payload.tool_input)) continue;
          }
          output.push({ source, entry, handler, groupMatcher: entry.group.matcher });
        }
      }
    }
    return output;
  }

  private modelFor(
    handler: Extract<HookHandler, { type: "prompt" }>
  ): Promise<{ providerID: string; modelID: string } | undefined> {
    if (handler.model !== undefined) {
      const slash = handler.model.indexOf("/");
      if (slash > 0) {
        return Promise.resolve({
          providerID: handler.model.slice(0, slash),
          modelID: handler.model.slice(slash + 1),
        });
      }
    }
    if (this.input.options.promptModel !== undefined)
      return Promise.resolve(this.input.options.promptModel);
    return this.input.host.defaultModel?.() ?? Promise.resolve(undefined);
  }

  private async promptHook(
    handler: Extract<HookHandler, { type: "prompt" }>,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<
    { kind: "ok"; text: string } | { kind: "disabled" } | { kind: "error"; message: string }
  > {
    if (!this.input.options.allowPromptHooks || this.input.host.generateText === undefined) {
      return { kind: "disabled" };
    }
    const model = await this.modelFor(handler);
    if (model === undefined) return { kind: "disabled" };
    const argumentsJson = JSON.stringify(payload, null, 2);
    const prompt = `${handler.prompt.includes("$ARGUMENTS") ? handler.prompt.split("$ARGUMENTS").join(argumentsJson) : `${handler.prompt}\n\nHook input JSON:\n${argumentsJson}`}\n\nReturn ONLY a JSON object for the Claude Code prompt-hook response schema: {"ok":true} to allow, or {"ok":false,"reason":"..."} to reject. No prose, no code fences.`;
    try {
      const text = await this.input.host.generateText({ model, prompt, signal });
      return { kind: "ok", text };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async execute(
    execution: Execution,
    event: HookEventName,
    payload: Record<string, unknown>,
    scope: RunScope,
    signal?: AbortSignal
  ): Promise<HandlerResult> {
    const started = this.input.host.now?.() ?? Date.now();
    const base = {
      sourceID: execution.source.id,
      sourceLabel: execution.source.label,
      event,
      handlerType: execution.handler.type,
    } as const;
    const elapsed = (): number => (this.input.host.now?.() ?? Date.now()) - started;
    const handler = execution.handler;

    if (handler.type === "mcp_tool" || handler.type === "agent" || handler.type === "unknown") {
      return { ...base, status: "skipped", durationMs: elapsed(), message: handler.reason };
    }

    const key = `${execution.source.id}:${hookFingerprint(execution.source, handler, event, execution.groupMatcher)}`;
    if (handler.once === true && this.once.has(key)) {
      return {
        ...base,
        status: "skipped",
        durationMs: elapsed(),
        message: "once hook already ran",
      };
    }

    const trusted = await this.trust.isTrusted(
      execution.source,
      handler,
      event,
      execution.groupMatcher,
      scope.sessionID
    );
    if (!trusted) {
      return {
        ...base,
        status: "untrusted",
        durationMs: elapsed(),
        message: `untrusted hook from ${execution.source.label}; review it and add its fingerprint to options.trusted`,
      };
    }

    if (handler.type === "command" && handler.statusMessage !== undefined) {
      this.input.host.status?.(handler.statusMessage);
    }

    if (handler.type === "command") {
      if (handler.async === true) {
        if (handler.once === true) this.once.add(key);
        void runCommand(
          {
            handler,
            cwd: this.input.host.directory,
            source: execution.source,
            options: this.input.options,
            env: this.input.host.env,
            stdin: JSON.stringify(payload),
            signal,
          },
          event
        )
          .then((result) => {
            if (result.exitCode !== 0 || result.timedOut) {
              this.input.host.status?.(
                `async hook ${execution.source.label} failed (exit=${result.exitCode}, timeout=${result.timedOut})`
              );
            }
          })
          .catch(() => undefined);
        return { ...base, status: "success", durationMs: elapsed(), message: "async hook started" };
      }
      const result = await runCommand(
        {
          handler,
          cwd: this.input.host.directory,
          source: execution.source,
          options: this.input.options,
          env: this.input.host.env,
          stdin: JSON.stringify(payload),
          signal,
        },
        event
      );
      const parsed = parseCommandOutput(result);
      if (parsed.status === "success" && handler.once === true) this.once.add(key);
      let output = parsed.output;
      let message = parsed.message;
      if (parsed.plainText !== undefined) {
        if (event === "SessionStart" || event === "UserPromptSubmit") {
          output = { ...(output ?? {}), additionalContext: parsed.plainText };
        } else if (event === "PreCompact") {
          output = { ...(output ?? {}), customInstructions: parsed.plainText };
        } else {
          message = parsed.plainText;
        }
      }
      return {
        ...base,
        status: parsed.status,
        exitCode: parsed.exitCode,
        durationMs: elapsed(),
        output,
        message,
      };
    }

    if (handler.type === "http") {
      const result = await runHttp({
        handler,
        source: execution.source,
        options: this.input.options,
        cwd: this.input.host.directory,
        event,
        payload,
        env: this.input.host.env,
        signal,
        fetchImpl: this.input.host.fetch,
      });
      const parsed = parseHttpOutput(result);
      if (parsed.status === "success" && handler.once === true) this.once.add(key);
      return {
        ...base,
        status: parsed.status,
        exitCode: parsed.exitCode,
        durationMs: elapsed(),
        output: parsed.output,
        message: parsed.message,
      };
    }

    // Prompt hook.
    const promptResult = await this.promptHook(handler, payload, signal);
    if (promptResult.kind === "disabled") {
      return {
        ...base,
        status: "skipped",
        durationMs: elapsed(),
        message: "prompt hooks are disabled (allowPromptHooks=false) or no model is available",
      };
    }
    if (promptResult.kind === "error") {
      return {
        ...base,
        status: "error",
        durationMs: elapsed(),
        message: promptResult.message,
      };
    }
    const parsed = parsePromptOutput(promptResult.text);
    if (parsed.status === "success" && handler.once === true) this.once.add(key);
    return {
      ...base,
      status: parsed.status,
      durationMs: elapsed(),
      output: parsed.output,
      message: parsed.message,
    };
  }

  async run(
    event: HookEventName,
    payload: Record<string, unknown>,
    scope: RunScope,
    signal?: AbortSignal
  ): Promise<RunResult> {
    const started = this.input.host.now?.() ?? Date.now();
    const executions = this.executions(event, payload, scope);
    const results = await mapLimit(executions, CONCURRENCY, (execution) =>
      this.execute(execution, event, payload, scope, signal)
    );

    const decisionInputs: DecisionInput[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const execution = executions[index];
      if (result === undefined || execution === undefined) continue;
      const onFailure =
        execution.handler.type === "command" ||
        execution.handler.type === "http" ||
        execution.handler.type === "prompt"
          ? execution.handler.onFailure
          : undefined;
      decisionInputs.push({
        sourceID: result.sourceID,
        sourceLabel: result.sourceLabel,
        event,
        status: result.status,
        output: result.output,
        message: result.message,
        exitCode: result.exitCode,
        onFailure,
      });
    }
    let decision = mergeDecisions(event, decisionInputs);
    decision = this.guardStop(event, scope.sessionID, decision);
    void this.trace(event, scope, results, decision, started);
    return {
      event,
      decision,
      results,
      durationMs: (this.input.host.now?.() ?? Date.now()) - started,
    };
  }

  private guardStop(event: HookEventName, sessionID: string, decision: Decision): Decision {
    if (event !== "Stop" && event !== "SubagentStop") return decision;
    const count = this.stops.get(sessionID) ?? 0;
    if (!decision.blocked) {
      this.stops.delete(sessionID);
      return decision;
    }
    if (count >= this.input.options.maxStopContinuations) {
      const limited = emptyDecision();
      limited.additionalContext = decision.additionalContext;
      limited.systemMessages = [
        ...decision.systemMessages,
        `Stop hook blocked ${count} times; allowing the session to stop to avoid a loop.`,
      ];
      return limited;
    }
    this.stops.set(sessionID, count + 1);
    return decision;
  }

  report(): DoctorReport {
    const sources: DoctorSource[] = this.input.sources.map((source) => {
      const events: Record<string, number> = {};
      const handlerCounts: Record<string, number> = {};
      let totalHandlers = 0;
      let trustedHandlers = 0;
      for (const entry of source.entries) {
        events[entry.event] = (events[entry.event] ?? 0) + 1;
        for (const handler of entry.group.hooks) {
          handlerCounts[handler.type] = (handlerCounts[handler.type] ?? 0) + 1;
          if (handler.type === "command" || handler.type === "http" || handler.type === "prompt") {
            totalHandlers += 1;
            if (this.trust.state(source, handler, entry.event, entry.group.matcher) === "trusted") {
              trustedHandlers += 1;
            }
          }
        }
      }
      const trusted = totalHandlers > 0 && trustedHandlers === totalHandlers;
      return {
        id: source.id,
        label: source.label,
        scope: source.scope,
        path: source.path,
        trusted,
        activator: source.activator,
        events,
        handlers: handlerCounts,
        warnings: source.warnings,
      };
    });
    const pendingTrust: string[] = [];
    for (const source of this.input.sources) {
      for (const entry of source.entries) {
        for (const handler of entry.group.hooks) {
          if (
            handler.type === "agent" ||
            handler.type === "mcp_tool" ||
            handler.type === "unknown"
          ) {
            continue;
          }
          if (this.trust.state(source, handler, entry.event, entry.group.matcher) !== "trusted") {
            const fingerprint = hookFingerprint(source, handler, entry.event, entry.group.matcher);
            pendingTrust.push(`${fingerprint} ${source.label}: ${hookSummary(handler)}`);
          }
        }
      }
    }
    return {
      version: VERSION,
      directory: this.input.host.directory,
      trust: this.input.options.trust,
      sources,
      unsupportedEvents: this.unsupportedEvents,
      unsupportedHandlers: this.unsupportedHandlers,
      pendingTrust: [...new Set(pendingTrust)],
      warnings: this.warnings,
    };
  }

  describe(): string {
    return formatReport(this.report());
  }

  private async trace(
    event: HookEventName,
    scope: RunScope,
    results: readonly HandlerResult[],
    decision: Decision,
    started: number
  ): Promise<void> {
    const path = this.input.options.trace;
    if (path === undefined) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      const lines = results.map((result) =>
        JSON.stringify({
          at: new Date().toISOString(),
          session: scope.sessionID,
          event,
          source: result.sourceID,
          handler: result.handlerType,
          status: result.status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          message: result.message === undefined ? undefined : firstLine(redact(result.message)),
          blocked: decision.blocked,
          permission: decision.permission,
          totalMs: (this.input.host.now?.() ?? Date.now()) - started,
        })
      );
      if (lines.length > 0) await appendFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch {
      // Tracing must never break a hook or a session.
    }
  }
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [
    `opencode-claude-hooks ${report.version}`,
    `directory: ${report.directory}`,
    `trust: ${report.trust}`,
    `sources: ${report.sources.length}`,
  ];
  for (const source of report.sources) {
    const activator =
      source.activator === undefined ? "" : ` [${source.activator.kind}:${source.activator.id}]`;
    lines.push(
      `- ${source.label}${activator} (${source.scope}, ${source.trusted ? "trusted" : "untrusted"})`,
      `  path: ${source.path}`,
      `  events: ${
        Object.entries(source.events)
          .map(([event, count]) => `${event}=${count}`)
          .join(" ") || "none"
      }`,
      `  handlers: ${
        Object.entries(source.handlers)
          .map(([type, count]) => `${type}=${count}`)
          .join(" ") || "none"
      }`
    );
    for (const warning of source.warnings) lines.push(`  warning: ${warning}`);
  }
  if (report.unsupportedEvents.length > 0) {
    lines.push(`unsupported events: ${report.unsupportedEvents.join(", ")}`);
  }
  if (report.unsupportedHandlers.length > 0) {
    lines.push(`unsupported handlers: ${report.unsupportedHandlers.join(", ")}`);
  }
  if (report.pendingTrust.length > 0) {
    lines.push("untrusted hooks seen at runtime:");
    for (const entry of report.pendingTrust) lines.push(`  ${entry}`);
  }
  if (report.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of report.warnings) lines.push(`  ${warning}`);
  }
  return lines.join("\n");
}

/** Exported for tests. */
export { hookSummary };
