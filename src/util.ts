import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  const text = await readTextFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Write a private file atomically so a crash never leaves a truncated store. */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, path);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function truncate(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  const head = buffer.subarray(0, Math.max(0, maxBytes - 64)).toString("utf8");
  return `${head}\n[opencode-claude-hooks] output truncated at ${maxBytes} bytes`;
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private-key]"],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[api-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[github-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[aws-key]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[slack-token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [token]"],
  [/\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}/gi, "$1=[redacted]"],
];

/** Best-effort redaction for logs. Never used on data sent to the model. */
export function redact(text: string): string {
  let output = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    output = output.replace(pattern, replacement);
  return output;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
