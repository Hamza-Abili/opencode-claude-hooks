#!/usr/bin/env bun
/**
 * Doctor CLI. Works without OpenCode so V1 users and CI can inspect exactly
 * which Claude hook sources would load.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions } from "./options.ts";
import { HookRuntime } from "./runtime.ts";
import { discover } from "./sources.ts";
import type { Host, TrustMode } from "./types.ts";
import { VERSION } from "./version.ts";

interface Args {
  command: "doctor" | "version";
  json: boolean;
  directory: string;
  home: string;
  trust: TrustMode;
  trusted: string[];
  sources: string[];
  plugins: string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const output: Args = {
    command: "doctor",
    json: false,
    directory: process.cwd(),
    home: homedir(),
    trust: "user",
    trusted: [],
    sources: [],
    plugins: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const next = (): string => {
      index += 1;
      return argv[index] ?? "";
    };
    switch (arg) {
      case "doctor":
        output.command = "doctor";
        break;
      case "version":
      case "--version":
      case "-v":
        output.command = "version";
        break;
      case "--json":
        output.json = true;
        break;
      case "--directory":
      case "-C":
        output.directory = resolve(next());
        break;
      case "--home":
        output.home = resolve(next());
        break;
      case "--trust": {
        const mode = next();
        output.trust = mode === "all" || mode === "none" || mode === "prompt" ? mode : "user";
        break;
      }
      case "--trusted":
        output.trusted.push(next());
        break;
      case "--source":
        output.sources.push(resolve(next()));
        break;
      case "--plugin":
        output.plugins.push(resolve(next()));
        break;
      case "--help":
      case "-h":
        output.command = "version";
        break;
      default:
        break;
    }
  }
  return output;
}

function usage(): string {
  return [
    "opencode-claude-hooks doctor [options]",
    "",
    "  --directory, -C <path>  project directory (default: cwd)",
    "  --home <path>           home directory (default: $HOME)",
    "  --trust <mode>          user | all | none | prompt (default: user)",
    "  --trusted <value>       trusted fingerprint or source id (repeatable)",
    "  --source <path>         extra settings file or directory (repeatable)",
    "  --plugin <path>         extra Claude plugin directory (repeatable)",
    "  --json                  machine-readable report",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "version") {
    console.log(`opencode-claude-hooks ${VERSION}`);
    if (process.argv.includes("--help") || process.argv.includes("-h")) console.log(usage());
    return;
  }
  const options = parseOptions(
    {
      trust: args.trust,
      trusted: args.trusted,
      sources: args.sources,
      plugins: args.plugins,
    },
    args.directory,
    args.home
  );
  const discovery = await discover({
    directory: args.directory,
    home: args.home,
    options,
    env: process.env,
  });
  const host: Host = {
    directory: args.directory,
    home: args.home,
    env: process.env,
    status: (message) => console.error(`[opencode-claude-hooks] ${message}`),
  };
  const runtime = new HookRuntime({
    sources: discovery.sources,
    options,
    host,
    warnings: discovery.warnings,
    unsupportedEvents: discovery.unsupportedEvents,
    unsupportedHandlers: discovery.unsupportedHandlers,
  });
  await runtime.prefetchTrust();
  console.log(args.json ? JSON.stringify(runtime.report(), null, 2) : runtime.describe());
}

function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
