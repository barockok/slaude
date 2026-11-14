/**
 * Veto keys (slice C, 0041). A veto names a pair of identities by VALUE, hashed,
 * so it survives a binding being deleted and re-created with a new id, and so
 * neither the veto table nor the ledger holds an address or a Slack id.
 */
import { createHash } from "node:crypto";
import type { BindingRow } from "../db/domain";

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

export const slackKey = (teamId: string, slackUserId: string): string => hash(`slack:${teamId}/${slackUserId}`);
export const oidcKey = (issuer: string, subject: string): string => hash(`oidc:${issuer}#${subject}`);
export const emailKey = (address: string): string => hash(`email:${address}`);

/** The veto key of a binding, or null for a service no veto names. */
export function bindingKey(b: Pick<BindingRow, "service" | "kind" | "workspace" | "value">): string | null {
  if (b.service === "slack" && b.kind === "user") return slackKey(b.workspace, b.value);
  if (b.service === "oidc" && b.kind === "subject") return oidcKey(b.workspace, b.value);
  if (b.service === "email") return emailKey(b.value);
  return null;
}

/** A pair in the order the table stores it. */
export const orderedPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
