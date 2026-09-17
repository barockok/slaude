/**
 * A gateway may not run on an embedded database — neither for slaude's own
 * data nor for the brain.
 *
 * Gateways are replicas. An embedded database lives in one process's files: two
 * replicas on per-pod storage each get a private, diverging copy, and two
 * replicas on the shared volume are two writers on one single-writer database.
 * The brain's PGLite additionally deletes any lock it finds at boot, so on
 * shared storage each replica clears the other's live lock.
 */
import { describe, expect, test } from "bun:test";
import {
  assertGatewayStorage,
  gatewayStorageViolations,
  type GatewayStorageInput,
} from "../../src/config/gateway-storage";

const server: GatewayStorageInput = {
  role: "gateway",
  dbDriver: "bun-sql",
  brainEnabled: true,
  brainEngine: () => "postgres",
};

describe("gatewayStorageViolations", () => {
  test("a gateway on a Postgres server with the brain on Postgres is allowed", () => {
    expect(gatewayStorageViolations(server)).toEqual([]);
  });

  test("a gateway with the brain disabled needs only its app database on a server", () => {
    expect(gatewayStorageViolations({ ...server, brainEnabled: false, brainEngine: () => "pglite" })).toEqual([]);
  });

  test("the rule does not apply outside the gateway role", () => {
    const embedded = { dbDriver: "bun-sqlite", brainEnabled: true, brainEngine: () => "pglite" };
    expect(gatewayStorageViolations({ ...embedded, role: "mono" })).toEqual([]);
    expect(gatewayStorageViolations({ ...embedded, role: "node" })).toEqual([]);
  });

  test("sqlite for slaude data is refused on a gateway", () => {
    const v = gatewayStorageViolations({ ...server, dbDriver: "bun-sqlite" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SLAUDE_PG_URL");
  });

  // The silent case: SLAUDE_DB=pg without a URL selects in-process PGLite, which
  // still reports the pg dialect, so a dialect check alone lets it through.
  test("PGLite for slaude data is refused even though it reports the pg dialect", () => {
    const v = gatewayStorageViolations({ ...server, dbDriver: "pglite" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("pglite");
    expect(v[0]).toContain("SLAUDE_PG_URL");
  });

  test("the brain on PGLite is refused on a gateway", () => {
    const v = gatewayStorageViolations({ ...server, brainEngine: () => "pglite" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SLAUDE_BRAIN_ENGINE=postgres");
  });

  test("a brain engine that cannot be resolved is reported, not thrown past", () => {
    const v = gatewayStorageViolations({
      ...server,
      brainEngine: () => {
        throw new Error("SLAUDE_BRAIN_ENGINE=postgres requires SLAUDE_BRAIN_DATABASE_URL");
      },
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SLAUDE_BRAIN_DATABASE_URL");
  });

  test("an unknown app database driver is refused rather than assumed safe", () => {
    expect(gatewayStorageViolations({ ...server, dbDriver: "something-new" })).toHaveLength(1);
  });

  test("both violations are reported together, so one boot shows everything to fix", () => {
    expect(
      gatewayStorageViolations({ ...server, dbDriver: "pglite", brainEngine: () => "pglite" }),
    ).toHaveLength(2);
  });
});

describe("assertGatewayStorage", () => {
  test("returns quietly when allowed", () => {
    expect(() => assertGatewayStorage(server)).not.toThrow();
  });

  test("throws with every violation in the message", () => {
    let message = "";
    try {
      assertGatewayStorage({ ...server, dbDriver: "bun-sqlite", brainEngine: () => "pglite" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("SLAUDE_PG_URL");
    expect(message).toContain("SLAUDE_BRAIN_ENGINE=postgres");
  });
});
