/**
 * Gateways scale horizontally, so every replica must be interchangeable. That
 * rules out two things a single process can get away with.
 *
 * Slack ingress over Socket Mode: the websocket consumer is single-leader, so
 * replicas would both consume events and send duplicate responses. A gateway
 * takes Slack over the Events API webhook instead.
 *
 * Embedded databases, for slaude's own data or the brain.
 *
 * Gateways are replicas. An embedded database lives in one process's files: two
 * replicas on per-pod storage each get a private, diverging copy, and two
 * replicas on the shared volume are two writers on one single-writer database.
 * The brain's PGLite additionally deletes any lock it finds at boot, so on
 * shared storage each replica clears the other's live lock.
 */
import { describe, expect, test } from "bun:test";
import {
  assertGatewayRequirements,
  gatewayRequirementViolations,
  type GatewayRequirementsInput,
} from "../../src/config/gateway-requirements";

const server: GatewayRequirementsInput = {
  role: "gateway",
  slackMode: "http",
  dbDriver: "bun-sql",
  brainEnabled: true,
  brainMode: "local",
  brainEngine: () => "postgres",
};

describe("gatewayRequirementViolations: storage", () => {
  test("a gateway on a Postgres server with the brain on Postgres is allowed", () => {
    expect(gatewayRequirementViolations(server)).toEqual([]);
  });

  test("a gateway with the brain disabled needs only its app database on a server", () => {
    expect(gatewayRequirementViolations({ ...server, brainEnabled: false, brainEngine: () => "pglite" })).toEqual([]);
  });

  test("no requirement applies outside the gateway role, Socket Mode included", () => {
    const embedded = {
      slackMode: "socket" as const,
      dbDriver: "bun-sqlite",
      brainEnabled: true,
      brainMode: "local" as const,
      brainEngine: () => "pglite",
    };
    expect(gatewayRequirementViolations({ ...embedded, role: "mono" })).toEqual([]);
    expect(gatewayRequirementViolations({ ...embedded, role: "node" })).toEqual([]);
  });

  test("sqlite for slaude data is refused on a gateway", () => {
    const v = gatewayRequirementViolations({ ...server, dbDriver: "bun-sqlite" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SLAUDE_PG_URL");
  });

  // The silent case: SLAUDE_DB=pg without a URL selects in-process PGLite, which
  // still reports the pg dialect, so a dialect check alone lets it through.
  test("PGLite for slaude data is refused even though it reports the pg dialect", () => {
    const v = gatewayRequirementViolations({ ...server, dbDriver: "pglite" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("pglite");
    expect(v[0]).toContain("SLAUDE_PG_URL");
  });

  test("the brain on PGLite is refused on a gateway", () => {
    const v = gatewayRequirementViolations({ ...server, brainEngine: () => "pglite" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SLAUDE_BRAIN_ENGINE=postgres");
  });

  test("a brain engine that cannot be resolved is reported, not thrown past", () => {
    const v = gatewayRequirementViolations({
      ...server,
      brainEngine: () => {
        throw new Error("SLAUDE_BRAIN_ENGINE=postgres requires SLAUDE_BRAIN_DATABASE_URL");
      },
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SLAUDE_BRAIN_DATABASE_URL");
  });

  // In remote mode the brain lives in a separate brain-server process and the
  // gateway never opens a brain database, so its engine setting is irrelevant.
  test("a remote-mode brain is allowed whatever the local engine setting says", () => {
    const v = gatewayRequirementViolations({
      ...server,
      brainMode: "remote",
      brainEngine: () => {
        throw new Error("must not be consulted in remote mode");
      },
    });
    expect(v).toEqual([]);
  });

  test("remote mode does not excuse embedded storage for slaude data", () => {
    const v = gatewayRequirementViolations({ ...server, brainMode: "remote", dbDriver: "pglite" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SLAUDE_PG_URL");
  });

  test("an unknown app database driver is refused rather than assumed safe", () => {
    expect(gatewayRequirementViolations({ ...server, dbDriver: "something-new" })).toHaveLength(1);
  });

  test("both violations are reported together, so one boot shows everything to fix", () => {
    expect(
      gatewayRequirementViolations({ ...server, dbDriver: "pglite", brainEngine: () => "pglite" }),
    ).toHaveLength(2);
  });
});

describe("gatewayRequirementViolations: Slack ingress", () => {
  test("a gateway on the Events API webhook is allowed", () => {
    expect(gatewayRequirementViolations({ ...server, slackMode: "http" })).toEqual([]);
  });

  // Socket Mode is the default, so a gateway that never set a mode lands here.
  test("a gateway on Socket Mode is refused", () => {
    const v = gatewayRequirementViolations({ ...server, slackMode: "socket" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SLAUDE_SLACK_MODE=http");
  });

  test("every violation is reported together, ingress and storage alike", () => {
    expect(
      gatewayRequirementViolations({
        ...server,
        slackMode: "socket",
        dbDriver: "pglite",
        brainEngine: () => "pglite",
      }),
    ).toHaveLength(3);
  });
});

describe("assertGatewayRequirements", () => {
  test("returns quietly when allowed", () => {
    expect(() => assertGatewayRequirements(server)).not.toThrow();
  });

  test("throws with every violation in the message", () => {
    let message = "";
    try {
      assertGatewayRequirements({ ...server, slackMode: "socket", dbDriver: "bun-sqlite", brainEngine: () => "pglite" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("SLAUDE_PG_URL");
    expect(message).toContain("SLAUDE_BRAIN_ENGINE=postgres");
    expect(message).toContain("SLAUDE_SLACK_MODE=http");
  });
});
