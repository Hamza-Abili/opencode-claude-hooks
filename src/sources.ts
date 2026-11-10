import { opendir, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  frontmatterHooks,
  parsePluginHooksFile,
  parseSettingsHooks,
  unreadableHookFile,
} from "./parse.ts";
import type { Discovered, HookSource, Options, Scope, SkillLike } from "./types.ts";
import { isDirectory, isInside, pathExists, readJsonFile, readTextFile } from "./util.ts";

interface SettingsFile {
  readonly path: string;
  readonly scope: Scope;
  readonly trusted: boolean;
  readonly data: Record<string, unknown>;
}

export interface DiscoverInput {
  readonly directory: string;
  readonly home: string;
  readonly options: Options;
  readonly skills?: readonly SkillLike[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const SETTINGS_ORDER: ReadonlyArray<{
  scope: Scope;
  trusted: boolean;
  path: (i: DiscoverInput) => string | undefined;
}> = [
  { scope: "managed", trusted: true, path: managedSettingsPath },
  { scope: "user", trusted: true, path: (i) => join(i.home, ".claude", "settings.json") },
  { scope: "project", trusted: false, path: (i) => join(i.directory, ".claude", "settings.json") },
  {
    scope: "local",
    trusted: false,
    path: (i) => join(i.directory, ".claude", "settings.local.json"),
  },
];

function managedSettingsPath(input: DiscoverInput): string | undefined {
  if (input.options.managedSettings !== undefined) return input.options.managedSettings;
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (process.platform === "win32") {
    return join(input.env?.ProgramData ?? "C:\\ProgramData", "ClaudeCode", "managed-settings.json");
  }
  return "/etc/claude-code/managed-settings.json";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractEnabledPlugins(value: unknown): Record<string, boolean> {
  if (!isObject(value)) return {};
  const output: Record<string, boolean> = {};
  const enabled = value.enabledPlugins;
  if (isObject(enabled)) {
    for (const [key, entry] of Object.entries(enabled)) {
      if (typeof entry === "boolean") output[key] = entry;
    }
  }
  return output;
}

async function readSettings(
  path: string,
  scope: Scope,
  trusted: boolean
): Promise<SettingsFile | undefined> {
  if (!(await pathExists(path))) return undefined;
  const data = await readJsonFile<unknown>(path);
  if (!isObject(data)) return undefined;
  return { path, scope, trusted, data };
}

function pluginRootFor(input: DiscoverInput): string {
  const override = input.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  return override !== undefined && override.length > 0
    ? resolve(override)
    : join(input.home, ".claude", "plugins");
}

function collectInstallRecords(
  value: unknown,
  output: Map<string, string>,
  parentKey?: string
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectInstallRecords(entry, output, parentKey);
    return;
  }
  if (!isObject(value)) return;
  const installPath = value.installPath;
  if (typeof installPath === "string") {
    const explicit =
      (typeof value.name === "string" && value.name) ||
      (typeof value.plugin === "string" && value.plugin) ||
      (typeof value.pluginId === "string" && value.pluginId) ||
      parentKey;
    if (explicit?.includes("@") === true) output.set(explicit, installPath);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isObject(entry) || Array.isArray(entry))
      collectInstallRecords(entry, output, key.includes("@") ? key : undefined);
  }
}

async function installedPluginPaths(root: string): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const installed = await readJsonFile<unknown>(join(root, "installed_plugins.json"));
  if (installed !== undefined) collectInstallRecords(installed, output);
  // Also fill gaps from cache/<marketplace>/<plugin>/<version>/.
  const cache = join(root, "cache");
  if (!(await isDirectory(cache))) return output;
  for (const marketplace of await safeReaddir(cache)) {
    if (!marketplace.isDirectory()) continue;
    for (const plugin of await safeReaddir(join(cache, marketplace.name))) {
      if (!plugin.isDirectory()) continue;
      const versions = (await safeReaddir(join(cache, marketplace.name, plugin.name))).filter(
        (entry) => entry.isDirectory()
      );
      if (versions.length === 0) continue;
      versions.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      const latest = versions[0];
      if (latest === undefined) continue;
      const key = `${plugin.name}@${marketplace.name}`;
      if (!output.has(key))
        output.set(key, join(cache, marketplace.name, plugin.name, latest.name));
    }
  }
  return output;
}

async function safeReaddir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walkMarkdown(root: string, maxDepth = 3): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".md")) output.push(path);
      }
    } catch {
      // Missing or unreadable directories are not an error.
    }
  }
  await walk(root, 0);
  return output.sort();
}

