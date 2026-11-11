import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "och-smoke-"));
const home = join(directory, "home");
await mkdir(join(directory, ".claude"), { recursive: true });
await writeFile(
  join(directory, ".claude", "settings.json"),
  `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "echo ok", if: "Bash(git *)" },
              { type: "http", url: "https://example.invalid/hook" },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              { type: "command", command: "echo done" },
              { type: "mcp_tool", server: "x", tool: "y" },
            ],
          },
        ],
      },
    },
    null,
    2
  )}\n`,
  "utf8"
);

const child = Bun.spawn(
  [
    "bun",
    join(import.meta.dir, "..", "src", "cli.ts"),
    "doctor",
    "--directory",
    directory,
    "--home",
    home,
    "--json",
  ],
  { stdout: "pipe", stderr: "pipe" }
);
const output = await new Response(child.stdout).text();
const error = await new Response(child.stderr).text();
const code = await child.exited;
if (code !== 0) {
  console.error(error);
  throw new Error(`doctor exited ${code}`);
}
const report = JSON.parse(output) as {
  sources: Array<{ events: Record<string, number> }>;
  unsupportedHandlers: string[];
};
if (report.sources.length !== 1) throw new Error("expected one source");
if (report.unsupportedHandlers.length !== 1) throw new Error("expected one unsupported handler");

const cli = join(import.meta.dir, "..", "dist", "cli.mjs");
const runtimes: Array<{ label: string; path: string }> = [{ label: "bun", path: process.execPath }];
const node = Bun.which("node");
if (node !== null) runtimes.push({ label: "node", path: node });
for (const runtime of runtimes) {
  const check = Bun.spawn([runtime.path, cli, "version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const version = await new Response(check.stdout).text();
  const versionError = await new Response(check.stderr).text();
  const versionCode = await check.exited;
  if (versionCode !== 0) {
    console.error(versionError);
    throw new Error(`${runtime.label} cli exited ${versionCode}`);
  }
  if (!version.includes("opencode-claude-hooks")) {
    throw new Error(`${runtime.label} cli output is missing the version prefix`);
  }
}
console.log(
  `smoke ok (${report.sources.length} source, ${report.unsupportedHandlers.length} unsupported handler; cli ${runtimes.map((runtime) => runtime.label).join("+")})`
);
