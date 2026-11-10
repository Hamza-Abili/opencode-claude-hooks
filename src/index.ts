/**
 * opencode-claude-hooks — dual OpenCode entry point.
 *
 * V2 calls `setup(ctx)` and registers session/tool/context hooks. V1 calls
 * `server(input, options)` and uses the legacy hook object. Both share the
 * same discovery, trust and decision runtime.
 */

import { server } from "./v1.ts";
import { setup as setupV2 } from "./v2.ts";

async function setup(input: unknown): Promise<() => Promise<void>> {
  return await setupV2(input);
}

export const plugin = {
  id: "opencode-claude-hooks",
  setup,
  server,
};

export default plugin;

export { VERSION } from "./version.ts";
// Older V1 loaders discover a named `server` export; newer V1 and V2 use the
// default object above.
export { server };
