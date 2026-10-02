/**
 * The portal's list of connectable MCP servers is the union of what the agents
 * actually mount: every persona's effective MCP, resolved the same way a session
 * resolves it. A server two personas share is one row, and a connect covers both
 * because the stored credential is keyed by name plus config, not by persona.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../src/config/home";
import { oauthKey } from "../../../src/agent/mcp-oauth/store";
import type { ExternalMcp } from "../../../src/gateway/core/external-mcp";
import type { PersonaRegistry } from "../../../src/persona/registry";
import {
  aggregateServers,
  configuredServer,
  integrationsFor,
  portalServers,
} from "../../../src/gateway/portal/integrations";

const http = (url: string, headers?: Record<string, string>) => ({ type: "http" as const, url, ...(headers ? { headers } : {}) });

describe("aggregateServers", () => {
  test("one server mounted by two personas is one row that names both", () => {
    const out = aggregateServers([
      { persona: "ana", servers: { notion: http("https://notion.test/mcp") } },
      { persona: "bob", servers: { notion: http("https://notion.test/mcp") } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "notion", name: "notion", usedBy: ["ana", "bob"] });
  });

  test("different servers stay separate rows, ordered by name", () => {
    const out = aggregateServers([
      { persona: "ana", servers: { zeta: http("https://z.test/mcp"), alpha: http("https://a.test/mcp") } },
    ]);
    expect(out.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(out.map((s) => s.id)).toEqual(["alpha", "zeta"]);
  });

  test("the same name with different URLs is two rows, each addressed by its credential key", () => {
    const a = http("https://one.test/mcp");
    const b = http("https://two.test/mcp");
    const out = aggregateServers([
      { persona: "ana", servers: { notion: a } },
      { persona: "bob", servers: { notion: b } },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.name)).toEqual(["notion", "notion"]);
    expect(new Set(out.map((s) => s.id))).toEqual(new Set([oauthKey("notion", a), oauthKey("notion", b)]));
    // Never a bare name that two rows would share.
    expect(out.every((s) => s.id !== "notion")).toBe(true);
  });

  test("the same name and URL but different headers are different servers", () => {
    const out = aggregateServers([
      { persona: "ana", servers: { s: http("https://s.test/mcp", { "x-tenant": "a" }) } },
      { persona: "bob", servers: { s: http("https://s.test/mcp", { "x-tenant": "b" }) } },
    ]);
    expect(out).toHaveLength(2);
  });

  test("a persona listed twice is named once", () => {
    const out = aggregateServers([
      { persona: "ana", servers: { s: http("https://s.test/mcp") } },
      { persona: "ana", servers: { s: http("https://s.test/mcp") } },
    ]);
    expect(out[0]!.usedBy).toEqual(["ana"]);
  });

  test("no sources, no rows", () => {
    expect(aggregateServers([])).toEqual([]);
  });
});

describe("configuredServer", () => {
  const rows = aggregateServers([{ persona: "ana", servers: { notion: http("https://n.test/mcp") } }]);

  test("finds a row by id", () => {
    expect(configuredServer("notion", rows)?.cfg.url).toBe("https://n.test/mcp");
  });

  test("an id that is not in the list finds nothing, however it is spelled", () => {
    expect(configuredServer("missing", rows)).toBeNull();
    expect(configuredServer("__proto__", rows)).toBeNull();
    expect(configuredServer("constructor", rows)).toBeNull();
  });
});

describe("integrationsFor", () => {
  test("a row carries what the page needs and never the config's headers or full URL", async () => {
    const rows = aggregateServers([
      { persona: "ana", servers: { notion: http("https://user:pw@notion.test/mcp?token=abc", { authorization: "Bearer SECRET" }) } },
    ]);
    const out = await integrationsFor("no-such-account", rows);
    expect(out).toEqual([
      { id: "notion", name: "notion", host: "notion.test", connected: false, expiresAt: null, usedBy: ["ana"] },
    ]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(JSON.stringify(out)).not.toContain("token=abc");
    expect(JSON.stringify(out)).not.toContain("pw");
  });
});

// --- portalServers: resolved from the persona registry the way a session is ---

const GLOBAL: ExternalMcp = {
  servers: { "global-srv": http("https://global.test/mcp") as any },
  privateServices: [],
};

const reg = (
  managed: boolean,
  personas: Record<string, unknown>,
  defaultMcp: unknown = null,
): PersonaRegistry => ({
  lookupByUserId: () => null,
  lookupByName: (n) =>
    n in personas
      ? { name: n, slackUserId: "UTESTUSER1", config: { slackUserId: "UTESTUSER1", name: n }, outClient: null, ...(managed ? { mcp: personas[n], model: null } : {}) }
      : null,
  list: () =>
    Object.keys(personas).map((n) => ({
      name: n,
      slackUserId: "UTESTUSER1",
      config: { slackUserId: "UTESTUSER1", name: n },
      outClient: null,
      ...(managed ? { mcp: personas[n], model: null } : {}),
    })),
  isMultiPersonaMode: () => true,
  isManaged: () => managed,
  tombstonedPersonaFor: () => null,
  ...(managed ? { defaultPersona: () => ({ model: null, mcp: defaultMcp }) } : {}),
});

function writeDiskMcp(name: string, body: unknown) {
  const dir = join(paths.personas, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(body));
}

afterEach(() => rmSync(paths.personas, { recursive: true, force: true }));

describe("portalServers", () => {
  test("managed: the union of every persona's effective mcp, each row naming its personas", () => {
    const out = portalServers({
      registry: reg(
        true,
        {
          ana: { mcpServers: { notion: http("https://notion.test/mcp"), linear: http("https://linear.test/mcp") } },
          bob: { mcpServers: { notion: http("https://notion.test/mcp") } },
        },
        { mcpServers: { calendar: http("https://cal.test/mcp") } },
      ),
      global: GLOBAL,
    });
    const byName = Object.fromEntries(out.map((s) => [s.name, s.usedBy]));
    expect(byName).toEqual({
      calendar: ["default"],
      linear: ["ana"],
      notion: ["ana", "bob"],
    });
  });

  test("managed: the default persona with no mcp of its own contributes the global .mcp.json", () => {
    const out = portalServers({ registry: reg(true, {}, null), global: GLOBAL });
    expect(out.map((s) => [s.name, s.usedBy])).toEqual([["global-srv", ["default"]]]);
  });

  test("managed: a named persona with no mcp contributes nothing, not the global file and not the disk file", () => {
    writeDiskMcp("ana", { mcpServers: { "disk-srv": http("https://disk.test/mcp") } });
    const out = portalServers({ registry: reg(true, { ana: null }, { mcpServers: {} }), global: GLOBAL });
    expect(out).toEqual([]);
  });

  test("managed: a stdio server is not connectable and is left out", () => {
    const out = portalServers({
      registry: reg(true, { ana: { mcpServers: { local: { command: "run-it", args: [] }, remote: http("https://r.test/mcp") } } }, { mcpServers: {} }),
      global: GLOBAL,
    });
    expect(out.map((s) => s.name)).toEqual(["remote"]);
  });

  test("filesystem registry: each named persona reads its own mcp.json and the default reads the global one", () => {
    writeDiskMcp("ana", { mcpServers: { "ana-srv": http("https://ana.test/mcp") } });
    writeDiskMcp("bob", { mcpServers: { "bob-srv": http("https://bob.test/mcp"), "ana-srv": http("https://ana.test/mcp") } });
    const out = portalServers({ registry: reg(false, { ana: null, bob: null }), global: GLOBAL });
    const byName = Object.fromEntries(out.map((s) => [s.name, s.usedBy]));
    expect(byName).toEqual({
      "ana-srv": ["ana", "bob"],
      "bob-srv": ["bob"],
      "global-srv": ["default"],
    });
  });

  test("no personas at all: just what the default persona mounts", () => {
    const out = portalServers({ registry: reg(false, {}), global: GLOBAL });
    expect(out.map((s) => s.name)).toEqual(["global-srv"]);
  });
});
