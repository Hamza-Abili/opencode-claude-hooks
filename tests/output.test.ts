import { describe, expect, test } from "bun:test";
import type { DecisionInput } from "../src/output.ts";
import {
  mergeDecisions,
  parseCommandOutput,
  parseHookJson,
  parseHttpOutput,
  parsePromptOutput,
} from "../src/output.ts";

const exec = (overrides: Partial<Parameters<typeof parseCommandOutput>[0]> = {}) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

describe("parseHookJson", () => {
  test("parses JSON and code fences", () => {
    expect(parseHookJson('{"decision":"block","reason":"x"}')).toEqual({
      continue: undefined,
      stopReason: undefined,
      suppressOutput: undefined,
      systemMessage: undefined,
      decision: "block",
      reason: "x",
      permissionDecision: undefined,
      permissionDecisionReason: undefined,
      updatedInput: undefined,
      additionalContext: undefined,
      customInstructions: undefined,
      retry: undefined,
    });
    expect(parseHookJson('```json\n{"decision":"block"}\n```')?.decision).toBe("block");
  });

  test("reads hookSpecificOutput", () => {
    const output = parseHookJson(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "no rm",
          updatedInput: { command: "ls" },
          additionalContext: "ctx",
          customInstructions: "inst",
        },
      })
    );
    expect(output?.permissionDecision).toBe("deny");
    expect(output?.permissionDecisionReason).toBe("no rm");
    expect(output?.updatedInput).toEqual({ command: "ls" });
    expect(output?.additionalContext).toBe("ctx");
    expect(output?.customInstructions).toBe("inst");
  });

  test("invalid JSON is undefined", () => {
    expect(parseHookJson("not json")).toBeUndefined();
  });

  test("drops unknown values", () => {
    expect(parseHookJson('{"permissionDecision":"maybe","decision":"nope"}')).toMatchObject({
      permissionDecision: undefined,
      decision: undefined,
    });
  });
});

describe("parseCommandOutput", () => {
  test("empty stdout is success", () => {
    expect(parseCommandOutput(exec()).status).toBe("success");
  });

  test("valid JSON is success", () => {
    expect(
      parseCommandOutput(exec({ stdout: '{"decision":"block","reason":"x"}' })).output?.decision
    ).toBe("block");
  });

  test("plain text on exit 0 is a successful hook", () => {
    const parsed = parseCommandOutput(exec({ stdout: "formatted ok" }));
    expect(parsed.status).toBe("success");
    expect(parsed.plainText).toBe("formatted ok");
  });

  test("valid JSON applies even on a non-0/2 exit code", () => {
    const parsed = parseCommandOutput(
      exec({ exitCode: 1, stdout: '{"permissionDecision":"deny","permissionDecisionReason":"no"}' })
    );
    expect(parsed.status).toBe("success");
    expect(parsed.output?.permissionDecision).toBe("deny");
  });

  test("stderr truncation does not discard a valid stdout decision", () => {
    const parsed = parseCommandOutput(
      exec({
        stdout: '{"permissionDecision":"deny","permissionDecisionReason":"no"}',
        stderr: "verbose",
        truncated: true,
        stderrTruncated: true,
      })
    );
    expect(parsed.status).toBe("success");
    expect(parsed.output?.permissionDecision).toBe("deny");
  });

  test("stdout truncation invalidates a decision", () => {
    const parsed = parseCommandOutput(
      exec({ stdout: '{"permissionDecision":"deny"', truncated: true, stdoutTruncated: true })
    );
    expect(parsed.status).toBe("error");
  });

  test("exit 2 wins over JSON", () => {
    const parsed = parseCommandOutput(
      exec({ exitCode: 2, stdout: '{"permissionDecision":"allow"}', stderr: "hard block" })
    );
    expect(parsed.status).toBe("blocked");
    expect(parsed.output?.permissionDecision).toBeUndefined();
    expect(parsed.output?.reason).toBe("hard block");
  });

  test("exit 2 blocks with stderr", () => {
    const parsed = parseCommandOutput(exec({ exitCode: 2, stderr: "blocked" }));
    expect(parsed.status).toBe("blocked");
    expect(parsed.output?.reason).toBe("blocked");
  });

  test("exit 2 without stderr uses stdout", () => {
    expect(parseCommandOutput(exec({ exitCode: 2, stdout: "stdout reason" })).output?.reason).toBe(
      "stdout reason"
    );
  });

  test("other exits are non-blocking errors", () => {
    const parsed = parseCommandOutput(exec({ exitCode: 9, stderr: "boom" }));
    expect(parsed.status).toBe("error");
    expect(parsed.message).toBe("boom");
  });

  test("timeout is reported", () => {
    expect(parseCommandOutput(exec({ timedOut: true })).status).toBe("timeout");
  });
});

