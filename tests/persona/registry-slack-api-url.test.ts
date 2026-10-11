import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { buildPersonaRegistry, loadPersonaRegistry } from "../../src/persona/registry";

let root: string;
let prevPersonas: string;
let prevUrl: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-personas-"));
  const dir = join(root, "ada");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SOUL.md"), "# Ada\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ slackUserId: "U0ADA", userToken: "user-token-seam" }));
  prevPersonas = paths.personas;
  (paths as { personas: string }).personas = root;
  prevUrl = process.env.SLAUDE_SLACK_API_URL;
});

afterEach(() => {
  (paths as { personas: string }).personas = prevPersonas;
  if (prevUrl === undefined) delete process.env.SLAUDE_SLACK_API_URL;
  else process.env.SLAUDE_SLACK_API_URL = prevUrl;
  rmSync(root, { recursive: true, force: true });
});

test("the persona's user-token client follows SLAUDE_SLACK_API_URL", () => {
  process.env.SLAUDE_SLACK_API_URL = "http://fake-slack:8080/api";
  const p = loadPersonaRegistry().lookupByName("ada")!;
  expect((p.outClient as any).slackApiUrl).toBe("http://fake-slack:8080/api/");
});

test("with it unset the persona client keeps the SDK default", () => {
  delete process.env.SLAUDE_SLACK_API_URL;
  const p = loadPersonaRegistry().lookupByName("ada")!;
  expect((p.outClient as any).slackApiUrl).toBe("https://slack.com/api/");
});

// A synced tenant builds its personas from the database: their user-token
// client must follow the same seam as a filesystem persona's.
describe.skipIf(process.env.SLAUDE_DB !== "pg")("a database-backed persona", () => {
  const tables = ["persona_overrides", "persona_sync_state", "personas"];
  const savedKey = process.env.SLAUDE_MASTER_KEY;

  beforeEach(async () => {
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    __resetMasterKeyCache();
    for (const t of tables) await db.run(`DELETE FROM ${t}`);
    await P.applySync("default", [{ name: "bea", slackUserId: "U0BEA", userToken: "user-token-seam", model: null,
      soulMd: "bea soul", soulJson: null, mcp: null, origin: "git" as const, tombstonedAt: null }],
      { revision: "r1", committedAt: Date.parse("2026-10-01T10:00:00Z"), by: "ci" });
  });

  afterEach(async () => {
    for (const t of tables) await db.run(`DELETE FROM ${t}`);
    if (savedKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
    else process.env.SLAUDE_MASTER_KEY = savedKey;
    __resetMasterKeyCache();
  });

  test("its user-token client follows SLAUDE_SLACK_API_URL", async () => {
    process.env.SLAUDE_SLACK_API_URL = "http://fake-slack:8080/api";
    const r = await buildPersonaRegistry("default");
    expect(r.isManaged()).toBe(true);
    expect((r.lookupByName("bea")!.outClient as any).slackApiUrl).toBe("http://fake-slack:8080/api/");
  });

  test("with it unset its client keeps the SDK default", async () => {
    delete process.env.SLAUDE_SLACK_API_URL;
    const r = await buildPersonaRegistry("default");
    expect(r.isManaged()).toBe(true);
    expect((r.lookupByName("bea")!.outClient as any).slackApiUrl).toBe("https://slack.com/api/");
  });
});
