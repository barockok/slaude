/**
 * Every piece of process-wide state the boundary feature owns, reset in one place so
 * no test depends on what an earlier one left behind:
 *  - first sight's background work (queue, late fill, resolver warm reads) is settled,
 *    then its cache and counters are reset;
 *  - the shared resolver (cache, negative cache, the 30 s failure backoff, an injected
 *    resolver) is dropped;
 *  - the periodic fill's resume points are forgotten;
 *  - the SLAUDE_BOUNDARY_* switches are removed from the environment.
 * The caller wipes its own tables (a test that created rows owns deleting them).
 */
import { __setBoundaryResolver, resetBoundaryResolver } from "../../src/domain/boundary-for";
import { resetBoundaryFillCursors } from "../../src/domain/boundary-backfill";
import { resetFirstSight } from "../../src/domain/first-sight";
import { flushFirstSightWork } from "../../src/domain/first-sight-flush";

export async function resetBoundaryState(): Promise<void> {
  await flushFirstSightWork();
  resetFirstSight();
  resetBoundaryResolver();
  __setBoundaryResolver(undefined);
  resetBoundaryFillCursors();
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_BOUNDARY_")) delete process.env[k];
}
