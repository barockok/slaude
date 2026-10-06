// Overlap note: tests/config/brain-import-token.test.ts already proves the token is
// trimmed/floored, scrubbed from the agent child and reported by the node boot check;
// client.test.ts scans brain-import.ts and client.ts for other secrets. This file adds
// what was missing: the gateway-only list itself, the export CLI in the secret scan,
// .mcp.json placeholder expansion, and token-free responses and log lines.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";
import { parseExternalMcp } from "../../src/gateway/core/external-mcp";
import { createBrainImportApi } from "../../src/gateway/brain-import/api";
import type { MigrateEngine } from "../../src/brain-migrate/engine-types";

const TOKEN = "s3cr3t-" + "t".repeat(40);
const ROOT = join(import.meta.dir, "../..");

describe("SLAUDE_BRAIN_IMPORT_TOKEN stays on the gateway", () => {
  test("is on the shared gateway-only list", () => expect(isGatewayOnlyEnv("SLAUDE_BRAIN_IMPORT_TOKEN")).toBe(true));

  test(".mcp.json placeholders do not expand it", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    try {
      const out = parseExternalMcp(
        { mcpServers: { s: { type: "http", url: "https://x.example.com/${SLAUDE_BRAIN_IMPORT_TOKEN}", headers: { Authorization: "Bearer ${SLAUDE_BRAIN_IMPORT_TOKEN}" }, env: { T: "${SLAUDE_BRAIN_IMPORT_TOKEN}" } } } },
        { SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN },
      );
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      expect(JSON.stringify(out)).toContain("${SLAUDE_BRAIN_IMPORT_TOKEN}");
    } finally { console.warn = orig; }
    expect(warns.join("\n")).not.toContain(TOKEN);
  });

  test("the export CLI holds no gateway secret and neither CLI takes a token flag", () => {
    const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
    for (const f of ["src/cli/brain-export.ts", "src/cli/brain-import.ts", "src/brain-migrate/client.ts"]) {
      for (const bad of ["SLAUDE_JOB_SECRET", "SLAUDE_BRAIN_DATABASE_URL", "SLAUDE_PG_URL"]) expect(read(f)).not.toContain(bad);
    }
    for (const f of ["src/cli/brain-export.ts", "src/cli/brain-import.ts"]) expect(read(f)).not.toMatch(/--token(?!-env)/);
    expect(read("src/cli/brain-import.ts")).not.toMatch(/\btoken:\s*\{\s*type/);
  });

  test("no response body or log line contains the token", async () => {
    const lines: string[] = [];
    const e = {
      getPage: async () => null, transaction: async (fn: any) => fn(e), db: { query: async () => ({ rows: [] }) }, executeRaw: async () => [],
      putPage: async () => {}, upsertChunks: async () => {}, addTag: async () => {}, addTimelineEntry: async () => {}, putRawData: async () => {}, addLink: async () => {},
    } as unknown as MigrateEngine;
    const a = createBrainImportApi({
      env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN }), engine: async () => e,
      brainConfig: () => ({ embeddingModel: null, embeddingDimensions: null }),
      resolveAgentId: async () => "UANA-1x", ensureSource: async () => {},
      brainOn: () => ({ enabled: true, mode: "local" }), log: (l) => lines.push(l),
    });
    const url = "https://gw.example.com/brain-import/v1/personas/ana";
    const hit = (headers: Record<string, string>, body: string) => a.fetch(new Request(url, { method: "POST", headers, body }));
    const responses = [
      await hit({}, "{}"),
      await hit({ authorization: `Bearer ${TOKEN}x` }, "{}"),
      await hit({ authorization: `Bearer ${TOKEN}` }, "not json"),
      await hit({ authorization: `Bearer ${TOKEN}` }, JSON.stringify({ engine: { embeddingModel: null, embeddingDimensions: null }, pages: [] })),
    ];
    for (const r of responses) expect(await r!.text()).not.toContain(TOKEN);
    expect(responses.map((r) => r!.status)).toEqual([401, 401, 422, 200]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
