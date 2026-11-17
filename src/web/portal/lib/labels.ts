/**
 * Display helpers for the portal: how an identity was linked, how long a
 * connection lasts, and what came back from a connect.
 */
import type { ConnectResult } from "../../../gateway/portal/api-types";
import { relativeFuture, shortDate } from "../../shared/time";

const LINKED_VIA: Record<string, string> = {
  "signed-link": "/link",
};

/** "/link" for the signed link (sent to an agent on any surface); other methods in sentence case. */
export function linkedViaLabel(via: string): string {
  const known = LINKED_VIA[via];
  if (known) return known;
  const s = via.replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Unknown";
}

/**
 * The second line under a Connected badge. The stored access token renews on
 * use when the service issued a refresh token, so a past expiry is not shown
 * as an error.
 */
export function connectionDetail(expiresAt: number | null, now: number = Date.now()): string {
  if (expiresAt == null) return "";
  // A past expiry: the next use trades the refresh token for a new one.
  if (expiresAt <= now) return "Renews on next use";
  const soon = relativeFuture(expiresAt - now);
  return soon ? `Access token expires ${soon}` : `Access token valid until ${shortDate(expiresAt)}`;
}

/** Toast copy for `?connect=` on the return from the provider. */
export const CONNECT_RESULT: Record<ConnectResult, { tone: "success" | "danger"; title: string; description: string }> = {
  connected: {
    tone: "success",
    title: "Integration connected",
    description: "Agents can use it when they work for you in a /1on1.",
  },
  expired: {
    tone: "danger",
    title: "Connection timed out",
    description: "It took too long, or it was started in another browser. Try connecting again.",
  },
  failed: {
    tone: "danger",
    title: "Connection did not complete",
    description: "The service did not send back an authorization. Try connecting again.",
  },
  "no-flow": {
    tone: "danger",
    title: "Connection attempt no longer valid",
    description: "That attempt was already used or has expired. Try connecting again.",
  },
  "state-mismatch": {
    tone: "danger",
    title: "Connection refused",
    description: "The service's answer did not match the request, so nothing was changed.",
  },
  "exchange-failed": {
    tone: "danger",
    title: "The service refused the connection",
    description: "It did not accept the authorization. Try again, or ask an operator if it keeps failing.",
  },
};

export const isConnectResult = (v: string): v is ConnectResult => Object.prototype.hasOwnProperty.call(CONNECT_RESULT, v);
