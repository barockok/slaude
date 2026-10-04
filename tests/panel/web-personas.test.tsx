/**
 * Panel web app, persona screens (WS-C §4.4.3): the hash routes, the two views
 * rendered from the ?mock=1 fixtures, and the 404/409 states.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseRoute, statusMeta, relTime, exactTime, clockTime, summarize } from "../../src/gateway/panel/web/app/lib";
import { PersonaTable, PersonaLoadError, PersonaView } from "../../src/gateway/panel/web/app/PersonaViews";
import { StatusDot, RelTime, Modal } from "../../src/gateway/panel/web/app/ui";
import { FIXTURE_PERSONAS, FIXTURE_PERSONA_DETAILS } from "../../src/gateway/panel/web/app/fixtures";

// The shape of the client's ApiError (api.ts, which needs DOM types the
// server-side typecheck does not load): an Error carrying the HTTP status.
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("hash routes", () => {
  test("sessions keep their route; #/p and #/p/<name> are the persona screens", () => {
    expect(parseRoute("")).toEqual({ kind: "fleet" });
    expect(parseRoute("#/s/s_ravi_9f3c21")).toEqual({ kind: "session", id: "s_ravi_9f3c21" });
    expect(parseRoute("#/p")).toEqual({ kind: "personas" });
    expect(parseRoute("#/p/")).toEqual({ kind: "personas" });
    expect(parseRoute("#/p/ravi")).toEqual({ kind: "persona", name: "ravi" });
    expect(parseRoute("#/p/a%20b")).toEqual({ kind: "persona", name: "a b" });
    expect(parseRoute("#/p/%E0%A4%A")).toEqual({ kind: "personas" });
  });
});

describe("persona list", () => {
  test("one row per fixture persona, with label, KB mode and retired marker", () => {
    const html = renderToStaticMarkup(<PersonaTable personas={FIXTURE_PERSONAS} onOpen={() => {}} />);
    for (const p of FIXTURE_PERSONAS) expect(html).toContain(`data-persona="${p.name}"`);
    expect(html).toContain("finance");
    expect(html).toContain("listed KBs");
    expect(html).toContain("no KB");
    expect(html.match(/retired/g)?.length).toBe(1);
  });

  test("loading renders skeleton rows; an empty list says so", () => {
    expect(renderToStaticMarkup(<PersonaTable personas={null} onOpen={() => {}} />)).toContain('class="sk"');
    expect(renderToStaticMarkup(<PersonaTable personas={[]} onOpen={() => {}} />)).toContain("No personas");
  });
});

describe("persona detail", () => {
  test("renders every section from the fixture", () => {
    const html = renderToStaticMarkup(<PersonaView persona={FIXTURE_PERSONA_DETAILS.ravi!} />);
    for (const id of ["persona-soul", "persona-provider", "persona-mcp", "persona-kb", "persona-skills", "persona-nodes"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("vault://kv/agents/ravi#api_key");
    expect(html).toContain("ledger.example.com");
    expect(html).toContain("connected");
    expect(html).toContain("kb-audit · not installed");
    expect(html).toContain("this persona");
    expect(html).toContain("gw-node-3");
  });

  test("states: no nodes, no registry, KB none, retired", () => {
    expect(renderToStaticMarkup(<PersonaView persona={FIXTURE_PERSONA_DETAILS.lena!} />)).toContain("No live node holds this label");
    const max = renderToStaticMarkup(<PersonaView persona={FIXTURE_PERSONA_DETAILS.max!} />);
    expect(max).toContain("No node registry answered");
    expect(max).toContain('data-testid="persona-retired"');
    expect(renderToStaticMarkup(<PersonaView persona={FIXTURE_PERSONA_DETAILS.toko!} />)).toContain("reads no knowledge base");
  });

  test("404, 409 and other failures each have their own message", () => {
    const nf = renderToStaticMarkup(<PersonaLoadError error={httpError(404, "x")} name="ghost" />);
    expect(nf).toContain("No persona named ghost");
    const pg = renderToStaticMarkup(<PersonaLoadError error={httpError(409, "persona sync requires Postgres")} />);
    expect(pg).toContain("not available here");
    expect(pg).toContain("persona sync requires Postgres");
    expect(renderToStaticMarkup(<PersonaLoadError error={new Error("network down")} />)).toContain("network down");
  });
});

// The real backend's two calls are exercised by the browser suite
// (tests/panel-web), which drives them against the stub server.

describe("shared primitives the persona views render with", () => {
  test("lib helpers and ui primitives", () => {
    expect(statusMeta("running").running).toBe(true);
    expect(statusMeta("").label).toBe("Unknown");
    const base = 1_000_000_000;
    expect([2, 30, 600, 7_200, 172_800].map((s) => relTime(base - s * 1000, base))).toEqual(["just now", "30s ago", "10m ago", "2h ago", "2d ago"]);
    expect(exactTime(base)).toMatch(/GMT[+-]\d\d$/);
    expect(clockTime(base)).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(summarize([{ status: "running", warm: true, engaged: 1 }, { status: "idle", warm: false, engaged: 0 }] as any)).toEqual({
      total: 2, by: { running: 1, idle: 1 }, warm: 1, engaged: 1,
    });
    const html = renderToStaticMarkup(<>
      <StatusDot status="running" />
      <RelTime ts={base} base={base} />
      <Modal title="t" onClose={() => {}}>body</Modal>
    </>);
    expect(html).toContain("Running");
    expect(html).toContain("just now");
    expect(html).toContain('role="dialog"');
  });
});
