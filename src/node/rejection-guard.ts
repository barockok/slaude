/**
 * The node worker's last line against an unhandled promise rejection.
 *
 * Bun ends the process on one. A node worker serves many sessions, so a
 * single session's background work (a teardown write, a fire-and-forget
 * status call) that rejects with nobody awaiting it would take every other
 * session on the pod down with it: the 2026-10-10 crash was exactly this, a
 * session-row write with an expired job token.
 *
 * Such a handler can hide bugs, so it is loud rather than quiet: one
 * `console.error` line with the session (when the error names one), the
 * error's status/body for a gateway refusal, and the stack, all through
 * redactSecrets, plus the slaude_errors_total{kind="unhandled_rejection"}
 * counter to alert on. The fix for any rejection that reaches it is still to
 * handle it at its source.
 *
 * A circuit breaker bounds what it can hide: `max` rejections inside
 * `windowMs` (default 5 in 60 s) is not one session's stray promise but a
 * broken loop (a claim worker or connection that keeps failing), and a pod
 * that is alive but does no work is worse than a restart. The breaker logs
 * and exits non-zero.
 *
 * Only rejections. A synchronous uncaught exception keeps Bun's default and
 * ends the process, and boot failures stay fatal through main()'s catch (the
 * guard is installed only after the worker has started).
 */
import { m as metric } from "../metrics";
import { redactSecrets } from "../gateway/core/status-text";
import { NodeApiError } from "./client";

const SESSION_IN_MESSAGE = /session=([A-Za-z0-9._:-]+)/;

/** One log line for a rejection reason, secret-shaped substrings masked. */
export function describeRejection(reason: unknown): string {
  const carried = reason && typeof reason === "object" ? (reason as { sessionId?: unknown }).sessionId : undefined;
  const message = reason instanceof Error ? reason.message : String(reason);
  const session = typeof carried === "string" ? carried : (SESSION_IN_MESSAGE.exec(message)?.[1] ?? "unknown");
  const api = reason instanceof NodeApiError ? ` status=${reason.status} body=${reason.body.slice(0, 300)}` : "";
  const stack = reason instanceof Error && reason.stack ? `\n${reason.stack}` : "";
  return redactSecrets(`session=${session}${api}: ${message}${stack}`);
}

export interface RejectionGuardOptions {
  log?: (line: string) => void;
  /** Rejections inside the window that trip the breaker. Default 5. */
  max?: number;
  windowMs?: number;
  exit?: (code: number) => void;
  now?: () => number;
}

/** The handler: log and count every rejection; exit 1 when the breaker trips. */
export function makeRejectionHandler(o: RejectionGuardOptions = {}): (reason: unknown) => void {
  const log = o.log ?? ((l: string) => console.error(l));
  const max = o.max ?? 5;
  const windowMs = o.windowMs ?? 60_000;
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const now = o.now ?? Date.now;
  let recent: number[] = [];
  return (reason) => {
    metric.errorsTotal.inc({ kind: "unhandled_rejection" });
    log(`[node] UNHANDLED REJECTION (process kept alive; handle it at its source) ${describeRejection(reason)}`);
    const t = now();
    recent = recent.filter((at) => t - at < windowMs);
    recent.push(t);
    if (recent.length >= max) {
      log(`[node] ${recent.length} unhandled rejections within ${Math.round(windowMs / 1000)}s: a broken loop, not one session's work; exiting so the pod restarts`);
      exit(1);
    }
  };
}

/** Install the guard; returns its uninstaller (tests). */
export function installRejectionGuard(o: RejectionGuardOptions = {}): () => void {
  const onRejection = makeRejectionHandler(o);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("unhandledRejection", onRejection);
  };
}
