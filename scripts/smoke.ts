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
console.log(
  `smoke ok (${report.sources.length} source, ${report.unsupportedHandlers.length} unsupported handler)`
);
