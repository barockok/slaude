/**
 * Registry of background brain work: jobs started without an awaiting caller,
 * such as the gateway's boot-time source bootstrap and KB wiki import.
 *
 * Without it nothing owned that work. `closeBrain()` disconnected the engine
 * under a running import ("PGLite not connected"), and `GatewayHandle.stop()`
 * returned while the import kept running. Tracked work lets the brain's
 * lifecycle wait for it, and lets a long import stop between KBs when the
 * brain is closing.
 *
 * Deliberately import-free: `tests/setup.ts` loads it statically (to drain
 * work left by a gateway a test never stopped), and anything that imports
 * config/home there would freeze `paths.home` before the test home is set.
 */

const inFlight = new Set<Promise<unknown>>();
let closing = 0;

/** Register background work. The returned promise is the one passed in. */
export function trackBrainWork<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  const done = () => void inFlight.delete(p);
  p.then(done, done);
  return p;
}

/** Number of tracked jobs still running. */
export function pendingBrainWork(): number {
  return inFlight.size;
}

/** Wait until no tracked work is running (work started while waiting included). */
export async function settleBrainWork(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/** True while a close is waiting for tracked work: long jobs should stop early. */
export function brainClosing(): boolean {
  return closing > 0;
}

/** Run `fn` with brainClosing() true (used by closeBrain while it settles work). */
export async function whileClosing<T>(fn: () => Promise<T>): Promise<T> {
  closing++;
  try {
    return await fn();
  } finally {
    closing--;
  }
}
