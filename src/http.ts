import { globMatch } from "./matcher.ts";
import type { HookSource, HttpHook, Options } from "./types.ts";
import { truncate } from "./util.ts";

export interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

export interface HttpInput {
  readonly handler: HttpHook;
  readonly source: HookSource;
  readonly options: Options;
  readonly cwd: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

function interpolate(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  allowed: readonly string[]
): string {
  return value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced, plain) => {
      const key = (braced ?? plain) as string;
      if (!allowed.includes(key)) return "";
      return env[key] ?? "";
    }
  );
}

function allowedHost(url: URL, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some(
    (entry) => entry === "*" || globMatch(entry, url.hostname) || globMatch(entry, url.host)
  );
}

function substitute(value: string, input: HttpInput): string {
  return value
    .split("${CLAUDE_PROJECT_DIR}")
    .join(input.cwd)
    .split("${CLAUDE_PLUGIN_ROOT}")
    .join(input.source.pluginRoot ?? "")
    .split("${CLAUDE_PLUGIN_DATA}")
    .join(input.source.pluginData ?? "");
}

export async function runHttp(input: HttpInput): Promise<HttpResult> {
  if (!input.options.allowHttpHooks) {
    return { status: 0, body: "", error: "http hooks are disabled (allowHttpHooks=false)" };
  }
  let url: URL;
  try {
    url = new URL(substitute(input.handler.url, input));
  } catch {
    return { status: 0, body: "", error: `invalid hook URL ${input.handler.url}` };
  }
  if (!allowedHost(url, input.options.httpAllowlist)) {
    return { status: 0, body: "", error: `host ${url.hostname} is not in httpAllowlist` };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [key, value] of Object.entries(input.handler.headers ?? {})) {
    headers[key] = interpolate(
      substitute(value, input),
      input.env,
      input.handler.allowedEnvVars ?? []
    );
  }

  const timeoutMs =
    Math.min(
      input.handler.timeout ?? input.options.defaultTimeoutSec,
      input.options.maxTimeoutSec
    ) * 1000;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (input.signal !== undefined) signals.push(input.signal);
  const controller = AbortSignal.any(signals);

  try {
    const request = input.fetchImpl ?? globalThis.fetch;
    if (request === undefined) return { status: 0, body: "", error: "fetch is unavailable" };
    const response = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(input.payload),
      signal: controller,
      redirect: "error",
    });
    const reader = response.body?.getReader();
    if (reader === undefined) return { status: response.status, body: "" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = input.options.maxOutputBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (slice.byteLength < value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    const body = truncate(Buffer.concat(chunks).toString("utf8"), input.options.maxOutputBytes);
    return { status: response.status, body, truncated };
  } catch (error) {
    return {
      status: 0,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
