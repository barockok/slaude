import { describe, expect, test } from "bun:test";
import { parseExternalMcp, type ExternalMcp } from "../../src/gateway/core/external-mcp";
import { watchableSources } from "../../src/proactive/sources";

describe("watchable sources", () => {
  test("watchable sources keep only http, non-private servers with readTools", () => {
    const mcp: ExternalMcp = {
      servers: {
        mail: { type: "http", url: "https://mcp.example.com", readTools: ["search_threads", "get_thread"] },
        cli: { command: "x", readTools: ["a"] },
        priv: { type: "http", url: "https://p.example.com", readTools: ["a"] },
        bare: { type: "http", url: "https://b.example.com" },
      } as any,
      privateServices: ["priv"],
    };
    const warnings: string[] = [];
    const out = watchableSources(["mail", "cli", "priv", "bare", "missing", "mail"], mcp, (m) => warnings.push(m));
    expect(out).toEqual([{ server: "mail", readTools: ["search_threads", "get_thread"] }]);
    expect(warnings).toHaveLength(4);
    for (const word of ["stdio", "private", "readTools", "not configured"]) {
      expect(warnings.some((w) => w.includes(word))).toBe(true);
    }
  });

  test("parseExternalMcp keeps readTools on server entries", () => {
    const m = parseExternalMcp({ mcpServers: { mail: { type: "http", url: "u", readTools: ["a"] } } }, {});
    expect((m.servers.mail as any).readTools).toEqual(["a"]);
  });
});
