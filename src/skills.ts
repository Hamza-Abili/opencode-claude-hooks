import { opendir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./parse.ts";
import type { SkillLike } from "./types.ts";
import { readTextFile } from "./util.ts";

async function findSkillFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 4) return;
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile() && entry.name === "SKILL.md") output.push(path);
      }
    } catch {
      // Missing directories are not an error.
    }
  }
  await walk(root, 0);
  return output.sort();
}

/**
 * V1 has no skill registry API. Discover OpenCode skill files directly so
 * frontmatter hooks can still be activated by the `skill` tool.
 */
export async function loadOpenCodeSkills(directory: string, home: string): Promise<SkillLike[]> {
  const roots = [
    join(directory, ".opencode", "skills"),
    join(home, ".config", "opencode", "skills"),
  ];
  const output: SkillLike[] = [];
  for (const root of roots) {
    for (const path of await findSkillFiles(root)) {
      const content = await readTextFile(path);
      if (content === undefined) continue;
      const front = parseFrontmatter(content);
      const name =
        typeof front?.data.name === "string" && front.data.name.length > 0
          ? front.data.name
          : basename(join(path, ".."));
      output.push({ id: name, name, path, content });
    }
  }
  return output;
}