describe("parseHttpOutput", () => {
  test("2xx JSON is success", () => {
    expect(parseHttpOutput({ status: 200, body: '{"decision":"block"}' }).status).toBe("success");
  });

  test("empty body is success", () => {
    expect(parseHttpOutput({ status: 204, body: "" }).status).toBe("success");
  });

  test("non-2xx is an error", () => {
    expect(parseHttpOutput({ status: 500, body: "" }).status).toBe("error");
  });

  test("invalid JSON is an error", () => {
    expect(parseHttpOutput({ status: 200, body: "no" }).status).toBe("error");
  });
});

describe("parsePromptOutput", () => {
  test("parses the native ok:false response", () => {
    const parsed = parsePromptOutput('{"ok":false,"reason":"REGRESSION_DENY"}');
    expect(parsed.status).toBe("success");
    expect(parsed.output?.ok).toBe(false);
    expect(parsed.output?.reason).toBe("REGRESSION_DENY");
  });

  test("parses the native ok:true response", () => {
    const parsed = parsePromptOutput('```json\n{"ok":true}\n```');
    expect(parsed.status).toBe("success");
    expect(parsed.output?.ok).toBe(true);
  });

  test("ok:false without a reason still rejects", () => {
    const parsed = parsePromptOutput('{"ok":false}');
    expect(parsed.status).toBe("success");
    expect(parsed.output?.ok).toBe(false);
    expect(parsed.output?.reason).toBe("rejected by prompt hook");
  });

  test("keeps command-style JSON as a compatibility fallback", () => {
    expect(parsePromptOutput('{"decision":"block"}').output?.decision).toBe("block");
  });

  test("rejects an unrecognized object instead of allowing", () => {
    expect(parsePromptOutput('{"foo":"bar"}').status).toBe("error");
    expect(parsePromptOutput('{"ok":"yes"}').status).toBe("error");
    expect(parsePromptOutput('{"ok":0,"decision":"approve"}').status).toBe("error");
    expect(parsePromptOutput('{"continue":"yes"}').status).toBe("error");
    expect(parsePromptOutput("{}").status).toBe("error");
  });

  test("does not let a malformed ok field fall back to an allow", () => {
    const parsed = parsePromptOutput('{"ok":"false","permissionDecision":"allow"}');
    expect(parsed.status).toBe("error");
    const decision = mergeDecisions("PreToolUse", [
      input({ status: parsed.status, message: parsed.message, onFailure: "block" }),
    ]);
    expect(decision.blocked).toBe(true);
    expect(decision.permission).toBeUndefined();
  });

  test("rejects empty output and prose", () => {
    expect(parsePromptOutput("").status).toBe("error");
    expect(parsePromptOutput("I think you should block it").status).toBe("error");
  });
});

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    sourceID: "s",
    sourceLabel: "l",
    event: "PreToolUse",
    status: "success",
    ...overrides,
  };
}

