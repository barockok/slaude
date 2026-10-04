import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetNodeAuthWarnings,
  __setNodeVerifier,
  authenticateNode,
  JOB_HEADER,
  mintJobToken,
  requireJobToken,
  timingSafeStringEqual,
  verifyJobToken,
  type JobClaims,
} from "../../../src/gateway/api/auth";
import { mintNodeCredential, NodeCredentialVerifier } from "../../../src/gateway/auth/node-credential";
import { metrics } from "../../../src/metrics";

const SECRET = "test-job-secret";

const baseClaims: Omit<JobClaims, "exp" | "iat"> = {
  tenant: "default",
  persona: "default",
  session: "S1",
  team: "T1",
  channel: "C1",
  thread: "1.0",
  initiator: "U1",
  scope: "turn",
};

describe("timingSafeStringEqual", () => {
  test("equal / unequal / length-mismatched", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(true);
  });
});

describe("mintJobToken / verifyJobToken", () => {
  test("round-trips claims", () => {
    const token = mintJobToken(baseClaims, { secret: SECRET });
    const r = verifyJobToken(token, { secret: SECRET });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.session).toBe("S1");
      expect(r.claims.tenant).toBe("default");
      expect(r.claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  test("expired token is rejected", () => {
    const token = mintJobToken(baseClaims, { secret: SECRET, ttlSec: 10 });
    const r = verifyJobToken(token, { secret: SECRET, now: Date.now() + 11_000 });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  test("tampered payload is rejected", () => {
    const token = mintJobToken(baseClaims, { secret: SECRET });
    const [h, p, s] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.session = "S2"; // privilege-escalate to another session
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    expect(verifyJobToken(forged, { secret: SECRET })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("wrong secret is rejected", () => {
    const token = mintJobToken(baseClaims, { secret: SECRET });
    expect(verifyJobToken(token, { secret: "other" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("missing / malformed tokens are rejected", () => {
    expect(verifyJobToken(null, { secret: SECRET })).toEqual({ ok: false, reason: "missing" });
    expect(verifyJobToken("", { secret: SECRET })).toEqual({ ok: false, reason: "missing" });
    expect(verifyJobToken("a.b", { secret: SECRET })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyJobToken("not a jwt at all", { secret: SECRET })).toEqual({ ok: false, reason: "malformed" });
  });

  test("missing claim fields are rejected", () => {
    const { initiator: _drop, ...partial } = baseClaims;
    const token = mintJobToken(partial as any, { secret: SECRET });
    expect(verifyJobToken(token, { secret: SECRET })).toEqual({ ok: false, reason: "bad_claims" });
  });

  test("unset secret: mint throws, verify refuses", () => {
    const prev = process.env.SLAUDE_JOB_SECRET;
    delete process.env.SLAUDE_JOB_SECRET;
    try {
      expect(() => mintJobToken(baseClaims)).toThrow(/SLAUDE_JOB_SECRET/);
      expect(verifyJobToken("x.y.z")).toEqual({ ok: false, reason: "unconfigured" });
    } finally {
      if (prev !== undefined) process.env.SLAUDE_JOB_SECRET = prev;
    }
  });
});

describe("authenticateNode", () => {
  const req = (auth?: string) =>
    new Request("http://localhost/v1/pending/x", { headers: auth ? { authorization: auth } : {} });
  const VARS = ["SLAUDE_NODE_TOKEN", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_NODE_KEY", "SLAUDE_NODE_KEY_PREVIOUS", "SLAUDE_NODE_LEGACY"];
  let saved: Record<string, string | undefined> = {};
  let warns: string[] = [];
  const origWarn = console.warn;
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    for (const k of VARS) delete process.env[k];
    __resetNodeAuthWarnings();
    __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
    warns = [];
    console.warn = (m: string) => warns.push(String(m));
  });
  afterEach(() => {
    console.warn = origWarn;
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __setNodeVerifier(null);
  });
  const legacyCount = () => Number(metrics.render().match(/^slaude_node_legacy_auth_total(?:\{[^}]*\})? (\d+)/m)?.[1] ?? 0);

  test("neither a key nor a legacy token configured → 503", async () => {
    const r = await authenticateNode(req("Bearer anything"));
    expect(!r.ok && r.response.status).toBe(503);
  });

  test("legacy token under the new variable: wrong / missing / matching", async () => {
    process.env.SLAUDE_NODE_LEGACY_TOKEN = "node-secret";
    expect(((await authenticateNode(req())) as any).response.status).toBe(401);
    expect(((await authenticateNode(req("Bearer wrong"))) as any).response.status).toBe(401);
    expect(((await authenticateNode(req("node-secret"))) as any).response.status).toBe(401); // no Bearer prefix
    const ok = await authenticateNode(req("bearer node-secret")); // case-insensitive scheme
    expect(ok.ok).toBe(true);
    if (ok.ok) expect({ ...ok.node, labels: [...ok.node.labels] }).toEqual({ id: "legacy", labels: ["default"], legacy: true });
    expect(warns).toEqual([]);
  });

  test("legacy token under the old variable: accepted, with one deprecation warning", async () => {
    process.env.SLAUDE_NODE_TOKEN = "node-secret";
    expect((await authenticateNode(req("Bearer node-secret"))).ok).toBe(true);
    expect((await authenticateNode(req("Bearer node-secret"))).ok).toBe(true);
    expect(warns.filter((w) => w.includes("SLAUDE_NODE_LEGACY_TOKEN"))).toHaveLength(1);
  });

  test("SLAUDE_NODE_LEGACY=off rejects the legacy token outright", async () => {
    process.env.SLAUDE_NODE_LEGACY_TOKEN = "node-secret";
    process.env.SLAUDE_NODE_LEGACY = "off";
    // No key either: nothing is configured → 503.
    expect(((await authenticateNode(req("Bearer node-secret"))) as any).response.status).toBe(503);
    process.env.SLAUDE_NODE_KEY = "node-key";
    expect(((await authenticateNode(req("Bearer node-secret"))) as any).response.status).toBe(401);
    const cred = mintNodeCredential({ id: "eng-a", labels: ["engineering"] }, { key: "node-key" });
    expect((await authenticateNode(req(`Bearer ${cred}`))).ok).toBe(true);
  });

  test("signed credential yields its claims; tampered or foreign-keyed → 401", async () => {
    process.env.SLAUDE_NODE_KEY = "node-key";
    const cred = mintNodeCredential({ id: "eng-a", labels: ["engineering", "eu"] }, { key: "node-key" });
    const ok = await authenticateNode(req(`Bearer ${cred}`));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.node.id).toBe("eng-a");
      expect([...ok.node.labels].sort()).toEqual(["engineering", "eu"]);
      expect(ok.node.legacy).toBe(false);
      expect(typeof ok.expiresAt).toBe("number");
    }
    const [h, p, sig] = cred.split(".") as [string, string, string];
    const forged = JSON.parse(Buffer.from(p, "base64url").toString());
    forged.labels = ["finance"];
    const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    expect(((await authenticateNode(req(`Bearer ${tampered}`))) as any).response.status).toBe(401);
    const foreign = mintNodeCredential({ id: "eng-a", labels: ["engineering"] }, { key: "other-key" });
    expect(((await authenticateNode(req(`Bearer ${foreign}`))) as any).response.status).toBe(401);
    // A job token is not a node credential.
    process.env.SLAUDE_JOB_SECRET = "node-key";
    try {
      const job = mintJobToken(baseClaims);
      expect(((await authenticateNode(req(`Bearer ${job}`))) as any).response.status).toBe(401);
    } finally {
      delete process.env.SLAUDE_JOB_SECRET;
    }
  });

  test("the previous key is accepted during rotation", async () => {
    process.env.SLAUDE_NODE_KEY = "new-key";
    process.env.SLAUDE_NODE_KEY_PREVIOUS = "old-key";
    const old = mintNodeCredential({ id: "eng-a", labels: ["engineering"] }, { key: "old-key" });
    expect((await authenticateNode(req(`Bearer ${old}`))).ok).toBe(true);
  });

  test("a revoked credential stops at the next call", async () => {
    process.env.SLAUDE_NODE_KEY = "node-key";
    let before: number | null = null;
    __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => before, cacheMs: 0 }));
    const cred = mintNodeCredential({ id: "eng-a", labels: ["engineering"] }, { key: "node-key", now: Date.now() - 5000 });
    expect((await authenticateNode(req(`Bearer ${cred}`))).ok).toBe(true);
    before = Math.floor(Date.now() / 1000);
    expect(((await authenticateNode(req(`Bearer ${cred}`))) as any).response.status).toBe(401);
  });

  test("revocation store down → 503 (fail closed)", async () => {
    process.env.SLAUDE_NODE_KEY = "node-key";
    __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => { throw new Error("down"); } }));
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => errs.push(a.join(" "));
    try {
      const cred = mintNodeCredential({ id: "eng-a", labels: ["engineering"] }, { key: "node-key" });
      expect(((await authenticateNode(req(`Bearer ${cred}`))) as any).response.status).toBe(503);
    } finally {
      console.error = origErr;
    }
  });

  test("legacy use while SLAUDE_NODE_KEY is set: warns once and counts every use", async () => {
    process.env.SLAUDE_NODE_LEGACY_TOKEN = "node-secret";
    const before = legacyCount();
    expect((await authenticateNode(req("Bearer node-secret"))).ok).toBe(true);
    expect(legacyCount()).toBe(before); // no key: not counted
    process.env.SLAUDE_NODE_KEY = "node-key";
    await authenticateNode(req("Bearer node-secret"));
    await authenticateNode(req("Bearer node-secret"));
    expect(legacyCount()).toBe(before + 2);
    expect(warns.filter((w) => w.includes("SLAUDE_NODE_LEGACY=off"))).toHaveLength(1);
  });
});

describe("requireJobToken", () => {
  test("valid header → claims; invalid → 401; unconfigured → 503", () => {
    process.env.SLAUDE_JOB_SECRET = SECRET;
    try {
      const token = mintJobToken(baseClaims);
      const good = requireJobToken(new Request("http://x/v1/sessions/S1", { headers: { [JOB_HEADER]: token } }));
      expect("claims" in good && good.claims.session).toBe("S1");
      const bad = requireJobToken(new Request("http://x/v1/sessions/S1", { headers: { [JOB_HEADER]: token + "x" } }));
      expect("response" in bad && bad.response.status).toBe(401);
      const missing = requireJobToken(new Request("http://x/v1/sessions/S1"));
      expect("response" in missing && missing.response.status).toBe(401);
    } finally {
      delete process.env.SLAUDE_JOB_SECRET;
    }
    const unconfigured = requireJobToken(new Request("http://x/v1/sessions/S1"));
    expect("response" in unconfigured && unconfigured.response.status).toBe(503);
  });
});
