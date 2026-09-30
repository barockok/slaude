import { paramInt, parseDurationMs } from "./tag";
import type { Tag } from "./types";

export type FaultAction = "proxy" | "error" | "drop" | "malformed" | "hang";

export interface FaultPlan {
  action: FaultAction;
  /** Sleep before responding (time to first token). */
  delayMs: number;
  /** Pause between streamed events. */
  intervalMs: number;
  /** HTTP status when action is "error". */
  status: number;
  /** Events to pass through before cutting the stream when action is "drop". */
  dropAfterEvents: number;
}

const NONE: FaultPlan = { action: "proxy", delayMs: 0, intervalMs: 0, status: 0, dropAfterEvents: 0 };

/**
 * Pure: depends only on the tag and `retryCount`, the number of earlier attempts
 * of this same request. The client's own `x-stainless-retry-count` header does
 * not advance after a 429/529 (verified in the spike), so the server's front
 * handler counts attempts and passes the count in. No state lives here.
 */
export function planFaults(tag: Tag | null, retryCount: number): FaultPlan {
  if (!tag) return NONE;
  const p = tag.params;
  const plan: FaultPlan = {
    ...NONE,
    delayMs: parseDurationMs(p["ttft"], 0),
    intervalMs: parseDurationMs(p["interval"], 0),
  };
  if (p["hang"] === "1") return { ...plan, action: "hang" };
  if (p["overflow"] === "1") return { ...plan, action: "error", status: 400 };
  const failStatus = paramInt(tag, "fail", 0);
  if (failStatus > 0 && retryCount < paramInt(tag, "until-retry", 1)) {
    return { ...plan, action: "error", status: failStatus };
  }
  const drop = paramInt(tag, "drop", 0);
  if (drop > 0) return { ...plan, action: "drop", dropAfterEvents: drop };
  if (p["malformed"] === "1") return { ...plan, action: "malformed" };
  return plan;
}

const TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  429: "rate_limit_error",
  529: "overloaded_error",
};

export function errorBody(status: number): { type: "error"; error: { type: string; message: string } } {
  const type = TYPES[status] ?? "api_error";
  const message = status === 400 ? "prompt is too long: 250000 tokens > 200000 maximum" : `mock ${type}`;
  return { type: "error", error: { type, message } };
}
