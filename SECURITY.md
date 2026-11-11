# Security

## The trust boundary

Claude Code hooks are scripts, HTTP calls, or model prompts that run at agent
lifecycle points. A command hook has the same filesystem, process, and network
access as the user running OpenCode. **The plugin does not sandbox hooks.** It
decides whether a hook is trusted, constrains its resources, and translates its
decision; it cannot make untrusted code safe.

Only enable hooks you have reviewed, and prefer user-level hooks over hooks
committed to a repository you do not control.

## Defaults

- `trust: "user"` trusts hooks from `~/.claude/settings.json` and the managed
  settings file. Project, local, plugin, skill and agent hooks are untrusted
  until approved.
- `trust: "prompt"` asks through OpenCode's permission UI before the first run
  of each hook (V2). A permission `evaluate` hook forces every `claude_hook`
  action to `ask`, so a permissive `*` rule cannot silently approve a hook.
  The prompt shows a fingerprint resource; the summary is in the metadata.
  Approvals are stored in
  `~/.config/opencode/claude-hooks-trust.json` with mode `0600`, keyed by a
  SHA-256 fingerprint of the hook's behaviour. The path is not read from
  `XDG_CONFIG_HOME`, so a repository `.env` cannot relocate the store. An
  explicit `trustFile` option overrides it.
- `trust: "none"` runs only hooks listed in `trusted`.
- `trust: "all"` trusts everything and is intended for disposable or fully
  trusted repositories only.

A fingerprint covers the source path, event, matcher, command, arguments,
shell, URL, headers, prompt, model, `if` rule, `onFailure` and `async`.
Editing any of them changes the fingerprint and requires a new approval.
Timeout, `statusMessage` and `once` are presentation/operational fields and do
not trigger re-approval. Skill hooks are keyed by skill id and path, so two
skills with the same name cannot share trust.

## Environment

Command hooks do **not** inherit the ambient environment by default. The
allowlist is:

```text
PATH HOME USER LOGNAME SHELL TERM LANG TZ TMPDIR TEMP TMP
SYSTEMROOT WINDIR COMSPEC PATHEXT PWD  (+ LC_*)
```

The plugin adds `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`,
`CLAUDE_PLUGIN_DATA` and `CLAUDE_HOOK_EVENT`. API keys, cloud credentials and
provider tokens are therefore not passed accidentally. `inheritEnv: true`
removes this protection; `env` adds specific values.

This is defense in depth, not isolation: a hook can still read any file the
user can read.

## Execution limits

- Per-hook timeout (default 600s, hard ceiling 3600s) with process-group kill.
- stdout/stderr and HTTP response bodies are read through a hard
  `maxOutputBytes` cap; oversized HTTP responses are cancelled early.
- HTTP hooks disable redirects and can be limited with `httpAllowlist`.
- HTTP header interpolation only reads variables listed in `allowedEnvVars`.
- Stop-hook continuations are capped (`maxStopContinuations`, default 3).
- Hook output is parsed as JSON; invalid JSON is a non-blocking error, never a
  silent allow.
- Prompt hooks use Claude's native `{ok, reason, impossible}` schema. `ok: false`
  rejects the event; `Stop`/`SubagentStop` allow the stop when `impossible` is
  true. Malformed or unrecognized prompt responses are errors, never silent
  allows.
- A hook that fails is non-blocking unless `onFailure: "block"` is set. A
  blocking policy applies to any command exit other than 0 or 2, even when the
  hook printed JSON.

## Data handling

- Hook payloads contain tool inputs, prompt text, and session identifiers.
  They are sent to the hook process or HTTP endpoint by design.
- `trace` is opt-in. Trace records contain event, source, handler type, status,
  exit code, duration and a redacted one-line message. They do not contain
  payloads or full command text.
- Trust-store records contain the source, label, redacted summary, timestamp
  and fingerprint, not the full command.
- Redaction is best effort. Do not put secrets in hook commands.

## Known limitations

- Command hooks are not sandboxed.
- `mcp_tool` and `agent` handlers are not executed.
- `Setup` and `PermissionRequest` are not emitted.
- V1 has no interactive trust prompt; project hooks stay untrusted unless
  listed in `trusted`.
- V1 `ask` decisions are denied because the legacy API cannot prompt from that
  hook.
- The Node CLI uses a small built-in YAML subset; OpenCode's Bun runtime uses
  `Bun.YAML`.
- Windows is not tested. Use WSL.
- OpenCode V2 must be 2.2.1 or newer for Stop/SubagentStop (`experimental.idle`).

## Reporting

Open a private security advisory on GitHub:
<https://github.com/Hamza-Abili/opencode-claude-hooks/security/advisories/new>

Do not include live credentials in a report. A minimal reproduction with fake
values is enough.
