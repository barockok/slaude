import { afterEach, describe, expect, test, mock } from "bun:test";
import { listModels, listModelsFor, verifyModelChoice, __resetModelCache } from "../src/agent/models";

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

// WS-A §5.5: a persona on its own provider is never validated against the gateway's.
describe("verifyModelChoice / listModelsFor", () => {
  const list = async () => [{ id: "m-gw", display_name: "m-gw" }];
  const provider = { apiKey: "env://PERSONA_ANA_KEY" };
  test("no persona provider: verified against the gateway's list", async () => {
    expect(await verifyModelChoice("m-gw", null, list)).toBe(true);
    expect(await verifyModelChoice("m-other", null, list)).toBe(false);
    expect(await listModelsFor(null, list)).toEqual([{ id: "m-gw", display_name: "m-gw" }]);
  });
  test("a list failure passes the choice through unverified", async () => {
    expect(await verifyModelChoice("m-gw", null, async () => { throw new Error("no /v1/models"); })).toBe(false);
  });
  test("a persona with provider references: never asks the gateway's provider", async () => {
    let asked = false;
    const spy = async () => { asked = true; return list(); };
    expect(await verifyModelChoice("m-gw", provider, spy)).toBe(false);
    await expect(listModelsFor(provider, spy)).rejects.toThrow(/own provider/);
    expect(asked).toBe(false);
  });
});
