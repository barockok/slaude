/**
 * Panel web app, persona screens (WS-C §4.4.3): the hash routes, the two views
 * rendered from the ?mock=1 fixtures, the 404/409 states, and the real
 * backend's two read calls.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseRoute } from "../../src/gateway/panel/web/app/lib";
import { PersonaTable, PersonaLoadError, PersonaView } from "../../src/gateway/panel/web/app/PersonaViews";
import { FIXTURE_PERSONAS, FIXTURE_PERSONA_DETAILS } from "../../src/gateway/panel/web/app/fixtures";

// The API client uses DOM types (EventSource) the server-side typecheck does not
// load; the web app's own tsconfig checks it. Loaded untyped here on purpose.
const API_MODULE: string = "../../src/gateway/panel/web/app/api";
const { api, ApiError } = (await import(API_MODULE)) as { api: () => any; ApiError: new (s: number, b: unknown) => Error & { status: number } };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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
    const nf = renderToStaticMarkup(<PersonaLoadError error={new ApiError(404, { error: "x" })} name="ghost" />);
    expect(nf).toContain("No persona named ghost");
    const pg = renderToStaticMarkup(<PersonaLoadError error={new ApiError(409, { error: "persona sync requires Postgres" })} />);
    expect(pg).toContain("not available here");
    expect(pg).toContain("persona sync requires Postgres");
    expect(renderToStaticMarkup(<PersonaLoadError error={new Error("network down")} />)).toContain("network down");
  });
});

describe("real backend", () => {
  test("listPersonas and getPersona are GETs on the panel API, the name encoded", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response(JSON.stringify({ revision: "r", personas: [] }), { status: 200 });
    }) as any;
    await api().listPersonas();
    await api().getPersona("a b");
    expect(seen).toEqual(["GET /panel/api/personas", "GET /panel/api/personas/a%20b"]);
  });

  test("a 404 surfaces as an ApiError with its status", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "no persona" }), { status: 404 })) as any;
    const e = await api().getPersona("ghost").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(404);
  });
});
