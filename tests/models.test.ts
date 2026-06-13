import { afterEach, describe, expect, test, mock } from "bun:test";
import { listModels, __resetModelCache } from "../src/agent/models";

const origFetch = globalThis.fetch;
const origKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = origKey;
  __resetModelCache();
});

describe("listModels", () => {
  test("maps provider data to {id, display_name}", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-8", display_name: "Opus 4.8" }] }),
        { status: 200 },
      ),
    ) as any;
    expect(await listModels()).toEqual([{ id: "claude-opus-4-8", display_name: "Opus 4.8" }]);
  });

  test("caches within TTL (single fetch for two calls)", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const f = mock(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    globalThis.fetch = f as any;
    await listModels();
    await listModels();
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("throws on non-200", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    globalThis.fetch = mock(async () => new Response("nope", { status: 404 })) as any;
    expect(listModels()).rejects.toThrow();
  });
});
