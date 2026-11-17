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

/**
 * Resolves when everything tracked so far, and what it started, has settled, or
 * after `maxMs` (default 15 s). Work that is still stuck then is dropped from the
 * registry: a hung background write must never make every later test hook (or a
 * shutdown) wait forever.
 */
export async function flushFirstSightWork(maxMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (inflight.size) {
    const left = deadline - Date.now();
    if (left <= 0) {
      inflight.clear();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...inflight]), new Promise((r) => (timer = setTimeout(r, left)))]);
    if (timer) clearTimeout(timer);
  }
}
