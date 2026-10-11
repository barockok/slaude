/**
 * A node holds no database (node labels and routing spec §4.0). Before the
 * Secret split a node silently opened an in-memory PGLite when SLAUDE_DB=pg came
 * without a URL, ran every migration, and read empty tables (a /1on1 lock always
 * read null). In the node role an embedded database is refused, loudly.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDbAccessError, assertNodeMayOpen } from "../../src/db/client";

describe("assertNodeMayOpen", () => {
  test("refuses embedded storage in the node role", () => {
    expect(() => assertNodeMayOpen({ dialect: "pg", driver: "pglite" }, "node")).toThrow(NodeDbAccessError);
    expect(() => assertNodeMayOpen({ dialect: "sqlite", path: "/data/db.sqlite" }, "node")).toThrow(NodeDbAccessError);
  });

  test("the message names the setting, never a value", () => {
    try {
      assertNodeMayOpen({ dialect: "pg", driver: "pglite" }, "node");
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NodeDbAccessError);
      expect((e as Error).message).toContain("node");
      expect((e as Error).message).toContain("SLAUDE_PG_URL");
    }
  });

  test("allows every config outside the node role, and a real server URL in it", () => {
    for (const role of ["mono", "gateway"] as const) {
      expect(() => assertNodeMayOpen({ dialect: "pg", driver: "pglite" }, role)).not.toThrow();
      expect(() => assertNodeMayOpen({ dialect: "sqlite", path: "/x" }, role)).not.toThrow();
    }
    expect(() => assertNodeMayOpen({ dialect: "pg", driver: "bun-sql", url: "postgres://u:p@h/db" }, "node")).not.toThrow();
  });
});

// The facade end to end, in its own process so no earlier test has opened a
// client: a repository read in the node role fails at once, without migrating.
describe("the db facade in the node role", () => {
  for (const [label, dbEnv] of [
    ["SLAUDE_DB=pg without a URL", { SLAUDE_DB: "pg" }],
    ["SLAUDE_DB unset (sqlite)", {}],
  ] as const) {
    test(`${label}: a read rejects with NodeDbAccessError`, async () => {
      const home = mkdtempSync(join(tmpdir(), "slaude-node-db-"));
      try {
        const script = `
          const OneOnOne = await import(${JSON.stringify(join(import.meta.dir, "../../src/db/one-on-one.ts"))});
          try { await OneOnOne.find("C1", "1.1"); console.log("RESULT:read"); }
          catch (e) { console.log("RESULT:" + e.name); }
        `;
        const proc = Bun.spawn(["bun", "-e", script], {
          env: { PATH: process.env.PATH ?? "", HOME: home, SLAUDE_HOME: home, SLAUDE_ROLE: "node", ...dbEnv },
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        const out = await new Response(proc.stdout).text();
        expect(out).toContain("RESULT:NodeDbAccessError");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
