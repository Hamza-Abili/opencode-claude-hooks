import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outdir = join(import.meta.dir, "..", "dist");
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "src", "cli.ts")],
  outdir,
  naming: "cli.mjs",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const output = join(outdir, "cli.mjs");
const code = await readFile(output, "utf8");
await writeFile(output, code.replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n"), "utf8");
await chmod(output, 0o755);
console.log(`built ${output}`);
