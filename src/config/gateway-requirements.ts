/**
 * What a gateway requires to run as one of several interchangeable replicas.
 * Gateways and nodes both scale horizontally, so anything that only works for a
 * single process is refused at boot, before anything is opened or connected.
 *
 * Slack ingress must be the Events API webhook. Socket Mode delivers events over
 * a websocket whose consumer is single-leader: replicas would both consume
 * events and send duplicate responses.
 *
 * No embedded database, for slaude's own data or for the brain. An embedded
 * database lives in one process's files.
 * Replicas on per-pod storage each get a private copy that silently diverges.
 * Replicas on the shared volume are two writers on a single-writer database,
 * and the brain's PGLite makes that worse: it treats any lock it finds at boot
 * as stale and deletes it, so each replica clears the other's live lock.
 *
 * mono and node are exempt. mono is one process by definition, and a node holds
 * no database and no brain (spec §1).
 */

export interface GatewayRequirementsInput {
  role: "mono" | "gateway" | "node";
  /** env.slack.mode(): socket (the default) | http (Events API webhook). */
  slackMode: "socket" | "http";
  /** DbClient.driver: bun-sql (Postgres server) | bun-sqlite | pglite. */
  dbDriver: string;
  brainEnabled: boolean;
  /** local = this process opens the brain database; remote = the brain lives in
   *  a separate brain-server and this process never opens one. */
  brainMode: "local" | "remote";
  /** Resolves the brain engine name. Called only when it matters, and allowed
   *  to throw — a misconfigured engine is reported as a violation. */
  brainEngine: () => string;
}

/** The only app database driver that is a server shared by all replicas. */
const SERVER_DRIVER = "bun-sql";

export function gatewayRequirementViolations(i: GatewayRequirementsInput): string[] {
  if (i.role !== "gateway") return [];
  const out: string[] = [];

  if (i.slackMode !== "http") {
    out.push(
      `Slack ingress is Socket Mode. A gateway must take Slack over the Events API webhook: set ` +
        `SLAUDE_SLACK_MODE=http. Socket Mode's websocket consumer is single-leader, so gateway replicas ` +
        `would both consume events and send duplicate responses. Socket Mode is the default when unset.`,
    );
  }

  if (i.dbDriver !== SERVER_DRIVER) {
    out.push(
      `slaude data is on an embedded database (driver ${i.dbDriver}). A gateway needs a Postgres server ` +
        `every replica shares: set SLAUDE_DB=pg and SLAUDE_PG_URL. Note SLAUDE_DB=pg without SLAUDE_PG_URL ` +
        `selects in-process PGLite.`,
    );
  }

  // Remote mode: the brain-server owns the brain database, so the gateway's own
  // engine setting is irrelevant and must not be consulted.
  if (i.brainEnabled && i.brainMode === "local") {
    let engine: string;
    try {
      engine = i.brainEngine();
    } catch (e) {
      out.push(`the brain engine is misconfigured: ${e instanceof Error ? e.message : String(e)}`);
      return out;
    }
    if (engine !== "postgres") {
      out.push(
        `the brain is on an embedded database (engine ${engine}). PGLite is single-writer and clears locks ` +
          `it finds at boot, so replicas would corrupt it. Set SLAUDE_BRAIN_ENGINE=postgres and ` +
          `SLAUDE_BRAIN_DATABASE_URL (a database with the vector, pg_trgm and pgcrypto extensions), ` +
          `or disable the brain with SLAUDE_BRAIN_DISABLED=1.`,
      );
    }
  }

  return out;
}

export function assertGatewayRequirements(i: GatewayRequirementsInput): void {
  const violations = gatewayRequirementViolations(i);
  if (violations.length === 0) return;
  throw new Error(
    `SLAUDE_ROLE=gateway refuses to start:\n` +
      violations.map((v) => `  - ${v}`).join("\n"),
  );
}
