/**
 * Operator auth for the control panel (design §6 / §"Operator auth").
 *
 * The panel sits behind an SSO/ingress (oauth2-proxy, Cloudflare Access) that
 * authenticates the operator and injects a trusted identity header. The panel
 * never handles passwords — it trusts that header, optionally allowlists it,
 * and fails closed:
 *
 *   - `SLAUDE_PANEL_TRUST_HEADER` unset → the panel refuses to serve at all
 *     (guards a deploy that exposed `/panel` with no ingress in front). This is
 *     enforced by the caller before this middleware runs (see createPanelApi).
 *   - identity header absent → 403.
 *   - `SLAUDE_PANEL_ALLOW` non-empty and identity ∉ allow → 403.
 *
 * The resolved identity is attached to the request as the `operatorId`, used as
 * the turn initiator on panel chat and in every audit line.
 */
import { env } from "../../config/env";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type OperatorAuth =
  | { ok: true; operatorId: string }
  | { ok: false; response: Response };

/**
 * Resolve + authorize the operator from the trusted identity header. Returns
 * the operatorId or the error Response to send. Does NOT enforce the
 * trust-header boot guard — that is a mount-time concern handled once by the
 * panel API before any request is routed.
 */
export function authenticateOperator(req: Request): OperatorAuth {
  const headerName = env.panel.header();
  const raw = req.headers.get(headerName);
  const operatorId = raw?.trim();
  if (!operatorId) {
    // Fail-closed: a missing identity header means the ingress did not vouch
    // for this request (or is misconfigured) — never serve it.
    return { ok: false, response: json(403, { error: "missing operator identity header" }) };
  }
  const allow = env.panel.allow();
  if (allow.length > 0) {
    // Case-insensitive: identity providers vary the case of emails/ids, and a
    // case-mismatched allowlist entry must not lock a valid operator out.
    const needle = operatorId.toLowerCase();
    if (!allow.some((a) => a.toLowerCase() === needle)) {
      return { ok: false, response: json(403, { error: "operator not in allowlist" }) };
    }
  }
  return { ok: true, operatorId };
}
