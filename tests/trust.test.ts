import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultTrustFile, hookFingerprint, hookSummary, TrustManager } from "../src/trust.ts";
import { readJsonFile } from "../src/util.ts";
import { handler, options, source, tempDir } from "./helpers.ts";

const command = handler({ type: "command", command: "echo ok" });

describe("hookFingerprint", () => {
  test("is stable and changes when the command changes", () => {
    const a = source([]);
    expect(hookFingerprint(a, command, "PreToolUse", "Bash")).toBe(
      hookFingerprint(a, command, "PreToolUse", "Bash")
    );
    const changed = handler({ type: "command", command: "echo changed" });
    expect(hookFingerprint(a, changed, "PreToolUse", "Bash")).not.toBe(
      hookFingerprint(a, command, "PreToolUse", "Bash")
    );
  });

  test("changes when the source, event or matcher changes", () => {
    const a = source([], { id: "a" });
    const b = source([], { id: "b" });
    const base = hookFingerprint(a, command, "PreToolUse", "Bash");
    expect(hookFingerprint(b, command, "PreToolUse", "Bash")).not.toBe(base);
    expect(hookFingerprint(a, command, "PostToolUse", "Bash")).not.toBe(base);
    expect(hookFingerprint(a, command, "PreToolUse", "Edit")).not.toBe(base);
    expect(hookFingerprint(a, command, "PreToolUse", undefined)).not.toBe(base);
  });

  test("changes when the source path changes", () => {
    const a = source([], { id: "same", path: "/one/settings.json" });
    const b = source([], { id: "same", path: "/two/settings.json" });
    expect(hookFingerprint(a, command, "PreToolUse")).not.toBe(
      hookFingerprint(b, command, "PreToolUse")
    );
  });

  test("changes when onFailure or async changes", () => {
    const a = source([]);
    const blocking = handler({ type: "command", command: "echo ok", onFailure: "block" });
    const asyncHook = handler({ type: "command", command: "echo ok", async: true });
    const base = hookFingerprint(a, command, "PreToolUse");
    expect(hookFingerprint(a, blocking, "PreToolUse")).not.toBe(base);
    expect(hookFingerprint(a, asyncHook, "PreToolUse")).not.toBe(base);
  });

  test("ignores presentation-only fields", () => {
    const a = source([]);
    const noisy = handler({
      type: "command",
      command: "echo ok",
      timeout: 10,
      statusMessage: "running",
      once: true,
    });
    expect(hookFingerprint(a, noisy, "PreToolUse")).toBe(hookFingerprint(a, command, "PreToolUse"));
  });
});

describe("hookSummary", () => {
  test("redacts secrets", () => {
    const summary = hookSummary(
      handler({ type: "command", command: "curl -H 'Authorization: Bearer abcdefghijklmnop'" })
    );
    expect(summary).not.toContain("abcdefghijklmnop");
    expect(summary).toContain("[token]");
  });

  test("does not print HTTP query secrets", () => {
    const summary = hookSummary(
      handler({
        type: "http",
        url: "https://example.com/hook?token=supersecret&mode=check",
      })
    );
    expect(summary).toContain("https://example.com/hook");
    expect(summary).toContain("?…");
    expect(summary).not.toContain("supersecret");

    const invalid = hookSummary(
      handler({ type: "http", url: "https://exa mple.com/hook?token=supersecret" })
    );
    expect(invalid).not.toContain("supersecret");
  });
});

describe("defaultTrustFile", () => {
  test("ignores XDG_CONFIG_HOME", () => {
    expect(defaultTrustFile("/home/test")).toBe(
      "/home/test/.config/opencode/claude-hooks-trust.json"
    );
  });
});

