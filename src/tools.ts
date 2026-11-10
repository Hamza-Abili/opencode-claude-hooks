const DIRECT: Readonly<Record<string, string>> = {
  shell: "Bash",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  patch: "Edit",
  task: "Task",
  subagent: "Task",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  question: "AskUserQuestion",
  skill: "Skill",
};

export type Dialect = "v1" | "v2";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function claudeToolName(opencodeTool: string, mcpServers: readonly string[] = []): string {
  const direct = DIRECT[opencodeTool];
  if (direct !== undefined) return direct;
  const server = [...mcpServers]
    .sort((a, b) => b.length - a.length)
    .find((entry) => opencodeTool.startsWith(`${entry}_`));
  if (server !== undefined) return `mcp__${server}__${opencodeTool.slice(server.length + 1)}`;
  return opencodeTool;
}

function filePath(value: Record<string, unknown>, dialect: Dialect): unknown {
  return dialect === "v1" ? (value.filePath ?? value.path) : (value.path ?? value.filePath);
}

/** Translate an OpenCode tool input into the shape a Claude hook expects. */
export function claudeToolInput(
  opencodeTool: string,
  input: unknown,
  dialect: Dialect = "v2"
): Record<string, unknown> {
  const value = object(input);
  switch (opencodeTool) {
    case "shell":
    case "bash": {
      const output: Record<string, unknown> = {};
      if (typeof value.command === "string") output.command = value.command;
      if (typeof value.timeout === "number") output.timeout = value.timeout;
      if (value.background === true) output.run_in_background = true;
      return Object.keys(output).length > 0 ? output : value;
    }
    case "edit":
      return {
        file_path: filePath(value, dialect),
        old_string: value.oldString,
        new_string: value.newString,
        replace_all: value.replaceAll,
      };
    case "write":
      return { file_path: filePath(value, dialect), content: value.content };
    case "read":
      return {
        file_path: filePath(value, dialect),
        offset: value.offset,
        limit: value.limit,
      };
    case "grep":
      return {
        pattern: value.pattern,
        path: value.path,
        glob: value.include,
      };
    case "glob":
      return { pattern: value.pattern, path: value.path };
    case "webfetch":
      return { url: value.url, format: value.format };
    case "task":
    case "subagent":
      return {
        description: value.description,
        prompt: value.prompt,
        subagent_type: value.subagent_type ?? value.agent,
      };
    default:
      return value;
  }
}

/**
 * Translate a Claude `updatedInput` back into OpenCode arguments. Unknown
 * tools are ignored rather than merged blindly: injecting a foreign key into a
 * schema-validated tool call fails the whole call.
 */
export function opencodeToolInput(
  opencodeTool: string,
  claudeName: string,
  updated: unknown,
  original: unknown,
  dialect: Dialect = "v2"
): Record<string, unknown> | undefined {
  const value = object(updated);
  if (Object.keys(value).length === 0) return undefined;
  if (claudeName.startsWith("mcp__")) return { ...object(original), ...value };
  const base = object(original);
  const pathKey = dialect === "v1" ? "filePath" : "path";
  switch (opencodeTool) {
    case "shell":
    case "bash": {
      const output = { ...base };
      if (typeof value.command === "string") output.command = value.command;
      if (typeof value.timeout === "number") output.timeout = value.timeout;
      if (typeof value.run_in_background === "boolean") output.background = value.run_in_background;
      return output;
    }
    case "edit":
      return {
        ...base,
        [pathKey]: value.file_path ?? base[pathKey],
        oldString: value.old_string ?? base.oldString,
        newString: value.new_string ?? base.newString,
        replaceAll: value.replace_all ?? base.replaceAll,
      };
    case "write":
      return {
        ...base,
        [pathKey]: value.file_path ?? base[pathKey],
        content: value.content ?? base.content,
      };
    case "read":
      return {
        ...base,
        [pathKey]: value.file_path ?? base[pathKey],
        offset: value.offset ?? base.offset,
        limit: value.limit ?? base.limit,
      };
    case "grep":
      return {
        ...base,
        pattern: value.pattern ?? base.pattern,
        path: value.path ?? base.path,
        include: value.glob ?? base.include,
      };
    case "glob":
      return {
        ...base,
        pattern: value.pattern ?? base.pattern,
        path: value.path ?? base.path,
      };
    case "webfetch":
      return { ...base, url: value.url ?? base.url };
    default:
      return undefined;
  }
}

export function toolResponsePreview(value: unknown, max = 20_000): string {
  if (typeof value === "string") return value.slice(0, max);
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}
