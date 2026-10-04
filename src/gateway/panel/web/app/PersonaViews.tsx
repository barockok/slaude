// Presentational persona views (WS-C §4.4.3), rendered from already-loaded
// bodies. No API import, so they render the same from the real backend, the
// ?mock=1 fixtures, or a test. Everything shown is a reference or a presence
// flag: the server never sends a credential value, an MCP URL, header, env or
// argument.
import type { ReactNode } from "react";
import type { PersonaDetail, PersonaSummary } from "./types";
import { personaColor, personaInitial } from "./lib";
import { Copy } from "./ui";

const KB_SHORT = { all: "all KBs", none: "no KB", list: "listed KBs" } as const;
const KB_MODE = { all: "Every installed knowledge base", none: "No knowledge base", list: "Only the listed knowledge bases" } as const;
const VIA_LABEL = { bridge: "gateway bridge", stdio: "node-local stdio", none: "not served on nodes" } as const;

/** The persona table (null = loading). */
export function PersonaTable({ personas, onOpen }: { personas: PersonaSummary[] | null; onOpen: (name: string) => void }) {
  return (
    <div className="tablewrap">
      <table className="fleet">
        <thead>
          <tr>
            <th>Persona</th>
            <th>Origin</th>
            <th>Runs on</th>
            <th className="hide-sm">Model</th>
            <th>Knowledge</th>
            <th className="hide-sm">MCP</th>
          </tr>
        </thead>
        <tbody>
          {personas === null && Array.from({ length: 4 }).map((_, i) => (
            <tr key={i}>{Array.from({ length: 6 }).map((__, j) => <td key={j}><div className="sk" style={{ height: 12, width: j === 0 ? 140 : 70 }} /></td>)}</tr>
          ))}
          {personas?.map((p) => (
            <tr key={p.name} data-persona={p.name} onClick={() => onOpen(p.name)} className={p.tombstoned ? "tombstoned" : undefined}>
              <td>
                <span className="persona">
                  <span className="av" style={{ background: personaColor(p.name) }}>{personaInitial(p.name)}</span>
                  {p.name}
                </span>
                {p.tombstoned && <span className="chip cold" style={{ marginLeft: 8 }}>retired</span>}
              </td>
              <td className="cell-dim">{p.origin}</td>
              <td><span className="chip node">{p.runsOn ?? "default"}</span></td>
              <td className="hide-sm">
                <span className="model-tag">{p.fields.model.live ?? "gateway default"}</span>
                {p.fields.model.overridden && <span className="chip lock" style={{ marginLeft: 6 }}>override</span>}
              </td>
              <td className="cell-dim">{KB_SHORT[p.kb.mode]}</td>
              <td className="hide-sm cell-dim">{p.fields.mcp.live === "present" ? "configured" : "-"}</td>
            </tr>
          ))}
          {personas !== null && personas.length === 0 && (
            <tr><td colSpan={6}><div className="empty"><div className="big">No personas</div>Sync personas from git to see them here.</div></td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 404, 409 (no persona tables on this deployment) and anything else. */
export function PersonaLoadError({ error, name }: { error: Error; name?: string }) {
  const status = (error as { status?: unknown }).status;
  const [title, detail] =
    status === 404 ? [`No persona named ${name ?? "that"}`, "It may have been renamed, or never synced."]
    : status === 409 ? ["Personas are not available here", error.message]
    : ["Could not load personas", error.message];
  return (
    <div className="empty" data-testid="persona-error" data-status={typeof status === "number" ? status : undefined}>
      <div className="big">{title}</div>
      {detail}
    </div>
  );
}

/** One persona's definition. */
export function PersonaView({ persona: p }: { persona: PersonaDetail }) {
  return (
    <>
      <div className="ident">
        <div className="ident-top">
          <span className="persona"><span className="av" style={{ background: personaColor(p.name) }}>{personaInitial(p.name)}</span></span>
          <span className="ident-title">{p.name}</span>
          <span className="chip node">{p.origin}</span>
          {p.tombstoned && <span className="chip cold" data-testid="persona-retired">retired</span>}
        </div>
        <div className="meta-grid">
          <Meta k="Slack user">{p.slackUserId ? <Copy text={p.slackUserId} /> : "-"}</Meta>
          <Meta k="Runs on" mono>{p.runsOn ?? "default"}</Meta>
          <Meta k="Model (live)" mono>{(p.model.live ?? "gateway default") + (p.model.overridden ? " · override" : "")}</Meta>
          <Meta k="Model (git)" mono>{p.model.git ?? "gateway default"}</Meta>
        </div>
      </div>

      <Section title="Soul" testid="persona-soul" note={`${p.soul.length} characters${p.soul.overridden ? " · runtime override" : ""}`}>
        <pre className="tl-content code persona-soul">{p.soul.preview}{p.soul.length > p.soul.preview.length ? "…" : ""}</pre>
      </Section>

      <Section title="Provider" testid="persona-provider" note="References only; the panel never sees a credential value.">
        <div className="meta-grid flat">
          <Ref k="API key" v={p.provider.apiKey} />
          <Ref k="Auth token" v={p.provider.authToken} />
          <Ref k="OAuth token" v={p.provider.oauthToken} />
          <Meta k="Base URL" mono>{p.provider.baseUrl ?? "provider default"}</Meta>
        </div>
      </Section>

      <Section title="MCP servers" testid="persona-mcp" note="Name, route and hostname only. URLs, headers, env and arguments are never shown.">
        {p.mcp.length === 0 ? <Empty>None configured.</Empty> : (
          <table className="fleet static">
            <thead><tr><th>Server</th><th>Route</th><th>Type</th><th>Host</th><th>Agent OAuth</th></tr></thead>
            <tbody>
              {p.mcp.map((s) => (
                <tr key={s.name} data-mcp={s.name}>
                  <td className="mono">{s.name}</td>
                  <td className="cell-dim">{VIA_LABEL[s.via]}</td>
                  <td className="cell-dim">{s.type}</td>
                  <td className="mono cell-dim">{s.host ?? "-"}</td>
                  <td>{s.via !== "bridge" ? <span className="cell-mute">-</span> : s.oauth ? <span className="chip warm">connected</span> : <span className="chip cold">not connected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Knowledge" testid="persona-kb" note={KB_MODE[p.kb.mode]}>
        {p.kb.sources.length === 0 ? <Empty>{p.kb.mode === "none" ? "This persona reads no knowledge base." : "No knowledge base is installed."}</Empty> : (
          <div className="chips">
            {p.kb.sources.map((s) => (
              <span key={s.id} className={`chip ${s.installed ? "node" : "cold"}`} data-kb={s.id} title={s.installed ? "installed" : "listed, but not installed"}>
                {s.id}{s.installed ? "" : " · not installed"}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="Skills" testid="persona-skills">
        {p.skills.length === 0 ? <Empty>No skills.</Empty> : (
          <table className="fleet static">
            <thead><tr><th>Skill</th><th>Name</th><th>Source</th></tr></thead>
            <tbody>
              {p.skills.map((s) => (
                <tr key={s.slug} data-skill={s.slug}>
                  <td className="mono">{s.slug}</td>
                  <td>{s.name}</td>
                  <td className="cell-dim">{s.source === "persona" ? "this persona" : "global"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Nodes" testid="persona-nodes" note={`Live nodes holding the label ${p.runsOn ?? "default"}`}>
        {p.nodes === null ? <Empty>No node registry answered (single-process deployment, or Redis unavailable).</Empty>
          : p.nodes.length === 0 ? <Empty>No live node holds this label: turns for this persona wait until one does.</Empty>
          : (
            <div className="chips">
              {p.nodes.map((n) => (
                <span key={n.id} className="chip node" data-node={n.id} title={`labels: ${n.labels.join(", ")}`}>
                  <span className="d" style={{ background: n.alive ? "var(--st-green)" : "var(--st-neutral)" }} />{n.id} · {n.labels.join(", ")}
                </span>
              ))}
            </div>
          )}
      </Section>
    </>
  );
}

function Section({ title, note, testid, children }: { title: string; note?: string; testid: string; children: ReactNode }) {
  return (
    <section className="card persona-section" data-testid={testid}>
      <div className="persona-section-head"><h2>{title}</h2>{note && <span className="cell-mute">{note}</span>}</div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="cell-mute persona-empty">{children}</div>;
}

function Meta({ k, mono, children }: { k: string; mono?: boolean; children: ReactNode }) {
  return <div className="meta-item"><div className="k">{k}</div><div className={`v ${mono ? "mono" : ""}`}>{children}</div></div>;
}

/** A credential field: a reference is copyable; "stored" and "none" are plain. */
function Ref({ k, v }: { k: string; v: string }) {
  const isRef = v.startsWith("vault://") || v.startsWith("env://");
  return <Meta k={k} mono>{isRef ? <Copy text={v} /> : v}</Meta>;
}
