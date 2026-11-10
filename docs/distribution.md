# Distribution notes

Prepared submission payloads. These are intentionally not automated: both
directories are curated and a low-quality or premature submission is worse
than waiting.

## opencode.cafe

Submission page: <https://opencode.cafe/submit> (Clerk login required).

| Field | Value |
| --- | --- |
| Type | `plugin` |
| Product ID | `@hamzaabili/opencode-claude-hooks` |
| Display name | `OpenCode Claude Hooks` |
| Repository | `https://github.com/Hamza-Abili/opencode-claude-hooks` |
| Homepage | `https://www.npmjs.com/package/@hamzaabili/opencode-claude-hooks` |
| Tags | `claude-code, hooks, compatibility, security, v1, v2` |

Description:

> Run the Claude Code hooks you already have inside OpenCode V1 and V2:
> settings, plugin, skill and subagent hooks, with trust fingerprints,
> environment allowlisting, timeouts, bounded output and a compatibility
> doctor. Zero runtime dependencies.

Installation:

```sh
opencode plugin add @hamzaabili/opencode-claude-hooks@0.1.0
```

or, for V1:

```jsonc
{
  "plugin": [["@hamzaabili/opencode-claude-hooks", { "trust": "user" }]]
}
```

## awesome-opencode

Guidelines: <https://github.com/awesome-opencode/awesome-opencode/blob/main/contributing.md>

**Eligibility gate:** the repository must be at least 30 days old and have at
least 25 stars. Earliest eligible date: **2026-12-10**. Do not open the PR
before both conditions are true; the PR is closed automatically otherwise.

File: `data/plugins/opencode-claude-hooks.yaml`

```yaml
name: OpenCode Claude Hooks
repo: https://github.com/Hamza-Abili/opencode-claude-hooks
tagline: Run your Claude Code hooks natively in OpenCode V1 and V2.
description: >-
  Loads Claude Code settings, plugin hooks, skill and subagent frontmatter and
  executes them at the matching OpenCode lifecycle point. Covers SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse, Stop, compaction and session
  events with Claude's JSON/exit-code contract, updatedInput, trust
  fingerprints, an environment allowlist, timeouts, bounded output and a
  compatibility doctor. OpenCode V1 (1.19.5) and V2 (2.2.1+). Zero runtime
  dependencies.
```

## OpenCode official ecosystem docs

The official [ecosystem page](https://opencode.ai/docs/ecosystem/) accepts
plugin-table PRs. Add one row under `## Plugins`:

```markdown
| [opencode-claude-hooks](https://github.com/Hamza-Abili/opencode-claude-hooks) | Run Claude Code hooks natively in OpenCode V1 and V2 |
```

Wait until the npm package and the repository have a few real users; the list
is a reference, not a launch channel.

## Tracking

```sh
npm view @hamzaabili/opencode-claude-hooks version
gh repo view Hamza-Abili/opencode-claude-hooks --json stargazerCount
gh issue list --repo Hamza-Abili/opencode-claude-hooks --state open
```
