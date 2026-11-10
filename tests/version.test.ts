import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";

describe("version", () => {
  test("VERSION matches package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8")
    ) as {
      version: string;
    };
    expect(VERSION).toBe(packageJson.version);
  });
});
