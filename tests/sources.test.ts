import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseOptions } from "../src/options.ts";
import { discover } from "../src/sources.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

function opts(directory: string, extra: Record<string, unknown> = {}) {
  return parseOptions(extra, directory, join(directory, "home"));
}

async function project(): Promise<{ directory: string; home: string }> {
  const directory = await tempDir("och-src-");
  const home = join(directory, "home");
  return { directory, home };
}

const commandHook = { type: "command", command: "true" };

describe("discover settings", () => {
  test("loads user, project and local settings with the right trust", async () => {
    const { directory, home } = await project();
    await writeJson(join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(directory, ".claude", "settings.json"), {
      hooks: { PreToolUse: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(directory, ".claude", "settings.local.json"), {
      hooks: { PostToolUse: [{ hooks: [commandHook] }] },
    });

    const result = await discover({ directory, home, options: opts(directory) });
    const scopes = result.sources.map((source) => source.scope).sort();
    expect(scopes).toEqual(["local", "project", "user"]);
    expect(result.sources.find((source) => source.scope === "user")?.trustedByDefault).toBe(true);
    expect(result.sources.find((source) => source.scope === "project")?.trustedByDefault).toBe(
      false
    );
    expect(result.sources.find((source) => source.scope === "local")?.trustedByDefault).toBe(false);
  });

  test("enabledPlugins precedence: project disables a user-enabled plugin", async () => {
    const { directory, home } = await project();
    const plugin = join(directory, "plugin");
    await writeJson(join(plugin, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: { "demo@market": [{ installPath: plugin }] },
    });
    await writeJson(join(home, ".claude", "settings.json"), {
      enabledPlugins: { "demo@market": true },
    });
    await writeJson(join(directory, ".claude", "settings.json"), {
      enabledPlugins: { "demo@market": false },
    });
    const result = await discover({ directory, home, options: opts(directory) });
    expect(result.sources.filter((source) => source.scope === "plugin")).toHaveLength(0);
  });

  test("managed settings win over local plugin toggles", async () => {
    const { directory, home } = await project();
    const plugin = join(directory, "plugin");
    const managed = join(await tempDir("och-managed-"), "managed.json");
    await writeJson(join(plugin, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: { "demo@market": [{ installPath: plugin }] },
    });
    await writeJson(join(directory, ".claude", "settings.local.json"), {
      enabledPlugins: { "demo@market": false },
    });
    await writeJson(managed, { enabledPlugins: { "demo@market": true } });
    const result = await discover({
      directory,
      home,
      options: opts(directory, { managedSettings: managed }),
    });
    expect(result.sources.filter((source) => source.scope === "plugin")).toHaveLength(1);
  });

  test("allowManagedHooksOnly drops project and plugin hooks", async () => {
    const { directory, home } = await project();
    const plugin = join(directory, "plugin");
    const managed = join(await tempDir("och-managed-"), "managed.json");
    await writeJson(join(plugin, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: { "demo@market": [{ installPath: plugin }] },
    });
    await writeJson(join(directory, ".claude", "settings.json"), {
      enabledPlugins: { "demo@market": true },
      hooks: { PreToolUse: [{ hooks: [commandHook] }] },
    });
    await writeJson(managed, {
      allowManagedHooksOnly: true,
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    const result = await discover({
      directory,
      home,
      options: opts(directory, { managedSettings: managed }),
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.scope).toBe("managed");
  });

  test("disableAllHooks is merged across scopes", async () => {
    const { directory, home } = await project();
    await writeJson(join(home, ".claude", "settings.json"), {
      disableAllHooks: true,
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(directory, ".claude", "settings.json"), {
      hooks: { PreToolUse: [{ hooks: [commandHook] }] },
    });
    const disabled = await discover({ directory, home, options: opts(directory) });
    expect(disabled.sources).toHaveLength(0);

    await writeJson(join(directory, ".claude", "settings.json"), {
      disableAllHooks: false,
      hooks: { PreToolUse: [{ hooks: [commandHook] }] },
    });
    const enabled = await discover({ directory, home, options: opts(directory) });
    expect(enabled.sources.some((source) => source.scope === "project")).toBe(true);
    expect(enabled.sources.some((source) => source.scope === "user")).toBe(true);
  });

  test("a repository environment variable cannot select managed settings", async () => {
    const { directory, home } = await project();
    const fakeManaged = join(directory, "repo-managed.json");
    await writeJson(fakeManaged, { hooks: { Stop: [{ hooks: [commandHook] }] } });
    const result = await discover({
      directory,
      home,
      options: opts(directory),
      env: { CLAUDE_CODE_MANAGED_SETTINGS_PATH: fakeManaged },
    });
    expect(result.sources.some((source) => source.scope === "managed")).toBe(false);
  });

  test("managedSettings inside the project is ignored", async () => {
    const { directory, home } = await project();
    const fakeManaged = join(directory, "managed.json");
    await writeJson(fakeManaged, { hooks: { Stop: [{ hooks: [commandHook] }] } });
    const result = await discover({
      directory,
      home,
      options: opts(directory, { managedSettings: fakeManaged }),
    });
    expect(result.sources.some((source) => source.scope === "managed")).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("inside the project"))).toBe(true);
  });

  test("managed disableAllHooks disables managed hooks too", async () => {
    const { directory, home } = await project();
    const managed = join(await tempDir("och-managed-"), "managed.json");
    await writeJson(managed, { disableAllHooks: true });
    await writeJson(join(directory, ".claude", "settings.json"), {
      hooks: { PreToolUse: [{ hooks: [commandHook] }] },
    });
    const result = await discover({
      directory,
      home,
      options: opts(directory, { managedSettings: managed }),
    });
    expect(result.sources).toHaveLength(0);
  });

  test("disableAllHooks skips the file and explains why", async () => {
    const { directory, home } = await project();
    await writeJson(join(directory, ".claude", "settings.json"), {
      disableAllHooks: true,
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    const result = await discover({ directory, home, options: opts(directory) });
    expect(result.sources).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.includes("disableAllHooks"))).toBe(true);
  });
});

describe("discover plugins", () => {
  test("loads an enabled installed plugin and not a disabled one", async () => {
    const { directory, home } = await project();
    const plugin = join(directory, "plugin");
    await writeJson(join(plugin, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "demo@market": [{ scope: "user", installPath: plugin, version: "1.0.0" }],
      },
    });
    await writeJson(join(directory, ".claude", "settings.json"), {
      enabledPlugins: { "demo@market": true, "off@market": false },
    });

    const result = await discover({ directory, home, options: opts(directory) });
    const pluginSources = result.sources.filter((source) => source.scope === "plugin");
    expect(pluginSources).toHaveLength(1);
    expect(pluginSources[0]?.pluginRoot).toBe(plugin);
    expect(pluginSources[0]?.trustedByDefault).toBe(false);
  });

  test("warns when an enabled plugin is not installed", async () => {
    const { directory, home } = await project();
    await writeJson(join(directory, ".claude", "settings.json"), {
      enabledPlugins: { "missing@market": true },
    });
    const result = await discover({ directory, home, options: opts(directory) });
    expect(result.warnings.some((warning) => warning.includes("not installed"))).toBe(true);
  });

  test("finds a plugin in the cache layout", async () => {
    const { directory, home } = await project();
    const version = join(home, ".claude", "plugins", "cache", "market", "demo", "1.2.3");
    await writeJson(join(version, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(directory, ".claude", "settings.json"), {
      enabledPlugins: { "demo@market": true },
    });
    const result = await discover({ directory, home, options: opts(directory) });
    const plugin = result.sources.find((source) => source.scope === "plugin");
    expect(plugin?.pluginRoot).toBe(version);
  });

  test("merges hooks/hooks.json, manifest paths and inline hooks", async () => {
    const { directory, home } = await project();
    const plugin = join(directory, "plugin");
    await writeJson(join(plugin, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(plugin, "config", "extra.json"), {
      hooks: { PreToolUse: [{ hooks: [commandHook] }] },
    });
    await writeJson(join(plugin, ".claude-plugin", "plugin.json"), {
      name: "demo",
      hooks: ["./config/extra.json", { PostToolUse: [{ hooks: [commandHook] }] }],
    });
    await writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: { "demo@market": [{ installPath: plugin }] },
    });
    await writeJson(join(directory, ".claude", "settings.json"), {
      enabledPlugins: { "demo@market": true },
    });

    const result = await discover({ directory, home, options: opts(directory) });
    const events = result.sources.flatMap((source) => source.entries.map((entry) => entry.event));
    expect(events).toContain("Stop");
    expect(events).toContain("PreToolUse");
    expect(events).toContain("PostToolUse");
  });

  test("rejects hook paths that escape the plugin root", async () => {
    const { directory, home } = await project();
    const plugin = join(directory, "plugin");
    await writeJson(join(plugin, ".claude-plugin", "plugin.json"), {
      name: "demo",
      hooks: ["../outside.json"],
    });
    await writeJson(join(directory, "outside.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    const result = await discover({
      directory,
      home,
      options: opts(directory, { plugins: [plugin] }),
    });
    expect(result.sources.filter((source) => source.scope === "plugin")).toHaveLength(0);
  });

  test("loads a skills-directory plugin when defaultEnabled", async () => {
    const { directory, home } = await project();
    const plugin = join(home, ".claude", "skills", "demo");
    await writeJson(join(plugin, ".claude-plugin", "plugin.json"), {
      name: "demo",
      defaultEnabled: true,
    });
    await writeJson(join(plugin, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    const result = await discover({ directory, home, options: opts(directory) });
    expect(
      result.sources.some(
        (source) => source.scope === "plugin" && source.label.includes("skills-dir")
      )
    ).toBe(true);
  });
});

describe("discover frontmatter sources", () => {
  test("loads Claude agent hooks with an activator", async () => {
    const { directory, home } = await project();
    await writeText(
      join(home, ".claude", "agents", "reviewer.md"),
      "---\nname: reviewer\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: ./review.sh\n---\n# Reviewer\n"
    );
    const result = await discover({ directory, home, options: opts(directory) });
    const agent = result.sources.find((source) => source.scope === "agent");
    expect(agent?.activator).toEqual({ kind: "agent", id: "reviewer" });
    expect(agent?.entries[0]?.event).toBe("SubagentStop");
  });

  test("loads skill hooks from the OpenCode skill registry", async () => {
    const { directory, home } = await project();
    const result = await discover({
      directory,
      home,
      options: opts(directory),
      skills: [
        {
          id: "secure-ops",
          name: "Secure ops",
          path: "/skills/secure/SKILL.md",
          content:
            "---\nname: secure-ops\ndescription: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n---\n",
        },
      ],
    });
    const skill = result.sources.find((source) => source.scope === "skill");
    expect(skill?.activator).toEqual({ kind: "skill", id: "secure-ops" });
    expect(skill?.entries[0]?.event).toBe("PreToolUse");
  });

  test("same-id skills with different paths have different source ids", async () => {
    const { directory, home } = await project();
    const content =
      "---\nname: demo\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: ./check.sh\n---\n";
    const result = await discover({
      directory,
      home,
      options: opts(directory),
      skills: [
        { id: "demo", path: "/one/SKILL.md", content },
        { id: "demo", path: "/two/SKILL.md", content },
      ],
    });
    const ids = result.sources
      .filter((source) => source.scope === "skill")
      .map((source) => source.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test("loads a managed-enabled skills-directory plugin under managed-only mode", async () => {
    const { directory, home } = await project();
    const managed = join(await tempDir("och-managed-"), "managed.json");
    const plugin = join(home, ".claude", "skills", "demo");
    await writeJson(join(plugin, ".claude-plugin", "plugin.json"), { name: "demo" });
    await writeJson(join(plugin, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    await writeJson(managed, {
      allowManagedHooksOnly: true,
      enabledPlugins: { "demo@skills-dir": true },
    });
    const result = await discover({
      directory,
      home,
      options: opts(directory, { managedSettings: managed }),
    });
    expect(result.sources.some((source) => source.label === "demo@skills-dir")).toBe(true);
  });

  test("extra sources honour their own disableAllHooks", async () => {
    const { directory, home } = await project();
    const extraFile = join(directory, "extra.json");
    await writeJson(extraFile, {
      disableAllHooks: true,
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    const extraDir = join(directory, "extra-dir");
    await writeJson(join(extraDir, "settings.json"), {
      disableAllHooks: true,
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    const result = await discover({
      directory,
      home,
      options: opts(directory, { sources: [extraFile, extraDir] }),
    });
    expect(result.sources.filter((source) => source.label.startsWith("extra:"))).toHaveLength(0);
    expect(
      result.warnings.filter((warning) => warning.includes("extra source ignored"))
    ).toHaveLength(2);
  });

  test("loads explicit extra sources", async () => {
    const { directory, home } = await project();
    const extra = join(directory, "extra");
    await writeJson(join(extra, "settings.json"), {
      hooks: { Stop: [{ hooks: [commandHook] }] },
    });
    const result = await discover({
      directory,
      home,
      options: opts(directory, { sources: [extra] }),
    });
    expect(result.sources.some((source) => source.label.startsWith("extra:"))).toBe(true);
  });
});
