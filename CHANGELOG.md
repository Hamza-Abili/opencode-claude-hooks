# Changelog

## 0.1.3

Compatibility and hardening release.

- Prompt hooks enforce their timeout (default 30s) even when the provider
  cannot cancel the request.
- `statusMessage` is honoured for command, HTTP and prompt hooks.
- V1 maps a child session going idle to `SubagentStop` instead of `Stop`.
- V2 `PostToolUseFailure` includes the `error` field in the hook payload.
- The V2 permission evaluator never downgrades an existing `deny` to `ask`.
- Trust and doctor summaries omit HTTP query strings so tokens are not shown.
- `doctor --trust none|prompt` is parsed correctly and no longer consumes the
  following flag. The built CLI entry point is detected under Node, Bun and
  symlinked installs; smoke covers the built artifact under both runtimes.
- Clarify that malformed JSON on command exit 0 is plain text, matching Claude
  Code.

## 0.1.2

Security fix.

- Prompt hooks now honour Claude's native `{ok, reason, impossible}` response
  schema. `ok: false` rejects the event instead of becoming a successful no-op,
  and `Stop`/`SubagentStop` honour `impossible: true`. Unrecognized or
  malformed prompt responses are errors, never silent allows. Command-style
  prompt responses remain supported as a compatibility fallback.
- A `PostToolUseFailure` block reason is appended to the V2 tool error while
  preserving the `Tool.Error` instance.

## 0.1.1

Security fix.

- `onFailure: "block"` is no longer bypassed when a command hook prints valid
  JSON and exits with a status other than 0 or 2. The blocking failure policy
  now wins over the hook's JSON decision. Exit 0 and exit 2 keep their existing
  behaviour, and nonzero-exit JSON remains non-blocking when no blocking
  policy is set.

## 0.1.0

First release.

- OpenCode V2 and V1 adapters in one package.
- Discovers hooks from user, project, local, managed, plugin, skill and
  subagent sources.
- Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`,
  `PostCompact`, `SessionEnd`, `Notification`, `StopFailure`.
- Handler types: `command` (shell/exec form), `http`, `prompt` (opt-in).
- Claude decision schema: exit codes, `permissionDecision`, `updatedInput`,
  `additionalContext`, `customInstructions`, `continue`, `stopReason`,
  `systemMessage`, legacy `decision`.
- Matchers and `if` permission rules, including Bash subcommand matching.
- Trust modes (`user`, `all`, `none`, `prompt`), SHA-256 fingerprints and a
  `0600` trust store.
- Environment allowlist, timeouts, process-group kill, output caps, HTTP
  allowlist and redirect blocking.
- `claude_hooks_status` tool, `/claude-hooks` command and `doctor` CLI.
- Opt-in redacted JSONL trace.
- Claude exit-code contract: plain text, JSON on any exit code, exit 2 wins.
- Merged `disableAllHooks`, managed-only mode, plugin force-enable exemption.
- Trust fingerprints include source path, event, matcher, `onFailure`, `async`.
- Serialized trust-store writes and unique temporary files.
- V1 `filePath` translation and agent activation.
- V2 model references use `{ providerID, id }`; prompt failures honour `onFailure`.
- `continue:false` stops instead of continuing; Stop `additionalContext` continues.
- Subagent `Stop` hooks map to `SubagentStop`.
- HTTP bodies are streamed with a hard cap.
- Expanded `if` matching (`:*`, wrappers, `&`, uncertain dynamic commands).
- 160+ unit/contract tests, live V1 and V2 harnesses, GitHub Actions CI.
