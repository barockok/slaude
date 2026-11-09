import { describe, expect, test } from "bun:test";
import { pluginsView } from "../../src/gateway/panel/plugins-view";
import type { NodePluginsRow } from "../../src/db/node-plugins";
import { STATE_NEEDS_HEADERS, STATE_OFFERABLE, STATE_WRITABLE, type ReportedPlugin } from "../../src/config/plugin-inventory";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";

const plugin = (over: Partial<ReportedPlugin> = {}): ReportedPlugin => ({ name: "toolkit", marketplace: "m", commit: "aaaaaaa", skills: 2, commands: 1, agents: 0, hooks: 0, stdio: [], http: [], ...over });
const row = (nodeId: string, labels: string[], plugins: ReportedPlugin[], reportedAt = 5): NodePluginsRow => ({ nodeId, labels, reportedAt, report: { plugins } });
const view = (rows: NodePluginsRow[], live: string[]) => pluginsView({ rows: async () => rows, live: async () => new Set(live) });

describe("pluginsView", () => {
  test("groups by label, with contents and per-server state", async () => {
    const out = await view(
      [row("n1", ["gpu"], [plugin({ http: [{ name: "web", url: "https://a.test/mcp", state: STATE_OFFERABLE }, { name: "h", url: "https://h.test/mcp", state: STATE_NEEDS_HEADERS }] })])],
      ["n1"],
    );
    expect(out.available).toBe(true);
    expect(out.labels).toHaveLength(1);
    const g = out.labels[0]!;
    expect(g.label).toBe("gpu");
    expect(g.plugins[0]).toMatchObject({ key: "toolkit@m", commits: ["aaaaaaa"], drift: false, skills: 2, commands: 1 });
    expect(g.plugins[0]!.http).toEqual([
      { name: "h", host: "h.test", state: STATE_NEEDS_HEADERS },
      { name: "web", host: "a.test", state: "offered" },
    ]);
  });

  test("flags two live nodes of one label on different commits; an offline node does not count", async () => {
    const out = await view(
      [row("n1", ["gpu"], [plugin({ commit: "1111111" })]), row("n2", ["gpu"], [plugin({ commit: "2222222" })]), row("n3", ["gpu"], [plugin({ commit: "3333333" })])],
      ["n1", "n2"],
    );
    expect(out.labels[0]!.plugins[0]).toMatchObject({ drift: true, commits: ["1111111", "2222222"] });
    const offlineOnly = await view([row("n1", ["gpu"], [plugin({ commit: "1111111" })]), row("n2", ["gpu"], [plugin({ commit: "2222222" })])], ["n1"]);
    expect(offlineOnly.labels[0]!.plugins[0]!.drift).toBe(false);
  });

  test("an offline node shows its last report time", async () => {
    const out = await view([row("n1", ["gpu"], [plugin()], 1234)], []);
    expect(out.labels[0]!.nodes).toEqual([{ id: "n1", live: false, reportedAt: 1234 }]);
  });

  test("a stdio server missing from a node manifest is not mounted on that node", async () => {
    const out = await view(
      [row("n1", ["gpu"], [plugin({ stdio: [{ name: "local", declared: false }] })]), row("n2", ["gpu"], [plugin({ stdio: [{ name: "local", declared: true }] })])],
      ["n1", "n2"],
    );
    expect(out.labels[0]!.plugins[0]!.stdio).toEqual([{ name: "local", notMountedOn: ["n1"] }]);
  });

  test("a URL conflict and a writable plugin are shown", async () => {
    const out = await view(
      [
        row("n1", ["gpu"], [plugin({ http: [{ name: "web", url: "https://a.test/mcp", state: STATE_OFFERABLE }, { name: "soft", url: "https://s.test/mcp", state: STATE_WRITABLE }] })]),
        row("n2", ["gpu"], [plugin({ http: [{ name: "web", url: "https://b.test/mcp", state: STATE_OFFERABLE }] })]),
      ],
      ["n1", "n2"],
    );
    const http = out.labels[0]!.plugins[0]!.http;
    expect(http).toEqual([
      { name: "soft", host: "s.test", state: STATE_WRITABLE },
      { name: "web", host: "a.test", state: "conflict: nodes report different URLs" },
    ]);
  });

  test("an offerable server with no live node is not shown as offered", async () => {
    const out = await view([row("n1", ["gpu"], [plugin({ http: [{ name: "web", url: "https://a.test/mcp", state: STATE_OFFERABLE }] })])], []);
    expect(out.labels[0]!.plugins[0]!.http).toEqual([{ name: "web", host: "a.test", state: "not offered: no live node lists it" }]);
  });

  test("no reports, no labels", async () => {
    expect((await view([], [])).labels).toEqual([]);
  });
});

describe("GET /panel/api/plugins", () => {
  const SECRET = "t".repeat(32);
  const cookie = `${AT_COOKIE}=${mintSession({ sub: "s", email: "alice@example.com" }, "at", { secret: SECRET })}`;
  const saved = { secret: process.env.SLAUDE_PANEL_SECRET, ops: process.env.SLAUDE_PANEL_OPERATORS, role: process.env.SLAUDE_PANEL_SUPERADMINS };

  test("is read-only: GET only, unavailable in mono", async () => {
    process.env.SLAUDE_PANEL_SECRET = SECRET;
    process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
    __resetRoleCache();
    try {
      const panel = createPanelApi({ registry: null, role: "mono", pubsub: null, panelLock: null, chat: async () => {} });
      const req = (method: string) => new Request("https://panel.example.com/panel/api/plugins", { method, headers: { cookie, ...(method !== "GET" ? { "x-panel-csrf": "1" } : {}) } });
      const res = (await panel.fetch(req("GET")))!;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ available: false, labels: [] });
      for (const m of ["POST", "PUT", "DELETE"]) expect((await panel.fetch(req(m)))!.status).toBe(405);
    } finally {
      for (const [k, v] of [["SLAUDE_PANEL_SECRET", saved.secret], ["SLAUDE_PANEL_OPERATORS", saved.ops]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      __resetRoleCache();
    }
  });
});
