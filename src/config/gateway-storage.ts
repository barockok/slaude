/**
 * A gateway may not run on an embedded database — neither for slaude's own
 * data nor for the brain. Enforced at boot, before anything opens either one.
 *
 * Gateways are replicas, and an embedded database lives in one process's files.
 * Replicas on per-pod storage each get a private copy that silently diverges.
 * Replicas on the shared volume are two writers on a single-writer database,
 * and the brain's PGLite makes that worse: it treats any lock it finds at boot
 * as stale and deletes it, so each replica clears the other's live lock.
 *
 * mono and node are exempt. mono is one process by definition, and a node holds
 * no database and no brain (spec §1).
 */

export interface GatewayStorageInput {
  role: "mono" | "gateway" | "node";
  /** DbClient.driver: bun-sql (Postgres server) | bun-sqlite | pglite. */
  dbDriver: string;
  brainEnabled: boolean;
  /** Resolves the brain engine name. Called only when it matters, and allowed
   *  to throw — a misconfigured engine is reported as a violation. */
  brainEngine: () => string;
}

/** The only app database driver that is a server shared by all replicas. */
const SERVER_DRIVER = "bun-sql";

export function gatewayStorageViolations(i: GatewayStorageInput): string[] {
  if (i.role !== "gateway") return [];
  const out: string[] = [];

  if (i.dbDriver !== SERVER_DRIVER) {
    out.push(
      `slaude data is on an embedded database (driver ${i.dbDriver}). A gateway needs a Postgres server ` +
        `every replica shares: set SLAUDE_DB=pg and SLAUDE_PG_URL. Note SLAUDE_DB=pg without SLAUDE_PG_URL ` +
        `selects in-process PGLite.`,
    );
  }

  if (i.brainEnabled) {
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

export function assertGatewayStorage(i: GatewayStorageInput): void {
  const violations = gatewayStorageViolations(i);
  if (violations.length === 0) return;
  throw new Error(
    `SLAUDE_ROLE=gateway refuses to start on embedded storage:\n` +
      violations.map((v) => `  - ${v}`).join("\n"),
  );
}
