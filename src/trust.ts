import { join } from "node:path";
import type { HookHandler, HookSource, Host, Options } from "./types.ts";
import { firstLine, readJsonFile, redact, sha256, writeFileAtomic } from "./util.ts";

interface TrustEntry {
  readonly source: string;
  readonly label: string;
  readonly summary: string;
  readonly addedAt: string;
}

interface TrustStore {
  readonly version: 1;
  readonly fingerprints: Record<string, TrustEntry>;
}

const EMPTY_STORE: TrustStore = { version: 1, fingerprints: {} };

function fingerprintPayload(handler: HookHandler): unknown {
  switch (handler.type) {
    case "command":
      return {
        type: handler.type,
        command: handler.command,
        args: handler.args ?? null,
        shell: handler.shell ?? null,
        if: handler.if ?? null,
        onFailure: handler.onFailure ?? null,
        async: handler.async === true,
      };
    case "http":
      return {
        type: handler.type,
        url: handler.url,
        headers: handler.headers ?? null,
        allowedEnvVars: handler.allowedEnvVars ?? null,
        if: handler.if ?? null,
        onFailure: handler.onFailure ?? null,
      };
    case "prompt":
      return {
        type: handler.type,
        prompt: handler.prompt,
        model: handler.model ?? null,
        if: handler.if ?? null,
        onFailure: handler.onFailure ?? null,
      };
    default:
      return { type: handler.type, reason: handler.reason, if: handler.if ?? null };
  }
}

export function hookFingerprint(
  source: HookSource,
  handler: HookHandler,
  event?: string,
  matcher?: string
): string {
  return sha256(
    JSON.stringify({
      source: source.id,
      scope: source.scope,
      path: source.path,
      pluginRoot: source.pluginRoot ?? null,
      event: event ?? null,
      matcher: matcher ?? null,
      handler: fingerprintPayload(handler),
    })
  );
}

export function hookSummary(handler: HookHandler): string {
  switch (handler.type) {
    case "command": {
      const args = handler.args === undefined ? "" : ` ${handler.args.join(" ")}`;
      return firstLine(redact(`${handler.command}${args}`));
    }
    case "http": {
      try {
        const url = new URL(handler.url);
        return `HTTP POST ${url.origin}${url.pathname}${url.search.length > 0 ? "?…" : ""}`;
      } catch {
        const cut = handler.url.search(/[?#]/);
        const safe = cut === -1 ? handler.url : `${handler.url.slice(0, cut)}?…`;
        return `HTTP POST ${redact(safe)}`;
      }
    }
    case "prompt":
      return `prompt hook: ${firstLine(redact(handler.prompt))}`;
    default:
      return `${handler.type} hook (${handler.reason})`;
  }
}

export function defaultTrustFile(home: string): string {
  return join(home, ".config", "opencode", "claude-hooks-trust.json");
}

export class TrustManager {
  private store: TrustStore | undefined;
  private readonly path: string;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: Options,
    home: string,
    _env: Readonly<Record<string, string | undefined>>,
    private readonly host: Host
  ) {
    this.path = options.trustFile ?? defaultTrustFile(home);
  }

  get file(): string {
    return this.path;
  }

  async prefetch(): Promise<void> {
    await this.load();
  }

  isStored(source: HookSource, handler: HookHandler, event?: string, matcher?: string): boolean {
    if (this.store === undefined) return false;
    return this.store.fingerprints[hookFingerprint(source, handler, event, matcher)] !== undefined;
  }

  state(
    source: HookSource,
    handler: HookHandler,
    event?: string,
    matcher?: string
  ): "trusted" | "untrusted" {
    if (this.options.trust === "all") return "trusted";
    const fingerprint = hookFingerprint(source, handler, event, matcher);
    if (this.options.trusted.some((entry) => entry === fingerprint || entry === source.id)) {
      return "trusted";
    }
    if (this.options.trust === "none") return "untrusted";
    if (source.trustedByDefault) return "trusted";
    return this.isStored(source, handler, event, matcher) ? "trusted" : "untrusted";
  }

  private async load(): Promise<TrustStore> {
    if (this.store !== undefined) return this.store;
    const raw = await readJsonFile<unknown>(this.path);
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as { version?: unknown; fingerprints?: unknown };
      if (
        record.version === 1 &&
        typeof record.fingerprints === "object" &&
        record.fingerprints !== null
      ) {
        this.store = {
          version: 1,
          fingerprints: record.fingerprints as Record<string, TrustEntry>,
        };
        return this.store;
      }
    }
    this.store = EMPTY_STORE;
    return this.store;
  }

  private async save(store: TrustStore): Promise<void> {
    this.store = store;
    await writeFileAtomic(this.path, `${JSON.stringify(store, null, 2)}\n`);
  }

  async isTrusted(
    source: HookSource,
    handler: HookHandler,
    event: string,
    matcher: string | undefined,
    sessionID?: string
  ): Promise<boolean> {
    if (this.state(source, handler, event, matcher) === "trusted") return true;
    if (this.options.trust !== "prompt" || this.host.assertTrust === undefined) return false;

    const fingerprint = hookFingerprint(source, handler, event, matcher);
    const ok = await this.host.assertTrust({
      sessionID,
      fingerprint,
      source: source.id,
      summary: hookSummary(handler),
      message: `Claude Code hook from ${source.label} wants to run:\n${hookSummary(handler)}\n\nTrust only hooks you have reviewed.`,
    });
    if (!ok) return false;
    await this.approve(fingerprint, {
      source: source.id,
      label: source.label,
      summary: hookSummary(handler),
      addedAt: new Date().toISOString(),
    });
    return true;
  }

  private async approve(fingerprint: string, entry: TrustEntry): Promise<void> {
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        await this.load();
        const store = this.store ?? EMPTY_STORE;
        await this.save({
          version: 1,
          fingerprints: { ...store.fingerprints, [fingerprint]: entry },
        });
      });
    try {
      await this.saving;
    } catch (error) {
      this.host.status?.(
        `could not persist trust decision: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