function sourceID(scope: Scope, path: string, activator?: string): string {
  return activator === undefined ? `${scope}:${path}` : `${scope}:${activator}:${path}`;
}

async function pluginHookFiles(pluginPath: string): Promise<string[]> {
  const output: string[] = [];
  const hooksFile = join(pluginPath, "hooks", "hooks.json");
  if (await pathExists(hooksFile)) output.push(hooksFile);
  const manifest = await readJsonFile<unknown>(join(pluginPath, ".claude-plugin", "plugin.json"));
  if (isObject(manifest)) {
    const hooks = manifest.hooks;
    const values = Array.isArray(hooks) ? hooks : hooks === undefined ? [] : [hooks];
    for (const value of values) {
      if (typeof value !== "string") continue;
      const resolved = resolve(pluginPath, value);
      if (!isInside(pluginPath, resolved)) continue;
      output.push(resolved);
    }
  }
  return output;
}

async function loadPluginSource(
  input: { path: string; key: string; trusted: boolean; root: string },
  warnings: string[]
): Promise<HookSource | undefined> {
  if (!(await isDirectory(input.path))) {
    warnings.push(`plugin ${input.key}: install path not found (${input.path})`);
    return undefined;
  }
  const files = await pluginHookFiles(input.path);
  const manifest = await readJsonFile<unknown>(join(input.path, ".claude-plugin", "plugin.json"));
  const inline = isObject(manifest) ? manifest.hooks : undefined;
  const inlineValues = inline === undefined ? [] : Array.isArray(inline) ? inline : [inline];

  const entries = [];
  const sourceWarnings: string[] = [];
  const unsupportedEvents: string[] = [];
  const unsupportedHandlers: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readTextFile(file);
    if (text === undefined) {
      const parsed = unreadableHookFile(basename(file), "unreadable");
      sourceWarnings.push(...parsed.warnings);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      const parsed = unreadableHookFile(basename(file), "invalid JSON");
      sourceWarnings.push(...parsed.warnings);
      continue;
    }
    const parsed = parsePluginHooksFile(data, basename(file));
    entries.push(...parsed.entries);
    sourceWarnings.push(...parsed.warnings);
    unsupportedEvents.push(...parsed.unsupportedEvents);
    unsupportedHandlers.push(...parsed.unsupportedHandlers);
  }

  for (const value of inlineValues) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const parsed = parsePluginHooksFile({ hooks: value }, `${input.key} inline hooks`);
    entries.push(...parsed.entries);
    sourceWarnings.push(...parsed.warnings);
    unsupportedEvents.push(...parsed.unsupportedEvents);
    unsupportedHandlers.push(...parsed.unsupportedHandlers);
  }

  if (entries.length === 0 && sourceWarnings.length === 0) return undefined;
  warnings.push(...unsupportedEvents.map((event) => `${input.key}: unsupported event ${event}`));
  warnings.push(
    ...unsupportedHandlers.map((handler) => `${input.key}: unsupported handler ${handler}`)
  );
  return {
    id: sourceID("plugin", input.path, input.key),
    label: input.key,
    path: input.path,
    scope: "plugin",
    trustedByDefault: input.trusted,
    pluginRoot: input.path,
    pluginData: join(input.root, "data", input.key),
    entries,
    warnings: sourceWarnings,
  };
}

async function skillsDirectoryPlugins(
  input: DiscoverInput,
  enabled: Readonly<Record<string, boolean>>,
  warnings: string[]
): Promise<HookSource[]> {
  const root = pluginRootFor(input);
  const roots = [join(input.home, ".claude", "skills"), join(input.directory, ".claude", "skills")];
  const output: HookSource[] = [];
  for (const skillsRoot of roots) {
    for (const entry of await safeReaddir(skillsRoot)) {
      if (!entry.isDirectory()) continue;
      const directory = join(skillsRoot, entry.name);
      const manifest = await readJsonFile<unknown>(
        join(directory, ".claude-plugin", "plugin.json")
      );
      if (!isObject(manifest)) continue;
      const name = typeof manifest.name === "string" ? manifest.name : entry.name;
      const key = `${name}@skills-dir`;
      const declared = enabled[key];
      const on = declared === true || (declared === undefined && manifest.defaultEnabled === true);
      if (!on) continue;
      const source = await loadPluginSource(
        { path: directory, key, trusted: false, root },
        warnings
      );
      if (source !== undefined) output.push(source);
    }
  }
  return output;
}

