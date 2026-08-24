/**
 * Node-side long-poll loop on /v1/pending/:id (spec §3 "Blocking tools").
 * One place owns the retry semantics: 204 → poll again immediately (the
 * gateway held the request for its window), network/5xx → short nap then
 * retry, abort → stop. The gateway's row expiry guarantees termination —
 * an expired gate long-polls back as status 'expired' at once.
 */
import type { NodeClient, PendingView } from "./client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PendingOutcome = PendingView | "notfound" | "aborted";

export async function pollPending(
  client: NodeClient,
  pendingId: string,
  opts: { signal?: AbortSignal; retryDelayMs?: number } = {},
): Promise<PendingOutcome> {
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  // Abort must win instantly even while a 30s long-poll leg is in flight —
  // race every await against the signal instead of only checking between legs.
  const abortedPromise = new Promise<"aborted">((resolve) => {
    if (!opts.signal) return; // never resolves
    if (opts.signal.aborted) resolve("aborted");
    else opts.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  for (;;) {
    if (opts.signal?.aborted) return "aborted";
    let leg: PendingView | "timeout" | "notfound" | "aborted" | "netfail";
    try {
      leg = await Promise.race([client.getPending(pendingId), abortedPromise]);
    } catch {
      leg = "netfail";
    }
    if (leg === "aborted") return "aborted";
    if (leg === "netfail") {
      const r = await Promise.race([sleep(retryDelayMs).then(() => "slept" as const), abortedPromise]);
      if (r === "aborted") return "aborted";
      continue;
    }
    if (leg === "timeout") continue;
    return leg;
  }
}
