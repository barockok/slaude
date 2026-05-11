import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/home";
import { SoulDataSchema } from "../src/soul/data";
import { __resetSoulDataMemo, loadSoulData, setSoulData, soulData } from "../src/soul/extract";

const CACHE_DIR = join(paths.home, "cache");
const originalFetch = globalThis.fetch;

function resetCache() {
  if (existsSync(CACHE_DIR)) {
    for (const f of readdirSync(CACHE_DIR)) unlinkSync(join(CACHE_DIR, f));
  }
  // Reset the in-memory memo by writing a fresh fallback. setSoulData accepts
  // any valid SoulData; the soulData() accessor will replace it after first
  // cache hit on the next call.
  setSoulData(SoulDataSchema.parse({ approvers: [] }));
}

function seedPersona(body: string) {
  writeFileSync(paths.soul, body, "utf8");
}

function mockFetch(impl: (input: any, init?: any) => Promise<Response>) {
  globalThis.fetch = impl as any;
}

beforeEach(() => {
  if (existsSync(paths.soul)) unlinkSync(paths.soul);
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = "https://api.test.local";
  delete process.env.SLAUDE_SOUL_PARSE_MODEL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCache();
});

function okResponse(jsonText: string): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: jsonText }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("loadSoulData — extraction + cache", () => {
  test("extracts via fetch, validates, caches by sha", async () => {
    seedPersona("# Persona\n## Approvers\n- <@U0XXXXXXXXX>: anything ; manager\n");
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return okResponse(JSON.stringify({
        identity: { name: "test-bot" },
        manager: { userId: "U0XXXXXXXXX" },
        allowedUsers: [],
        approvers: [{ userId: "U0XXXXXXXXX", scope: "anything", catchall: true }],
        values: [],
      }));
    });
    const a = await loadSoulData();
    expect(a.identity.name).toBe("test-bot");
    expect(a.approvers).toHaveLength(1);
    expect(a.approvers[0]!.catchall).toBe(true);
    expect(existsSync(CACHE_DIR)).toBe(true);
    const files = readdirSync(CACHE_DIR);
    expect(files.length).toBe(1);
    expect(files[0]!).toMatch(/^soul\.[a-f0-9]{16}\.json$/);

    // Second call: cache hit, no fetch.
    const b = await loadSoulData();
    expect(b.identity.name).toBe("test-bot");
    expect(calls).toBe(1);
  });

  test("strips ```json fence in model output", async () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: any\n");
    mockFetch(async () => okResponse(
      "```json\n" + JSON.stringify({
        approvers: [{ userId: "U0XXXXXXXXX", scope: "any", catchall: true }],
      }) + "\n```",
    ));
    const d = await loadSoulData();
    expect(d.approvers).toHaveLength(1);
  });

  test("extracts allowedChannels and grounded ids pass through", async () => {
    seedPersona([
      "# P",
      "## Audience",
      "- Allowed users: U0XXXXXXXXX",
      "## Allowed channels",
      "- <#C0123456789|eng>",
      "## Approvers",
      "- <@U0XXXXXXXXX>: anything",
    ].join("\n"));
    mockFetch(async () => okResponse(JSON.stringify({
      allowedUsers: ["U0XXXXXXXXX"],
      allowedChannels: ["C0123456789"],
      approvers: [{ userId: "U0XXXXXXXXX", scope: "anything", catchall: true }],
    })));
    const d = await loadSoulData();
    expect(d.allowedChannels).toEqual(["C0123456789"]);
    expect(d.allowedUsers).toEqual(["U0XXXXXXXXX"]);
  });

  test("rejects ungrounded id (not present in persona) → fallback", async () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: anything\n");
    mockFetch(async () => okResponse(JSON.stringify({
      approvers: [
        { userId: "U0XXXXXXXXX", scope: "anything", catchall: true },
        { userId: "U999HACKER1", scope: "secrets", catchall: false },
      ],
    })));
    const d = await loadSoulData();
    // Grounding check rejected the hallucinated id → regex fallback wins.
    expect(d.approvers.map((a) => a.userId)).toEqual(["U0XXXXXXXXX"]);
  });

  test("rejects ungrounded channel id → fallback", async () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: anything\n");
    mockFetch(async () => okResponse(JSON.stringify({
      approvers: [{ userId: "U0XXXXXXXXX", scope: "anything", catchall: true }],
      allowedChannels: ["C0999999999"], // never appeared in persona
    })));
    const d = await loadSoulData();
    // Regex fallback never fills allowedChannels.
    expect(d.allowedChannels).toEqual([]);
  });

  test("zod rejects malformed userId → regex fallback", async () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: db, schema ; dba\n");
    mockFetch(async () => okResponse(JSON.stringify({
      approvers: [{ userId: "not-a-slack-id", scope: "x", catchall: false }],
    })));
    const d = await loadSoulData();
    // LLM result invalid → fall back to regex parser, which extracted the real entry.
    expect(d.approvers).toHaveLength(1);
    expect(d.approvers[0]!.userId).toBe("U0XXXXXXXXX");
    // Nothing should be cached since extraction failed.
    expect(existsSync(CACHE_DIR) && readdirSync(CACHE_DIR).length).toBeFalsy();
  });

  test("HTTP non-2xx → regex fallback", async () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: anything\n");
    mockFetch(async () => new Response("upstream boom", { status: 500 }));
    const d = await loadSoulData();
    expect(d.approvers).toHaveLength(1);
    expect(d.approvers[0]!.userId).toBe("U0XXXXXXXXX");
  });

  test("missing ANTHROPIC_API_KEY → regex fallback, no fetch", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: anything\n");
    let called = false;
    mockFetch(async () => { called = true; return okResponse("{}"); });
    const d = await loadSoulData();
    expect(called).toBe(false);
    expect(d.approvers).toHaveLength(1);
  });

  test("empty extractor text → fallback", async () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: anything\n");
    mockFetch(async () => new Response(
      JSON.stringify({ content: [{ type: "text", text: "" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const d = await loadSoulData();
    expect(d.approvers).toHaveLength(1);
  });

  test("cache file present but corrupt → re-extracts", async () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: anything\n");
    // First successful extract caches.
    mockFetch(async () => okResponse(JSON.stringify({
      approvers: [{ userId: "U0XXXXXXXXX", scope: "anything", catchall: true }],
    })));
    await loadSoulData();
    const files = readdirSync(CACHE_DIR);
    expect(files.length).toBe(1);
    // Corrupt it.
    writeFileSync(join(CACHE_DIR, files[0]!), "{not-json", "utf8");
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return okResponse(JSON.stringify({
        approvers: [{ userId: "U0XXXXXXXXX", scope: "anything", catchall: true }],
        identity: { name: "after" },
      }));
    });
    const d = await loadSoulData();
    expect(calls).toBe(1);
    expect(d.identity.name).toBe("after");
  });
});

