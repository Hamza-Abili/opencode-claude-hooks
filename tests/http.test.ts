import { afterEach, describe, expect, test } from "bun:test";
import { runHttp } from "../src/http.ts";
import { handler, options, source } from "./helpers.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(handlerFn: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handlerFn });
  servers.push(server);
  return server;
}

async function run(
  hook: Parameters<typeof handler>[0],
  _server: ReturnType<typeof Bun.serve>,
  overrides: Record<string, unknown> = {},
  env: Record<string, string | undefined> = {}
) {
  return await runHttp({
    handler: handler(hook) as never,
    source: source([]),
    options: options(overrides),
    cwd: "/tmp",
    event: "PreToolUse",
    payload: { hello: "world" },
    env,
  });
}

describe("runHttp", () => {
  test("posts JSON and returns the body", async () => {
    let received: unknown;
    const server = serve(async (request) => {
      received = await request.json();
      return Response.json({ decision: "block", reason: "no" });
    });
    const result = await run({ type: "http", url: `http://127.0.0.1:${server.port}/hook` }, server);
    expect(result.status).toBe(200);
    expect(received).toEqual({ hello: "world" });
    expect(JSON.parse(result.body)).toEqual({ decision: "block", reason: "no" });
  });

  test("reports non-2xx responses", async () => {
    const server = serve(() => new Response("nope", { status: 500 }));
    const result = await run({ type: "http", url: `http://127.0.0.1:${server.port}/` }, server);
    expect(result.status).toBe(500);
  });

  test("enforces the host allowlist", async () => {
    const server = serve(() => Response.json({}));
    const result = await run({ type: "http", url: `http://127.0.0.1:${server.port}/` }, server, {
      httpAllowlist: ["example.com"],
    });
    expect(result.status).toBe(0);
    expect(result.error).toContain("httpAllowlist");
  });

  test("can be disabled entirely", async () => {
    const server = serve(() => Response.json({}));
    const result = await run({ type: "http", url: `http://127.0.0.1:${server.port}/` }, server, {
      allowHttpHooks: false,
    });
    expect(result.status).toBe(0);
    expect(result.error).toContain("disabled");
  });

  test("interpolates only allowed env vars into headers", async () => {
    let headers: Headers | undefined;
    const server = serve((request) => {
      headers = request.headers;
      return Response.json({});
    });
    await run(
      {
        type: "http",
        url: `http://127.0.0.1:${server.port}/`,
        headers: { authorization: "Bearer $TOKEN", "x-secret": "$SECRET" },
        allowedEnvVars: ["TOKEN"],
      },
      server,
      {},
      { TOKEN: "abc", SECRET: "hidden" }
    );
    expect(headers?.get("authorization")).toBe("Bearer abc");
    expect(headers?.get("x-secret")).toBe("");
  });

  test("caps large response bodies while reading", async () => {
    const server = serve(() => new Response("x".repeat(2_000_000), { status: 200 }));
    const result = await run({ type: "http", url: `http://127.0.0.1:${server.port}/` }, server, {
      maxOutputBytes: 1024,
    });
    expect(result.status).toBe(200);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(1024);
  });

  test("times out", async () => {
    const server = serve(async () => {
      await Bun.sleep(1500);
      return Response.json({});
    });
    const started = Date.now();
    const result = await run(
      { type: "http", url: `http://127.0.0.1:${server.port}/`, timeout: 0.1 },
      server
    );
    expect(result.status).toBe(0);
    expect(result.error).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(1200);
  });
});
