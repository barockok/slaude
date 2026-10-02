export async function until<T>(
  fn: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const every = opts.intervalMs ?? 250;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
