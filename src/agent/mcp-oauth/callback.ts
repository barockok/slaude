/**
 * Parse an OAuth callback that a Slack user pastes back into the thread (paste-back
 * mode, for deploys where the loopback isn't reachable — e.g. k8s). Accepts:
 *   - a full redirect URL: `https://redirect.example/page?code=ABC&state=XYZ`
 *   - a bare query fragment: `code=ABC&state=XYZ` or `?code=ABC&state=XYZ`
 *   - a bare code token (no `code=`): `ABC123...` → { code, state: undefined }
 *
 * Returns `{ code: undefined }` when nothing code-like is present. State is the
 * caller's CSRF guard — validate it against the pending flow's issued state.
 */
export interface ParsedCallback {
  code?: string;
  state?: string;
}

export function parseOAuthCallback(text: string): ParsedCallback {
  const t = (text || "").trim();
  if (!t) return {};

  // 1) Anything carrying `code=` → parse the query string. Try a full URL first,
  //    then fall back to the substring after the first `?`, then the whole thing.
  if (/[?&]?code=/.test(t)) {
    let qs = "";
    try {
      qs = new URL(t).search.replace(/^\?/, "");
    } catch {
      const q = t.indexOf("?");
      qs = q >= 0 ? t.slice(q + 1) : t;
    }
    const params = new URLSearchParams(qs);
    const code = params.get("code") || undefined;
    const state = params.get("state") || undefined;
    if (code) return { code, state };
    return {};
  }

  // 2) Bare token: a single whitespace-free string that looks like an auth code.
  //    No state available — the caller relies on thread+initiator scoping. Require
  //    >=20 chars (real authorization codes are long) so ordinary one-word replies
  //    ("acknowledged", a short path) aren't swallowed as a code while a flow is
  //    pending. Users should prefer pasting the full callback URL (carries state).
  if (!/\s/.test(t) && /^[A-Za-z0-9._~\-]{20,}$/.test(t)) {
    return { code: t };
  }

  return {};
}
