// D2.3: Slack `/mcp connect`, `/mcp disconnect` and the Connect cards resolve the
// connectable servers per persona, through the same function the portal uses, so
// a persona-only server is connectable from Slack and the two surfaces list the
// same servers for the same persona.
import { describe, expect, test } from "bun:test";
import { connectableServers, type ExternalMcp } from "../../../src/gateway/core/external-mcp";
import { portalServers } from "../../../src/gateway/portal/integrations";
import type { PersonaRegistry } from "../../../src/persona/registry";

const http = (url: string) => ({ type: "http", url }) as any;
const GLOBAL: ExternalMcp = { servers: { "global-srv": http("https://global.test/mcp") }, privateServices: [] };

const reg = (personas: Record<string, unknown>, defaultMcp: unknown = null): PersonaRegistry => ({
  lookupByUserId: () => null,
  lookupByName: (n) =>
    n in personas
      ? { name: n, slackUserId: "UTESTUSER1", config: { slackUserId: "UTESTUSER1", name: n }, outClient: null, mcp: personas[n], model: null }
      : null,
  list: () =>
    Object.keys(personas).map((n) => ({
      name: n,
      slackUserId: "UTESTUSER1",
      config: { slackUserId: "UTESTUSER1", name: n },
      outClient: null,
      mcp: personas[n],
      model: null,
    })),
  isMultiPersonaMode: () => true,
  isManaged: () => true,
  tombstonedPersonaFor: () => null,
  defaultPersona: () => ({ model: null, mcp: defaultMcp }),
});

const registry = reg(
  {
    ana: { mcpServers: { notion: http("https://notion.test/mcp"), local: { command: "x" } } },
    bob: { mcpServers: { linear: http("https://linear.test/mcp") } },
  },
  null,
);

describe("connectableServers", () => {
  test("a persona-only OAuth server is connectable for that persona, and only that persona", () => {
    expect(Object.keys(connectableServers("ana", GLOBAL, registry))).toEqual(["notion"]);
    expect(Object.keys(connectableServers("bob", GLOBAL, registry))).toEqual(["linear"]);
    // The global file is not what a named persona mounts, so it is not offered.
    expect(connectableServers("ana", GLOBAL, registry)["global-srv"]).toBeUndefined();
  });

  test("the default persona resolves to the global file when it has no mcp of its own", () => {
    expect(Object.keys(connectableServers(undefined, GLOBAL, registry))).toEqual(["global-srv"]);
    expect(Object.keys(connectableServers("default", GLOBAL, registry))).toEqual(["global-srv"]);
  });

  test("/mcp and the portal list the same servers for the same persona", () => {
    const rows = portalServers({ registry, global: GLOBAL });
    for (const persona of ["ana", "bob", "default"]) {
      const slack = Object.keys(connectableServers(persona, GLOBAL, registry)).sort();
      const portal = rows.filter((r) => r.usedBy.includes(persona)).map((r) => r.name).sort();
      expect(slack).toEqual(portal);
    }
  });
});
