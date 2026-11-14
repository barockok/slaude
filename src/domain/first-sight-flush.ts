/**
 * Import-free registry of first-sight work in flight, so test setup and
 * `_wipeForTests` can wait for fire-and-forget writes without loading the db.
 */
const inflight = new Set<Promise<unknown>>();

/** Track a promise until it settles. Never rejects into the caller. */
export function trackFirstSight<T>(p: Promise<T>): Promise<T> {
  const done = p.then(() => {}, () => {}).finally(() => inflight.delete(done));
  inflight.add(done);
  return p;
}

/** Resolves when everything tracked so far, and what it started, has settled. */
export async function flushFirstSightWork(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}
