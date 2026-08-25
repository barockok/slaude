/**
 * Outbound-Slack suppression wrapper (design §Active-surface lock, outbound
 * gate). While an operator drives a session from the panel, the agent still
 * runs — but its user-visible surface writes (reply / edit / react / upload /
 * typing) must not echo to Slack; the operator watches the turn over the panel
 * SSE tail instead.
 *
 * This wraps a Surface so those write methods become no-ops while `held(id)` is
 * true, and pass through once the lock releases. Read paths (getHistory) and
 * the approval gate always pass through — an operator driving the session does
 * not sever the agent's ability to read context or request approvals.
 *
 * Covers BOTH poster paths: the in-process MCP surface (mono) and the `/v1`
 * tool-plane surface the node calls (gateway role). Since that `/v1` post is
 * load-balanced to ANY replica — not necessarily the one holding the lock —
 * `held` is async and authoritative (it consults Redis, cached ~1s), so a
 * replica that is not the lock owner still suppresses the echo. Method calls
 * stay bound to the original surface so instance state (`this`) is preserved.
 */
import type { Surface } from "../core/surface";

export function suppressibleSurface(
  surface: Surface,
  sessionId: string,
  held: (id: string) => Promise<boolean>,
): Surface {
  return {
    id: surface.id,
    capabilities: surface.capabilities,
    getHistory: (i) => surface.getHistory(i),
    requestApproval: (r) => surface.requestApproval(r),
    reply: async (i) =>
      (await held(sessionId)) ? { ref: "panel-suppressed" } : surface.reply(i),
    edit: surface.edit ? async (i) => ((await held(sessionId)) ? undefined : surface.edit!(i)) : undefined,
    react: surface.react ? async (i) => ((await held(sessionId)) ? undefined : surface.react!(i)) : undefined,
    unreact: surface.unreact
      ? async (i) => ((await held(sessionId)) ? undefined : surface.unreact!(i))
      : undefined,
    upload: surface.upload
      ? async (i) => ((await held(sessionId)) ? undefined : surface.upload!(i))
      : undefined,
    typing: surface.typing ? async (i) => ((await held(sessionId)) ? undefined : surface.typing!(i)) : undefined,
  };
}
