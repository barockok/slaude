import { useEffect, useState } from "react";
import { api, onForbidden, ApiError, IS_MOCK } from "./api";
import type { Me } from "./types";
import { SessionList } from "./List";
import { SessionDetail } from "./Detail";

function readRoute(): string | null {
  const h = location.hash.replace(/^#/, "");
  const m = h.match(/^\/s\/(.+)$/);
  return m ? m[1]! : null;
}

const params = new URLSearchParams(location.search);

function initialTheme(): "light" | "dark" {
  const q = params.get("theme");
  if (q === "dark" || q === "light") return q;
  try { const s = localStorage.getItem("slaude-theme"); if (s === "dark" || s === "light") return s; } catch { /* private mode */ }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App() {
  const [route, setRoute] = useState<string | null>(readRoute());
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme());
  const [me, setMe] = useState<Me | null>(null);
  // The shell waits for /panel/auth/me rather than flashing a half-authenticated
  // header, or a fleet the viewer may turn out not to be allowed to see.
  const [identified, setIdentified] = useState(false);
  const [forbidden, setForbidden] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // An identity-level 403 raised by any later request lands here too: being
    // unlisted is not a per-click failure, so it takes over the whole view.
    onForbidden((b) => { if (alive) { setForbidden(b?.error ?? "not authorized for this panel"); setIdentified(true); } });
    api().me()
      .then((m) => {
        if (!alive) return;
        if (!m) {
          location.href = `/panel/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
          return;
        }
        setMe(m);
        setIdentified(true);
      })
      .catch((e) => {
        if (!alive) return;
        // A 403 already went through onForbidden; anything else (provider down,
        // network) leaves the shell to surface its own load error.
        if (!(e instanceof ApiError && e.status === 403)) setIdentified(true);
      });
    return () => { alive = false; onForbidden(null); };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("slaude-theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const open = (id: string) => { location.hash = `/s/${id}`; setRoute(id); };
  const back = () => { location.hash = ""; setRoute(null); };

  if (!identified) return null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">s</span>slaude <small>· fleet</small></div>
        {IS_MOCK && <span className="mock-badge" data-testid="mock-badge">FIXTURE MODE</span>}
        <div className="topbar-spacer" />
        <button className="icon-btn" data-testid="theme-toggle" title="Toggle theme"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
          {theme === "dark" ? "☀" : "☾"}
        </button>
        {me && (
          <div className="identity">
            <span className="identity-email" data-testid="operator"><span className="dot" />{me.email}</span>
            <span className={`role-badge role-${me.role}`} data-testid="role-badge">{me.role}</span>
            <button className="signout" data-testid="signout" onClick={() => void api().logout()}>Sign out</button>
          </div>
        )}
      </header>
      <main className="main">
        {forbidden
          ? <Forbidden email={me?.email ?? null} />
          : route ? <SessionDetail id={route} onBack={back} /> : <SessionList onOpen={open} />}
      </main>
    </div>
  );
}

/** Identity-level denial: signed in with the provider, absent from the panel
 *  role lists. Distinct from an expired session, which redirects to login. */
function Forbidden({ email }: { email: string | null }) {
  return (
    <div className="notice notice-forbidden" role="alert" data-testid="notice-forbidden">
      <h2>Not authorized</h2>
      <p>You are signed in as {email ?? "an unlisted identity"}, which is not in this panel's role lists.</p>
      <p>Ask an administrator to add you to the panel role file, then sign in again.</p>
      <button className="btn" onClick={() => void api().logout()}>Sign out</button>
    </div>
  );
}
