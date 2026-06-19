import { describe, expect, test } from "bun:test";
import { connectTools, createConnectMcp, CONNECT_MCP_NAME } from "../src/gateway/slack/mcp-tools";

describe("connect_mcp tool", () => {
  test("passes the server through to deps.connect and wraps the status as text", async () => {
    const seen: string[] = [];
    const def = connectTools({ connect: async (s) => { seen.push(s); return `started ${s}`; } })[0]!;
    expect(def.name).toBe("connect_mcp");
    const r: any = await def.handler({ server: "workbench" }, {} as any);
    expect(seen).toEqual(["workbench"]);
    expect(r.content[0].text).toBe("started workbench");
  });

  test("createConnectMcp mounts under the slaude_connect namespace", () => {
    const s = createConnectMcp({ connect: async () => "ok" });
    expect(CONNECT_MCP_NAME).toBe("slaude_connect");
    expect(s).toBeDefined();
  });
});