async function agentSources(
  directory: string,
  home: string,
  warnings: string[]
): Promise<HookSource[]> {
  const output: HookSource[] = [];
  for (const [scope, root] of [
    ["user", join(home, ".claude", "agents")],
    ["project", join(directory, ".claude", "agents")],
  ] as const) {
    for (const path of await walkMarkdown(root)) {
      const text = await readTextFile(path);
      if (text === undefined) continue;
      const parsed = frontmatterHooks(text, basename(path));
      if (parsed.entries.length === 0) continue;
      const name = parsed.name ?? basename(path, ".md");
      warnings.push(...parsed.warnings);
      const entries = parsed.entries.map((entry) =>
        entry.event === "Stop" ? { ...entry, event: "SubagentStop" as const } : entry
      );
      output.push({
        id: sourceID(scope, path, name),
        label: `${name} (agent)`,
        path,
        scope: "agent",
        trustedByDefault: false,
        activator: { kind: "agent", id: name },
        entries,
        warnings: parsed.warnings,
      });
    }
  }
  return output;
}

async function skillSources(
  skills: readonly SkillLike[],
  warnings: string[]
): Promise<HookSource[]> {
  const output: HookSource[] = [];
  for (const skill of skills) {
    if (skill.content === undefined) continue;
    const parsed = frontmatterHooks(skill.content, skill.id);
    if (parsed.entries.length === 0) continue;
    warnings.push(...parsed.warnings);
    output.push({
      id: `skill:${skill.id}:${skill.path ?? ""}`,
      label: `${skill.name ?? skill.id} (skill)`,
      path: skill.path ?? skill.id,
      scope: "skill",
      trustedByDefault: false,
      activator: { kind: "skill", id: skill.id },
      entries: parsed.entries,
      warnings: parsed.warnings,
    });
  }
  return output;
}

/**
 * Discover every hook source Claude Code would load in this project:
 * managed, user, project and local settings, enabled plugins, Claude skill
 * frontmatter and Claude agent frontmatter.
 */
