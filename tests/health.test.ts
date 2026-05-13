import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { startHealthServer } from "../src/health";

let server: ReturnType<typeof startHealthServer> = null;

afterEach(() => {
  server?.stop();
  server = null;
});

describe("startHealthServer", () => {
  test("port=0 disables", () => {
    process.env.SLAUDE_HEALTH_PORT = "0";
    const s = startHealthServer({ liveSessions: () => 0 });
    expect(s).toBeNull();
  });

  test("invalid port disables", () => {
    process.env.SLAUDE_HEALTH_PORT = "abc";
    const s = startHealthServer({ liveSessions: () => 0 });
    expect(s).toBeNull();
  });

  test("/readyz returns 503 when db query throws", async () => {
    const port = 19000 + Math.floor(Math.random() * 500);
    process.env.SLAUDE_HEALTH_PORT = String(port);
    server = startHealthServer({ liveSessions: () => 0 });
    // Monkey-patch db.query to throw on next /readyz call
    const dbMod = await import("../src/db/schema");
    const orig = dbMod.db.query;
    (dbMod.db as any).query = () => ({
      get() {
        throw new Error("db down");
      },
    });
    try {
      const r = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(r.status).toBe(503);
      const body = (await r.json()) as any;
      expect(body.error).toContain("db down");
    } finally {
      (dbMod.db as any).query = orig;
    }
  });

  test("/healthz, /readyz, 404 path", async () => {
    process.env.SLAUDE_HEALTH_PORT = "0"; // disabled — but we need a real port
    delete process.env.SLAUDE_HEALTH_PORT;
    process.env.SLAUDE_HEALTH_PORT = String(0); // bun picks free port? no — need a real number
    // pick random high port
    const port = 18000 + Math.floor(Math.random() * 1000);
    process.env.SLAUDE_HEALTH_PORT = String(port);

    server = startHealthServer({ liveSessions: () => 7 });
    expect(server).not.toBeNull();

    const h = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json() as Promise<any>);
    expect(h.status).toBe("ok");
    expect(h.sessions_live).toBe(7);
    expect(typeof h.uptime_ms).toBe("number");

    const r = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.status).toBe("ready");

    const nf = await fetch(`http://127.0.0.1:${port}/whatever`);
    expect(nf.status).toBe(404);

    const mr = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(mr.status).toBe(200);
    expect(mr.headers.get("content-type")).toContain("text/plain");
    const metricsBody = await mr.text();
    expect(typeof metricsBody).toBe("string");
  });
});