describe("mergeDecisions", () => {
  test("deny beats ask beats allow", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({ output: { permissionDecision: "allow" } }),
      input({ output: { permissionDecision: "ask" } }),
      input({ output: { permissionDecision: "deny", permissionDecisionReason: "no" } }),
    ]);
    expect(decision.permission).toBe("deny");
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("no");
  });

  test("legacy block decision denies PreToolUse", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({ output: { decision: "block", reason: "nope" } }),
    ]);
    expect(decision.permission).toBe("deny");
    expect(decision.blocked).toBe(true);
  });

  test("merges updatedInput", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({ output: { updatedInput: { command: "ls" } } }),
      input({ output: { updatedInput: { timeout: 5 } } }),
    ]);
    expect(decision.updatedInput).toEqual({ command: "ls", timeout: 5 });
  });

  test("concatenates context and system messages", () => {
    const decision = mergeDecisions("SessionStart", [
      input({ event: "SessionStart", output: { additionalContext: "a", systemMessage: "one" } }),
      input({ event: "SessionStart", output: { additionalContext: "b", systemMessage: "two" } }),
    ]);
    expect(decision.additionalContext).toEqual(["a", "b"]);
    expect(decision.systemMessages).toEqual(["one", "two"]);
  });

  test("continue false stops the session", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({ output: { continue: false, stopReason: "halt" } }),
    ]);
    expect(decision.stop).toBe(true);
    expect(decision.stopReason).toBe("halt");
  });

  test("Stop block blocks stopping", () => {
    const decision = mergeDecisions("Stop", [
      input({ event: "Stop", output: { decision: "block", reason: "more" } }),
    ]);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("more");
  });

  test("prompt ok:false denies PreToolUse without onFailure", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({ output: { ok: false, reason: "REGRESSION_DENY" } }),
    ]);
    expect(decision.blocked).toBe(true);
    expect(decision.permission).toBe("deny");
    expect(decision.reason).toBe("REGRESSION_DENY");
  });

  test("prompt ok:true leaves the decision unchanged", () => {
    const decision = mergeDecisions("PreToolUse", [input({ output: { ok: true } })]);
    expect(decision.blocked).toBe(false);
    expect(decision.permission).toBeUndefined();
  });

  test("prompt ok:false blocks Stop unless impossible", () => {
    const stop = mergeDecisions("Stop", [
      input({ event: "Stop", output: { ok: false, reason: "more" } }),
    ]);
    expect(stop.blocked).toBe(true);
    expect(stop.reason).toBe("more");

    const impossible = mergeDecisions("Stop", [
      input({ event: "Stop", output: { ok: false, reason: "never", impossible: true } }),
    ]);
    expect(impossible.blocked).toBe(false);
  });

  test("prompt ok:false blocks UserPromptSubmit, PostToolUse and PostToolUseFailure", () => {
    for (const event of ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"] as const) {
      const decision = mergeDecisions(event, [
        input({ event, output: { ok: false, reason: "review" } }),
      ]);
      expect(decision.blocked).toBe(true);
      expect(decision.reason).toBe("review");
    }
  });

  test("PostToolUse block blocks the result", () => {
    const decision = mergeDecisions("PostToolUse", [
      input({ event: "PostToolUse", output: { decision: "block", reason: "review" } }),
    ]);
    expect(decision.blocked).toBe(true);
  });

  test("errors are non-blocking unless onFailure is block", () => {
    const soft = mergeDecisions("PreToolUse", [input({ status: "error", message: "boom" })]);
    expect(soft.blocked).toBe(false);
    const hard = mergeDecisions("PreToolUse", [
      input({ status: "error", message: "boom", onFailure: "block" }),
    ]);
    expect(hard.blocked).toBe(true);
    expect(hard.reason).toBe("boom");
  });

  test("onFailure block covers a nonzero exit that printed JSON", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({
        exitCode: 9,
        onFailure: "block",
        output: { permissionDecision: "allow" },
      }),
    ]);
    expect(decision.blocked).toBe(true);
    expect(decision.permission).toBeUndefined();
    expect(decision.reason).toBe("PreToolUse hook failed (exit 9)");
  });

  test("nonzero JSON keeps its decision without onFailure block", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({ exitCode: 9, output: { permissionDecision: "allow" } }),
    ]);
    expect(decision.blocked).toBe(false);
    expect(decision.permission).toBe("allow");
  });

  test("onFailure block ignores a successful exit", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({
        exitCode: 0,
        onFailure: "block",
        output: { permissionDecision: "allow" },
      }),
    ]);
    expect(decision.blocked).toBe(false);
    expect(decision.permission).toBe("allow");
  });

  test("exit 2 keeps its own block reason under onFailure block", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({
        status: "blocked",
        exitCode: 2,
        onFailure: "block",
        output: { decision: "block", reason: "hard block" },
      }),
    ]);
    expect(decision.blocked).toBe(true);
    expect(decision.permission).toBe("deny");
    expect(decision.reason).toBe("hard block");
  });

  test("untrusted and skipped results are ignored", () => {
    const decision = mergeDecisions("PreToolUse", [
      input({ status: "untrusted", message: "no" }),
      input({ status: "skipped", message: "no" }),
    ]);
    expect(decision.blocked).toBe(false);
  });
});