export async function discover(input: DiscoverInput): Promise<Discovered> {
  const warnings: string[] = [];
  const unsupportedEvents: string[] = [];
  const unsupportedHandlers: string[] = [];
  const sources: HookSource[] = [];
  const settings: SettingsFile[] = [];

  for (const entry of SETTINGS_ORDER) {
    const path = entry.path(input);
    if (path === undefined) continue;
    if (entry.scope === "managed" && isInside(input.directory, path)) {
      warnings.push(`managed settings path is inside the project and was ignored: ${path}`);
      continue;
    }
    const file = await readSettings(path, entry.scope, entry.trusted);
    if (file !== undefined) settings.push(file);
    else if (await pathExists(path)) warnings.push(`${path}: unreadable or invalid settings JSON`);
  }

  const enabledPlugins: Record<string, boolean> = {};
  const precedence: Record<Scope, number> = {
    user: 0,
    project: 1,
    local: 2,
    managed: 3,
    plugin: 4,
    skill: 5,
    agent: 6,
  };
  for (const file of [...settings].sort((a, b) => precedence[a.scope] - precedence[b.scope])) {
    Object.assign(enabledPlugins, extractEnabledPlugins(file.data));
  }

  const managedFile = settings.find((file) => file.scope === "managed");
  const managedEnabled = new Set(
    Object.entries(extractEnabledPlugins(managedFile?.data))
      .filter(([, on]) => on)
      .map(([key]) => key)
  );
  const allowManagedHooksOnly = managedFile?.data.allowManagedHooksOnly === true;
  if (allowManagedHooksOnly) {
    warnings.push("managed settings set allowManagedHooksOnly; only managed hooks are loaded");
  }

  // `disableAllHooks` is a merged setting: later scopes win. A lower scope
  // cannot disable managed hooks; the managed scope can disable everything.
  const disableByScope = new Map<Scope, boolean>();
  for (const file of settings) {
    const value = file.data.disableAllHooks;
    if (typeof value === "boolean") disableByScope.set(file.scope, value);
  }
  let effectiveDisable = false;
  for (const scope of ["user", "project", "local", "managed"] as const) {
    const value = disableByScope.get(scope);
    if (value !== undefined) effectiveDisable = value;
  }
  const managedDisable = disableByScope.get("managed") === true;
  if (effectiveDisable) {
    warnings.push("disableAllHooks is effective; non-managed hooks are ignored");
  }
  if (managedDisable) {
    warnings.push("managed settings disable all hooks");
  }
  const restrictManaged = allowManagedHooksOnly || effectiveDisable;

  for (const file of settings) {
    if (restrictManaged && file.scope !== "managed") continue;
    if (managedDisable && file.scope === "managed") continue;
    const parsed = parseSettingsHooks(file.data, file.path);
    unsupportedEvents.push(...parsed.unsupportedEvents);
    unsupportedHandlers.push(...parsed.unsupportedHandlers);
    warnings.push(...parsed.warnings);
    if (parsed.entries.length === 0) continue;
    sources.push({
      id: sourceID(file.scope, file.path),
      label: `${file.scope}: ${basename(dirname(file.path))}/${basename(file.path)}`,
      path: file.path,
      scope: file.scope,
      trustedByDefault: file.trusted,
      entries: parsed.entries,
      warnings: parsed.warnings,
    });
  }

  const pluginRoot = pluginRootFor(input);
  const installs = await installedPluginPaths(pluginRoot);
  const seenPlugins = new Set<string>();
  for (const [key, on] of Object.entries(enabledPlugins)) {
    if (!on || seenPlugins.has(key) || key.endsWith("@skills-dir")) continue;
    if (restrictManaged && !managedEnabled.has(key)) continue;
    seenPlugins.add(key);
    const installPath = installs.get(key);
    if (installPath === undefined) {
      warnings.push(
        `plugin ${key} is enabled but not installed; run "claude plugin install ${key}"`
      );
      continue;
    }
    const source = await loadPluginSource(
      { path: installPath, key, trusted: false, root: pluginRoot },
      warnings
    );
    if (source !== undefined) sources.push(source);
  }
  for (const path of input.options.plugins) {
    if (restrictManaged) continue;
    const source = await loadPluginSource(
      { path, key: basename(path), trusted: false, root: pluginRoot },
      warnings
    );
    if (source !== undefined) sources.push(source);
  }
  sources.push(...(await skillsDirectoryPlugins(input, enabledPlugins, warnings)));

  // Explicit extra sources: a settings file or a directory of settings.
  for (const path of restrictManaged ? [] : input.options.sources) {
    if (await isDirectory(path)) {
      for (const candidate of ["settings.json", join(".claude", "settings.json"), "hooks.json"]) {
        const file = join(path, candidate);
        if (!(await pathExists(file))) continue;
        const data = await readJsonFile<unknown>(file);
        if (isObject(data) && data.disableAllHooks === true) {
          warnings.push(`${file}: disableAllHooks is set; extra source ignored`);
          continue;
        }
        const parsed =
          candidate === "hooks.json"
            ? parsePluginHooksFile(data, file)
            : parseSettingsHooks(data, file);
        if (parsed.entries.length === 0) continue;
        sources.push({
          id: sourceID("local", file),
          label: `extra: ${basename(path)}/${basename(file)}`,
          path: file,
          scope: "local",
          trustedByDefault: false,
          entries: parsed.entries,
          warnings: parsed.warnings,
        });
      }
      continue;
    }
    const data = await readJsonFile<unknown>(path);
    if (isObject(data) && data.disableAllHooks === true) {
      warnings.push(`${path}: disableAllHooks is set; extra source ignored`);
      continue;
    }
    const parsed = parseSettingsHooks(data, path);
    if (parsed.entries.length === 0) continue;
    sources.push({
      id: sourceID("local", path),
      label: `extra: ${basename(path)}`,
      path,
      scope: "local",
      trustedByDefault: false,
      entries: parsed.entries,
      warnings: parsed.warnings,
    });
  }

  if (!restrictManaged) {
    sources.push(...(await agentSources(input.directory, input.home, warnings)));
    sources.push(...(await skillSources(input.skills ?? [], warnings)));
  }

  const finalSources = managedDisable
    ? []
    : restrictManaged
      ? sources.filter(
          (source) =>
            source.scope === "managed" ||
            (source.scope === "plugin" && managedEnabled.has(source.label))
        )
      : sources;
  return {
    sources: finalSources,
    warnings: [...new Set(warnings)],
    unsupportedEvents: [...new Set(unsupportedEvents)],
    unsupportedHandlers: [...new Set(unsupportedHandlers)],
    enabledPlugins,
  };
}

/** Exported for tests and the doctor. */
export { installedPluginPaths, pluginRootFor };
