import { useEffect, useState } from "react";
import { api, IS_MOCK } from "./api";
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
        <div className="op-id" data-testid="operator"><span className="dot" />{api().operator}</div>
      </header>
      <main className="main">
        {route ? <SessionDetail id={route} onBack={back} /> : <SessionList onOpen={open} />}
      </main>
    </div>
  );
}
