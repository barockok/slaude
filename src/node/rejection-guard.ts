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
 * error's status/body for a gateway refusal, and the stack, plus the
 * slaude_errors_total{kind="unhandled_rejection"} counter to alert on. The
 * fix for any rejection that reaches it is still to handle it at its source.
 *
 * Only rejections. A synchronous uncaught exception keeps Bun's default and
 * ends the process, and boot failures stay fatal through main()'s catch (the
 * guard is installed after the boot handshake).
 */
import { m as metric } from "../metrics";
import { NodeApiError } from "./client";

const SESSION_IN_MESSAGE = /session=([A-Za-z0-9._:-]+)/;

/** One log line for a rejection reason. */
export function describeRejection(reason: unknown): string {
  const carried = reason && typeof reason === "object" ? (reason as { sessionId?: unknown }).sessionId : undefined;
  const message = reason instanceof Error ? reason.message : String(reason);
  const session = typeof carried === "string" ? carried : (SESSION_IN_MESSAGE.exec(message)?.[1] ?? "unknown");
  const api = reason instanceof NodeApiError ? ` status=${reason.status} body=${reason.body.slice(0, 300)}` : "";
  const stack = reason instanceof Error && reason.stack ? `\n${reason.stack}` : "";
  return `session=${session}${api}: ${message}${stack}`;
}

/** Install the guard; returns its uninstaller (tests). */
export function installRejectionGuard(o: { log?: (line: string) => void } = {}): () => void {
  const log = o.log ?? ((l: string) => console.error(l));
  const onRejection = (reason: unknown) => {
    metric.errorsTotal.inc({ kind: "unhandled_rejection" });
    log(`[node] UNHANDLED REJECTION (process kept alive; handle it at its source) ${describeRejection(reason)}`);
  };
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("unhandledRejection", onRejection);
  };
}
