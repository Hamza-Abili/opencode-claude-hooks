import { describe, expect, test } from "bun:test";
import { parseSimpleYaml } from "../src/yaml.ts";

const sample = `name: secure-ops
description: "A skill: with a colon"
enabled: true
count: 3
empty: null
tags:
  - security
  - "hooks"
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: ./check.sh
          timeout: 5
  Stop:
    - hooks:
        - type: command
          command: |-
            echo line one
            echo line two
`;

describe("parseSimpleYaml", () => {
  test("parses nested maps, lists and scalars", () => {
    expect(parseSimpleYaml(sample)).toEqual({
      name: "secure-ops",
      description: "A skill: with a colon",
      enabled: true,
      count: 3,
      empty: null,
      tags: ["security", "hooks"],
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "./check.sh", timeout: 5 }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: "echo line one\necho line two" }],
          },
        ],
      },
    });
  });

  test("empty input is an empty map", () => {
    expect(parseSimpleYaml("")).toEqual({});
    expect(parseSimpleYaml("\n# comment\n")).toEqual({});
  });

  test("quoted and plain scalars", () => {
    expect(parseSimpleYaml("a: 'it''s'\nb: \"say \\\"hi\\\"\"")).toEqual({
      a: "it's",
      b: 'say "hi"',
    });
  });

  test("inline arrays", () => {
    expect(parseSimpleYaml("a: [1, 2]")).toEqual({ a: [1, 2] });
  });

  test("matches Bun.YAML on the representative sample", () => {
    const bun = (globalThis as { Bun?: { YAML?: { parse(value: string): unknown } } }).Bun;
    if (bun?.YAML === undefined) return;
    expect(parseSimpleYaml(sample)).toEqual(bun.YAML.parse(sample));
  });
});
