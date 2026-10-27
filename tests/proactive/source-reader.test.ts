import { describe, expect, test } from "bun:test";
import type { JobClaims } from "../../src/gateway/api/auth";
import { BridgeRefused, NOT_MOUNTED, connectText, reauthText, type CallToolResult, type McpBridge } from "../../src/gateway/core/mcp-bridge";
import type { ExternalMcp } from "../../src/gateway/core/external-mcp";
import { backgroundClaims, createSourceReader, unservedWatches } from "../../src/proactive/source-reader";

const SRC = { server: "mail", readTools: ["search_threads", "get_thread", "archive"] };

/** A bridge that lists three tools and answers every call with `result`. */
function fakeBridge(result: CallToolResult = { content: [{ type: "text", text: "ok" }] }) {
  const calls: Array<{ claims: JobClaims; server: string; name: string; args: unknown }> = [];
  const lists: JobClaims[] = [];
  const bridge: Pick<McpBridge, "list" | "call"> = {
    async list(claims) {
      lists.push(claims);
      return {
        tools: [
          { name: "search_threads", description: "search", inputSchema: { type: "object" } },
          { name: "get_thread", inputSchema: { type: "object" } },
          { name: "send_message", inputSchema: { type: "object" } },
        ],
      };
    },
    async call(claims, server, name, args) {
      calls.push({ claims, server, name, args });
      return result;
    },
  };
  return { bridge, calls, lists };
}

describe("source reader", () => {
  test("only readTools are offered and callable", async () => {
    const { bridge, calls } = fakeBridge();
    const warnings: string[] = [];
    const reader = createSourceReader(bridge, (m) => warnings.push(m));
    const { tools } = await reader.tools("default", SRC);
    expect(tools.map((t) => t.name)).toEqual(["search_threads", "get_thread"]);
    expect(tools[0]).toEqual({ name: "search_threads", description: "search", inputSchema: { type: "object" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("archive");
    // A second listing does not warn again.
    await reader.tools("default", SRC);
    expect(warnings).toHaveLength(1);

    const out = await reader.read("default", "mail", "send_message", { to: "x" });
    expect(out.kind).toBe("error");
    expect(calls).toHaveLength(0);
  });

  test("a source not yet listed for the persona is not callable", async () => {
    const { bridge, calls } = fakeBridge();
    const reader = createSourceReader(bridge, () => {});
    expect((await reader.read("default", "mail", "get_thread", {})).kind).toBe("error");
    await reader.tools("p1", SRC);
    expect((await reader.read("default", "mail", "get_thread", {})).kind).toBe("error");
    expect(calls).toHaveLength(0);
  });

  test("bridge exceptions become outcomes, never rejections", async () => {
    const secret = "xoxb-" + "0000000000-dummyvalue";
    const bridge: Pick<McpBridge, "list" | "call"> = {
      list: async () => {
        throw new BridgeRefused(404, NOT_MOUNTED);
      },
      call: async () => {
        throw new Error(`credential lookup failed: ${secret}`);
      },
    };
    const warnings: string[] = [];
    const reader = createSourceReader(bridge, (m) => warnings.push(m));
    expect(await reader.tools("default", SRC)).toEqual({ tools: [] });
    expect(await reader.tools("default", SRC)).toEqual({ tools: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(NOT_MOUNTED);
    const out = await reader.read("default", "mail", "get_thread", {});
    expect(out.kind).toBe("error");
    expect((out as { text: string }).text).toContain("credential lookup failed");
    expect((out as { text: string }).text).not.toContain(secret);
  });

  test("an unavailable listing offers no tools; a connect or reauth refusal says needs-auth", async () => {
    const listing = (instructions: string): Pick<McpBridge, "list" | "call"> => ({
      list: async () => ({ tools: [], instructions, unavailable: true }),
      call: async () => ({}),
    });
    for (const text of [connectText("mail"), reauthText("mail")]) {
      expect(await createSourceReader(listing(text), () => {}).tools("default", SRC)).toEqual({ tools: [], needsAuth: true });
    }
    expect(await createSourceReader(listing("mail is unavailable right now; try again later"), () => {}).tools("default", SRC)).toEqual({ tools: [] });
  });

  test("reauth text maps to needs-auth", async () => {
    for (const text of [reauthText("mail"), connectText("mail")]) {
      const { bridge } = fakeBridge({ content: [{ type: "text", text }], isError: true });
      const reader = createSourceReader(bridge, () => {});
      await reader.tools("default", SRC);
      expect(await reader.read("default", "mail", "get_thread", { id: "1" })).toEqual({ kind: "needs-auth" });
    }
  });

  test("other errors map to error", async () => {
    const { bridge } = fakeBridge({ content: [{ type: "text", text: "mail is unavailable right now; try again later" }], isError: true });
    const reader = createSourceReader(bridge, () => {});
    await reader.tools("default", SRC);
    const out = await reader.read("default", "mail", "get_thread", {});
    expect(out).toEqual({ kind: "error", text: "mail is unavailable right now; try again later" });
  });

  test("secrets in results are redacted", async () => {
    const secret = "xoxb-" + "0000000000-dummyvalue";
    const { bridge } = fakeBridge({ content: [{ type: "text", text: `token is ${secret} ok` }] });
    const reader = createSourceReader(bridge, () => {});
    await reader.tools("default", SRC);
    const out = await reader.read("default", "mail", "search_threads", { q: "a" });
    expect(out.kind).toBe("ok");
    expect((out as { text: string }).text).not.toContain(secret);
    expect((out as { text: string }).text).toContain("token is");
  });

  test("calls go out as the agent", async () => {
    const { bridge, calls, lists } = fakeBridge();
    const reader = createSourceReader(bridge, () => {});
    await reader.tools("p1", SRC);
    await reader.read("p1", "mail", "get_thread", { id: "1" });
    expect(calls).toHaveLength(1);
    for (const claims of [calls[0]!.claims, lists[0]!]) {
      expect(claims.runAs).toBe("agent");
      expect(claims.lock).toBeNull();
      expect(claims.persona).toBe("p1");
      expect(claims.initiator).toBe("");
    }
    expect(calls[0]!.name).toBe("get_thread");
    expect(calls[0]!.args).toEqual({ id: "1" });
  });

  test("backgroundClaims names no person and no thread", () => {
    expect(backgroundClaims("p1", "a1")).toEqual({
      tenant: "default", persona: "p1", session: "background:a1", team: "", channel: "", thread: "",
      initiator: "", scope: "", runAs: "agent", lock: null, exp: 0,
    });
  });

  test("unservedWatches names watched servers the bridge does not serve", () => {
    const session: ExternalMcp = {
      servers: { mail: { type: "http", url: "https://mcp.example.com" }, cal: { type: "http", url: "https://c.example.com" } } as any,
      privateServices: [],
    };
    const bridged: ExternalMcp = { servers: { cal: session.servers.cal! }, privateServices: [] };
    expect(unservedWatches(["mail", "cal", "missing"], session, bridged)).toEqual(["mail"]);
  });
});
