/**
 * `bun run node-token mint|inspect|revoke` (node labels and routing spec §4.1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { main } from "../../src/cli/node-token";
import { verifyNodeCredentialSync } from "../../src/gateway/auth/node-credential";
import { openDb, type DbClient } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

const KEY = "cli-node-key";
const NOW = 1_800_000_000_000;

function run(argv: string[], env: NodeJS.ProcessEnv = { SLAUDE_NODE_KEY: KEY }, extra: object = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, now: NOW, ...extra }).then((code) => ({ code, out, err }));
}

describe("mint", () => {
  test("prints the token once on stdout, a warning on stderr; repeatable --label, --id, --ttl", async () => {
    const r = await run(["mint", "--label", "engineering", "--label", "eu", "--id", "engineering-a", "--ttl", "30d"]);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const v = verifyNodeCredentialSync(r.out[0], { keys: [KEY], now: NOW });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims).toMatchObject({ id: "engineering-a", labels: ["engineering", "eu"] });
      expect(v.claims.exp - v.claims.iat).toBe(30 * 86400);
    }
    expect(r.err.join("\n")).toContain("only time it is shown");
    expect(r.err.join("\n")).not.toContain(r.out[0]!);
    expect(r.err.join("\n")).not.toContain(KEY);
  });

  test("default lifetime 90 days and a generated id", async () => {
    const r = await run(["mint", "--label", "finance"]);
    const v = verifyNodeCredentialSync(r.out[0], { keys: [KEY], now: NOW });
    expect(v.ok && v.claims.exp - v.claims.iat).toBe(90 * 86400);
    expect(v.ok && v.claims.id).toMatch(/^finance-[0-9a-f]{6}$/);
  });

  test("refusals: no key, no label, bad label, bad ttl, reserved id, unknown flag", async () => {
    expect((await run(["mint", "--label", "a"], {})).code).toBe(1);
    expect((await run(["mint"])).code).toBe(1);
    expect((await run(["mint", "--label", "Bad"])).code).toBe(1);
    expect((await run(["mint", "--label", "a", "--ttl", "soon"])).code).toBe(1);
    expect((await run(["mint", "--label", "a", "--id", "legacy"])).code).toBe(1);
    expect((await run(["mint", "--label", "a", "--key", "x"])).code).toBe(1);
  });
});

describe("inspect", () => {
  test("verifies and prints claims only, never the key or the token", async () => {
    const token = (await run(["mint", "--label", "finance", "--id", "finance-a"])).out[0]!;
    const r = await run(["inspect", token]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("id=finance-a");
    expect(r.out).toContain("labels=finance");
    const all = [...r.out, ...r.err].join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(token);
  });

  test("reads '-' from stdin; refuses a token under another key", async () => {
    const token = (await run(["mint", "--label", "finance"])).out[0]!;
    expect((await run(["inspect", "-"], { SLAUDE_NODE_KEY: KEY }, { readStdin: async () => `${token}\n` })).code).toBe(0);
    const r = await run(["inspect", token], { SLAUDE_NODE_KEY: "other" });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("bad_signature");
    // The previous key verifies during rotation.
    expect((await run(["inspect", token], { SLAUDE_NODE_KEY: "other", SLAUDE_NODE_KEY_PREVIOUS: KEY })).code).toBe(0);
  });
});

describe("revoke", () => {
  let dbc: DbClient;
  beforeAll(async () => {
    dbc = await openDb({ dialect: "pg", driver: "pglite" });
    await runMigrations(dbc, { log: () => {} });
  });
  afterAll(async () => {
    await dbc.close();
  });

  test("writes the revocation row", async () => {
    const r = await run(["revoke", "finance-a"], {}, { dbc });
    expect(r.code).toBe(0);
    const row = await dbc.one<{ id: string }>("SELECT id FROM node_revocations WHERE id = ?", ["finance-a"]);
    expect(row?.id).toBe("finance-a");
    expect((await run(["revoke", "finance-a"], {}, { dbc })).code).toBe(0); // idempotent
  });

  test("refuses a malformed id and a missing argument", async () => {
    expect((await run(["revoke", "Bad Id"], {}, { dbc })).code).toBe(1);
    expect((await run(["revoke"], {}, { dbc })).code).toBe(1);
  });
});
