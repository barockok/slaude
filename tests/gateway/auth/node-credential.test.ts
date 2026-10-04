/**
 * Signed node credentials (node labels and routing spec §4.1, §6 "Credential").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encodeJwt } from "../../../src/gateway/auth/jwt";
import {
  __resetNodeCredentialState,
  MAX_GAUGED_CREDENTIALS,
  mintNodeCredential,
  NodeCredentialVerifier,
  revocationSourceFor,
  revokeNodeCredential,
  verifyNodeCredentialSync,
} from "../../../src/gateway/auth/node-credential";
import { mintJobToken, verifyJobToken } from "../../../src/gateway/api/auth";
import { metrics } from "../../../src/metrics";
import { openDb, type DbClient } from "../../../src/db/client";
import { runMigrations } from "../../../src/db/migrate";

const KEY = "node-key-for-tests";
const OLD = "previous-node-key";
const NOW = 1_800_000_000_000;

const mint = (over: Partial<{ id: string; labels: string[]; ttlSec: number }> = {}, key = KEY, now = NOW) =>
  mintNodeCredential({ id: "engineering-a", labels: ["engineering", "eu"], ...over }, { key, now });

/** Sign arbitrary claims with the key, bypassing mint's validation. */
const raw = (claims: object, key = KEY) => encodeJwt(claims, key);
const good = { v: 1, typ: "node", id: "engineering-a", labels: ["engineering"], iat: NOW / 1000, exp: NOW / 1000 + 3600 };

beforeEach(() => __resetNodeCredentialState());

