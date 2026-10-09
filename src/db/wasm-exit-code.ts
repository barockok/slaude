/**
 * PGLite is an Emscripten build. When one of its WASM programs exits (initdb
 * during a fresh open, the backend on close), the runtime's quit handler
 * writes that program's status into `process.exitCode` — 0 on most opens, 99
 * on a fresh file-backed data dir. The host process then exits with whatever
 * the last open or close left behind, even when nothing failed.
 *
 * Run every PGLite open/close (slaude's driver and the brain's engine) through
 * this so the host's exit code stays the host's. slaude itself never sets
 * process.exitCode, so restoring the value from before the call loses nothing.
 */
export async function keepingExitCode<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.exitCode;
  try {
    return await fn();
  } finally {
    // Bun ignores `process.exitCode = undefined`; 0 is the same exit.
    process.exitCode = before ?? 0;
  }
}
