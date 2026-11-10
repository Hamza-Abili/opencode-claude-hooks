const EXACT_MATCHER = /^[A-Za-z0-9_\-, |]+$/;
const IF_RULE = /^([A-Za-z][A-Za-z0-9_]*)\s*\((.*)\)$/s;

/** Claude matcher semantics: exact strings (optionally `|`/`,` separated) or a regex. */
export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (EXACT_MATCHER.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .includes(toolName);
  }
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === "") return true;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      const next = pattern[index + 1];
      if (next === "*") {
        source += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        source += ".*";
      }
    } else if (character === "?") {
      source += ".";
    } else {
      source += escapeRegex(character);
    }
  }
  try {
    return new RegExp(`^${source}$`, "s").test(value);
  } catch {
    return false;
  }
}

function stringField(input: unknown, keys: readonly string[]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

const BASH_SEPARATORS = /(?:&&|\|\||;|\n|\||(?<![0-9])&)/;

function stripWrapper(command: string): string {
  let value = command.trim();
  for (let index = 0; index < 3; index += 1) {
    const next = value
      .replace(/^timeout\s+\S+\s+/i, "")
      .replace(/^sudo\s+(?:-\S+\s+)*/i, "")
      .replace(/^command\s+/i, "")
      .replace(/^env\s+(?:\S+=\S*\s+)*/i, "")
      .replace(/^nohup\s+/i, "")
      .replace(/^exec\s+/i, "");
    if (next === value) break;
    value = next;
  }
  return value;
}

export function bashSubcommands(command: string): string[] {
  const withoutAssignments = command.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "");
  const output = withoutAssignments
    .split(BASH_SEPARATORS)
    .map((entry) => stripWrapper(entry.trim()))
    .filter((entry) => entry.length > 0);
  for (const match of withoutAssignments.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = stripWrapper(match[1] ?? match[2] ?? "");
    if (inner.length > 0) output.push(inner);
  }
  return output;
}

function normalizeBashPattern(pattern: string): string {
  return pattern.trim().replace(/:\*$/, "*");
}

function dynamicShell(command: string): boolean {
  return /\$\(|`|\$\{|\$\[|\$[0-9?@*#!$-]|\$[A-Za-z_][A-Za-z0-9_]*/.test(command);
}

function matchBash(pattern: string, command: string): boolean {
  const normalized = normalizeBashPattern(pattern);
  if (dynamicShell(command)) return true;
  const suffix = normalized.endsWith(" *") ? normalized.slice(0, -2) : undefined;
  return bashSubcommands(command).some(
    (subcommand) =>
      globMatch(normalized, subcommand) || (suffix !== undefined && globMatch(suffix, subcommand))
  );
}

/**
 * Evaluate a Claude `if` permission rule such as `Bash(git *)` or
 * `Edit(*.ts)`. A malformed rule never runs the hook.
 */
export function matchesIf(rule: string | undefined, toolName: string, input: unknown): boolean {
  if (rule === undefined || rule.trim() === "") return true;
  const parsed = IF_RULE.exec(rule.trim());
  if (parsed === null) return false;
  const ruleTool = parsed[1] ?? "";
  const pattern = parsed[2] ?? "";
  if (ruleTool !== toolName) return false;
  if (pattern === "" || pattern === "*") return true;

  if (ruleTool === "Bash" || ruleTool === "PowerShell") {
    const command = stringField(input, ["command"]);
    return command !== undefined && matchBash(pattern, command);
  }

  const path = stringField(input, ["file_path", "path", "notebook_path"]);
  if (path !== undefined) return globMatch(pattern, path);

  const url = stringField(input, ["url"]);
  if (url !== undefined) return globMatch(pattern, url);

  try {
    return globMatch(pattern, JSON.stringify(input ?? {}));
  } catch {
    return false;
  }
}

export function isToolEvent(event: string): boolean {
  return event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure";
}
