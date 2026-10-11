/**
 * Registry of running poll loops (the cron scheduler's interval), each with
 * the stop function that ends it.
 *
 * A loop's owner is the gateway that started it, and GatewayHandle.stop()
 * stops it. The registry exists for owners that never stop: in one test
 * process, a gateway a test never stopped kept polling the shared DB facade
 * for the rest of the run. `stopRunningLoops()` lets tests/setup.ts end them
 * after each test.
 *
 * Deliberately import-free: tests/setup.ts loads it before SLAUDE_HOME is set.
 */

const loops = new Set<() => void>();

/** Register a running loop; returns the function that unregisters it. */
export function registerLoop(stop: () => void): () => void {
  loops.add(stop);
  return () => void loops.delete(stop);
}

/** Number of registered loops still running. */
export function runningLoops(): number {
  return loops.size;
}

/** Stop every registered loop (each stop unregisters itself). */
export function stopRunningLoops(): void {
  for (const stop of [...loops]) {
    loops.delete(stop);
    stop();
  }
}
