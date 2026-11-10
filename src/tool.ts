import type { HookRuntime } from "./runtime.ts";

export const STATUS_TOOL_NAME = "claude_hooks_status";

export const STATUS_TOOL_DESCRIPTION =
  "Report which Claude Code hook sources OpenCode loaded, their scope and trust state, and any unsupported events or handlers.";

export const STATUS_TOOL_INPUT = {
  type: "object",
  properties: {
    format: {
      type: "string",
      enum: ["text", "json"],
      description: "text for a readable report, json for machine-readable output",
    },
  },
  additionalProperties: false,
} as const;

export async function statusTool(
  runtime: HookRuntime,
  input: unknown
): Promise<{ content: string }> {
  const format =
    typeof input === "object" && input !== null && (input as { format?: unknown }).format === "json"
      ? "json"
      : "text";
  return {
    content: format === "json" ? JSON.stringify(runtime.report(), null, 2) : runtime.describe(),
  };
}

export const DOCTOR_COMMAND = {
  name: "claude-hooks",
  description: "Show Claude Code hook compatibility and trust status",
  template:
    "Call the claude_hooks_status tool and summarize: loaded sources, trust state, unsupported events or handlers, and the next action if a hook is untrusted.",
} as const;