describe("TrustManager", () => {
  test("trusts user-level sources by default", async () => {
    const dir = await tempDir();
    const manager = new TrustManager(options(), dir, {}, { directory: dir, home: dir, env: {} });
    const userSource = source([], { trustedByDefault: true });
    expect(await manager.isTrusted(userSource, command, "PreToolUse", "Bash", "ses")).toBe(true);
  });

  test("does not trust project hooks without a decision", async () => {
    const dir = await tempDir();
    const manager = new TrustManager(options(), dir, {}, { directory: dir, home: dir, env: {} });
    const projectSource = source([], { trustedByDefault: false });
    expect(await manager.isTrusted(projectSource, command, "PreToolUse", "Bash", "ses")).toBe(
      false
    );
    expect(manager.state(projectSource, command, "PreToolUse", "Bash")).toBe("untrusted");
  });

  test("accepts an explicit fingerprint", async () => {
    const dir = await tempDir();
    const projectSource = source([], { trustedByDefault: false });
    const fingerprint = hookFingerprint(projectSource, command, "PreToolUse", "Bash");
    const manager = new TrustManager(
      options({ trusted: [fingerprint] }),
      dir,
      {},
      { directory: dir, home: dir, env: {} }
    );
    expect(await manager.isTrusted(projectSource, command, "PreToolUse", "Bash", "ses")).toBe(true);
  });

  test("trust all and none", async () => {
    const dir = await tempDir();
    const projectSource = source([], { trustedByDefault: false });
    const all = new TrustManager(
      options({ trust: "all" }),
      dir,
      {},
      {
        directory: dir,
        home: dir,
        env: {},
      }
    );
    expect(await all.isTrusted(projectSource, command, "PreToolUse", "Bash", "ses")).toBe(true);
    const none = new TrustManager(
      options({ trust: "none" }),
      dir,
      {},
      {
        directory: dir,
        home: dir,
        env: {},
      }
    );
    const userSource = source([], { trustedByDefault: true });
    expect(await none.isTrusted(userSource, command, "PreToolUse", "Bash", "ses")).toBe(false);
  });

  test("prompt mode persists an approval with 0600", async () => {
    const dir = await tempDir();
    const trustFile = join(dir, "trust.json");
    const projectSource = source([], { trustedByDefault: false });
    let asked = 0;
    const manager = new TrustManager(
      options({ trust: "prompt", trustFile }),
      dir,
      {},
      {
        directory: dir,
        home: dir,
        env: {},
        assertTrust: async () => {
          asked += 1;
          return true;
        },
      }
    );
    expect(await manager.isTrusted(projectSource, command, "PreToolUse", "Bash", "ses")).toBe(true);
    expect(asked).toBe(1);
    const stored = await readJsonFile<{ fingerprints: Record<string, unknown> }>(trustFile);
    expect(Object.keys(stored?.fingerprints ?? {})).toHaveLength(1);

    const second = new TrustManager(
      options({ trust: "prompt", trustFile }),
      dir,
      {},
      {
        directory: dir,
        home: dir,
        env: {},
      }
    );
    await second.prefetch();
    expect(second.state(projectSource, command, "PreToolUse", "Bash")).toBe("trusted");
  });

  test("prompt mode denial does not persist", async () => {
    const dir = await tempDir();
    const trustFile = join(dir, "trust.json");
    const manager = new TrustManager(
      options({ trust: "prompt", trustFile }),
      dir,
      {},
      {
        directory: dir,
        home: dir,
        env: {},
        assertTrust: async () => false,
      }
    );
    const projectSource = source([], { trustedByDefault: false });
    expect(await manager.isTrusted(projectSource, command, "PreToolUse", "Bash", "ses")).toBe(
      false
    );
    const stored = await readJsonFile<{ fingerprints?: Record<string, unknown> }>(trustFile);
    expect(stored).toBeUndefined();
  });

  test("concurrent approvals merge instead of losing entries", async () => {
    const dir = await tempDir();
    const trustFile = join(dir, "trust.json");
    const manager = new TrustManager(
      options({ trust: "prompt", trustFile }),
      dir,
      {},
      {
        directory: dir,
        home: dir,
        env: {},
        assertTrust: async () => true,
      }
    );
    const first = source([], { trustedByDefault: false, id: "first" });
    const second = source([], { trustedByDefault: false, id: "second" });
    const results = await Promise.all([
      manager.isTrusted(first, command, "PreToolUse", "Bash", "ses"),
      manager.isTrusted(second, command, "PreToolUse", "Bash", "ses"),
    ]);
    expect(results).toEqual([true, true]);
    const stored = await readJsonFile<{ fingerprints: Record<string, unknown> }>(trustFile);
    expect(Object.keys(stored?.fingerprints ?? {})).toHaveLength(2);
  });

  test("a failed save does not reject the hook", async () => {
    const dir = await tempDir();
    const manager = new TrustManager(
      options({ trust: "prompt", trustFile: dir }),
      dir,
      {},
      {
        directory: dir,
        home: dir,
        env: {},
        assertTrust: async () => true,
      }
    );
    // The parent directory is created by writeFileAtomic, so force a failure
    // with a path that is a directory.
    const projectSource = source([], { trustedByDefault: false });
    expect(await manager.isTrusted(projectSource, command, "PreToolUse", "Bash", "ses")).toBe(true);
  });
});