describe("mint / verify", () => {
  test("round trip", () => {
    const r = verifyNodeCredentialSync(mint(), { keys: [KEY], now: NOW + 1000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.id).toBe("engineering-a");
      expect(r.claims.labels).toEqual(["engineering", "eu"]);
      expect(r.claims.v).toBe(1);
      expect(r.claims.exp - r.claims.iat).toBe(90 * 86400);
    }
  });

  test("wrong key", () => {
    expect(verifyNodeCredentialSync(mint(), { keys: ["other"], now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("expired", () => {
    const t = mint({ ttlSec: 60 });
    expect(verifyNodeCredentialSync(t, { keys: [KEY], now: NOW + 61_000 })).toEqual({ ok: false, reason: "expired" });
  });

  test("exp is mandatory", () => {
    const { exp: _e, ...noExp } = good;
    expect(verifyNodeCredentialSync(raw(noExp), { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "expired" });
  });

  test("labels empty, too many, malformed, duplicate: refused at mint and at verify", () => {
    const bad = [
      [],
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      ["Engineering"],
      ["-lead"],
      ["a".repeat(33)],
      ["has space"],
      ["engineering", "engineering"],
    ];
    for (const labels of bad) {
      expect(() => mint({ labels })).toThrow();
      expect(verifyNodeCredentialSync(raw({ ...good, labels }), { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
    }
    // Eight is fine; "default" is an ordinary label.
    expect(() => mint({ labels: ["a", "b", "c", "d", "e", "f", "g", "default"] })).not.toThrow();
  });

  test("unknown v, missing typ, bad id", () => {
    for (const c of [{ ...good, v: 2 }, { ...good, typ: undefined }, { ...good, id: "legacy" }, { ...good, id: "" }]) {
      expect(verifyNodeCredentialSync(raw(c), { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
    }
    expect(() => mint({ id: "legacy" })).toThrow(/reserved/);
  });

  test("both keys during rotation", () => {
    const oldTok = mint({}, OLD);
    const newTok = mint({}, KEY);
    expect(verifyNodeCredentialSync(oldTok, { keys: [KEY, OLD], now: NOW }).ok).toBe(true);
    expect(verifyNodeCredentialSync(newTok, { keys: [KEY, OLD], now: NOW }).ok).toBe(true);
    // Previous key dropped: the old credential stops.
    expect(verifyNodeCredentialSync(oldTok, { keys: [KEY], now: NOW }).ok).toBe(false);
  });

  test("no key configured", () => {
    expect(verifyNodeCredentialSync(mint(), { keys: [], now: NOW })).toEqual({ ok: false, reason: "unconfigured" });
    expect(() => mintNodeCredential({ id: "a", labels: ["a"] }, { key: "" })).toThrow(/SLAUDE_NODE_KEY/);
  });

  test("a job token is not a node credential and the reverse, even under one key", () => {
    const job = mintJobToken(
      { tenant: "default", persona: "default", session: "S", team: "T", channel: "C", thread: "1", initiator: "U", scope: "turn" },
      { secret: KEY, now: NOW },
    );
    expect(verifyNodeCredentialSync(job, { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
    expect(verifyJobToken(mint(), { secret: KEY, now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
  });
});

describe("revocation", () => {
  test("a revoked id is refused when issued before revoked_before; a later credential passes", async () => {
    const before = NOW / 1000 + 10;
    const v = new NodeCredentialVerifier({ revocations: async (id) => (id === "engineering-a" ? before : null) });
    expect(await v.verify(mint(), { keys: [KEY], now: NOW + 20_000 })).toEqual({ ok: false, reason: "revoked" });
    const later = mint({}, KEY, NOW + 11_000);
    expect((await v.verify(later, { keys: [KEY], now: NOW + 20_000 })).ok).toBe(true);
    expect((await v.verify(mint({ id: "finance-a" }), { keys: [KEY], now: NOW + 20_000 })).ok).toBe(true);
  });

  test("lookups are cached for 30 s", async () => {
    let calls = 0;
    let before: number | null = null;
    const v = new NodeCredentialVerifier({ revocations: async () => (calls++, before) });
    const t = mint();
    expect((await v.verify(t, { keys: [KEY], now: NOW })).ok).toBe(true);
    before = NOW / 1000 + 1;
    expect((await v.verify(t, { keys: [KEY], now: NOW + 29_000 })).ok).toBe(true); // cached
    expect(calls).toBe(1);
    expect(await v.verify(t, { keys: [KEY], now: NOW + 31_000 })).toEqual({ ok: false, reason: "revoked" });
    expect(calls).toBe(2);
  });

  test("no revocation store (sqlite): accepted, one warning", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      const v = new NodeCredentialVerifier({ revocations: async () => undefined });
      expect((await v.verify(mint(), { keys: [KEY], now: NOW })).ok).toBe(true);
      expect((await v.verify(mint({ id: "x-b" }), { keys: [KEY], now: NOW })).ok).toBe(true);
    } finally {
      console.warn = orig;
    }
    expect(warns.filter((w) => w.includes("revocation needs Postgres"))).toHaveLength(1);
  });

  test("store failure: fails closed without a cached answer, serves a stale one with it", async () => {
    let fail = true;
    const v = new NodeCredentialVerifier({
      revocations: async () => {
        if (fail) throw new Error("db down");
        return null;
      },
    });
    await expect(v.verify(mint(), { keys: [KEY], now: NOW })).rejects.toThrow(/db down/);
    fail = false;
    expect((await v.verify(mint(), { keys: [KEY], now: NOW })).ok).toBe(true);
    fail = true;
    expect((await v.verify(mint(), { keys: [KEY], now: NOW + 60_000 })).ok).toBe(true);
  });

  describe("node_revocations on Postgres (PGLite)", () => {
    let dbc: DbClient;
    beforeAll(async () => {
      dbc = await openDb({ dialect: "pg", driver: "pglite" });
      await runMigrations(dbc, { log: () => {} });
    });
    afterAll(async () => {
      await dbc.close();
    });

    test("revoke writes the row; the verifier refuses credentials issued before it", async () => {
      const issued = Date.now() - 60_000;
      const t = mint({ id: "pg-revoke" }, KEY, issued);
      const v = new NodeCredentialVerifier({ revocations: revocationSourceFor(dbc), cacheMs: 0 });
      expect((await v.verify(t, { keys: [KEY] })).ok).toBe(true);
      await revokeNodeCredential("pg-revoke", dbc);
      expect(await v.verify(t, { keys: [KEY] })).toEqual({ ok: false, reason: "revoked" });
      // Re-minted after the revocation: accepted.
      const fresh = mint({ id: "pg-revoke" }, KEY, Date.now() + 2000);
      expect((await v.verify(fresh, { keys: [KEY], now: Date.now() + 2000 })).ok).toBe(true);
      // Revoking again moves revoked_before forward (upsert, no conflict error).
      await revokeNodeCredential("pg-revoke", dbc);
    });
  });
});

describe("expiry gauge", () => {
  test("exports seconds to expiry per seen id, bounded", async () => {
    const v = new NodeCredentialVerifier({ revocations: async () => null });
    await v.verify(mint({ id: "gauge-a", ttlSec: 1000 }), { keys: [KEY], now: NOW });
    expect(metrics.render()).toMatch(/slaude_node_credential_expiry_seconds\{id="gauge-a"\} 1000/);
    for (let i = 0; i < MAX_GAUGED_CREDENTIALS + 5; i++) {
      await v.verify(mint({ id: `gauge-n${i}` }), { keys: [KEY], now: NOW });
    }
    const series = metrics.render().split("\n").filter((l) => l.startsWith("slaude_node_credential_expiry_seconds{"));
    expect(series.filter((l) => l.includes("gauge-")).length).toBeLessThanOrEqual(MAX_GAUGED_CREDENTIALS);
  });
});