describe("soulData — sync accessor", () => {
  test("returns memoised data set via setSoulData", () => {
    const seeded = SoulDataSchema.parse({
      approvers: [{ userId: "U0XXXXXXXXX", scope: "anything", catchall: true }],
    });
    setSoulData(seeded);
    expect(soulData().approvers).toHaveLength(1);
  });

  test("memo path returns seeded value before disk read", () => {
    setSoulData(SoulDataSchema.parse({ approvers: [], identity: { name: "memo" } }));
    expect(soulData().identity.name).toBe("memo");
  });

  test("after cache write, sync accessor reads cache when memo unset", async () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: anything\n");
    mockFetch(async () => okResponse(JSON.stringify({
      approvers: [{ userId: "U0XXXXXXXXX", scope: "anything", catchall: true }],
      identity: { name: "cached" },
    })));
    await loadSoulData();
    __resetSoulDataMemo();
    expect(soulData().identity.name).toBe("cached");
    expect(soulData().approvers).toHaveLength(1);
  });

  test("no cache + no memo → regex fallback", () => {
    seedPersona("# P\n## Approvers\n- <@U0XXXXXXXXX>: deploys, kubernetes\n");
    __resetSoulDataMemo();
    const d = soulData();
    expect(d.approvers).toHaveLength(1);
    expect(d.approvers[0]!.userId).toBe("U0XXXXXXXXX");
    expect(d.identity.name).toBeUndefined();
  });
});
