import { describe, expect, test } from "bun:test";
import { executeToolCall, SERVERS } from "../../src/gateway/api/tools";
import type { JobClaims } from "../../src/gateway/api/auth";
import { mcpMountedTools } from "../../src/tools/contracts/types";
import { wakeAllows, wakeDeniedToolIds } from "../../src/proactive/wake-guard";
import { createVoiceMcp, VOICE_MCP_NAME } from "../../src/agent/voice-mcp";

const claims = { tenant: "default", persona: "default", session: "S1", team: "T1", channel: "U0MANAGER", thread: "wake:A:1", initiator: "A", scope: "turn", runAs: "agent", exp: 0, wake: true, bgRun: "run-1" } as JobClaims;

describe("wakeAllows", () => {
  test("the spec's allowed tools", () => {
    for (const [s, t] of [["surface", "pass"], ["slack", "get_user_profile"], ["slack", "read_canvas"], ["slack", "post_message"], ["runtime", "proactive_post"], ["runtime", "read_channel"], ["runtime", "finish_round"], ["skills", "read_skill"], ["skills", "list_skills"], ["kb", "kb_memoize"]] as const) {
      expect(wakeAllows(s, t)).toBe(true);
    }
  });
  test("the spec's refused tools", () => {
    for (const [s, t] of [["surface", "reply"], ["surface", "request_approval"], ["surface", "edit"], ["surface", "react"], ["surface", "get_history"], ["slack", "reply"], ["slack", "delete"], ["slack", "search_messages"], ["slack", "post_ephemeral"], ["slack", "set_topic"], ["slack", "create_canvas"], ["runtime", "add_cron_job"], ["runtime", "ignore_thread"], ["runtime", "reload_session"], ["runtime", "trigger_ingest"], ["runtime", "proactive_rule"], ["connect", "connect_mcp"], ["skills", "write_skill"], ["skills", "delete_skill"]] as const) {
      expect(wakeAllows(s, t)).toBe(false);
    }
  });
  test("anything unknown is refused, including a prototype name", () => {
    expect(wakeAllows("slack", "some_new_tool")).toBe(false);
    expect(wakeAllows("nope", "x")).toBe(false);
    expect(wakeAllows("constructor", "x")).toBe(false);
  });
});

describe("wakeDeniedToolIds", () => {
  test("hides every tool the voice server mounts", () => {
    const server = createVoiceMcp("s1", {} as never, {} as never);
    const names = Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(names).toContain("voice_start");
    const denied = new Set(wakeDeniedToolIds());
    for (const name of names) expect(denied.has(`mcp__${VOICE_MCP_NAME}__${name}`)).toBe(true);
  });
  test("covers every mounted tool of every server except the allowed ones", () => {
    const denied = new Set(wakeDeniedToolIds());
    for (const [key, { contract }] of Object.entries(SERVERS)) {
      for (const t of mcpMountedTools(contract)) {
        expect(denied.has(`mcp__${contract.server}__${t.name}`)).toBe(!wakeAllows(key, t.name));
      }
    }
  });
});

describe("the /v1 tool plane on a wake's claim", () => {
  test("a refused tool does nothing and says why", async () => {
    const res = await executeToolCall("slack", "delete", { ts: "1.0" }, claims, {} as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isError: boolean; content: { text: string }[] };
    expect(body.isError).toBe(true);
    expect(body.content[0]!.text).toContain("refused: delete");
  });
  test("a permission request is denied at once, without opening a card", async () => {
    let opened = false;
    const deps = { slackCtx: () => ({}), openPermission: async () => { opened = true; return { pendingId: "p" }; } } as never;
    const res = await executeToolCall("runtime", "can_use_tool", { tool_name: "Bash", input: {}, tool_use_id: "t1" }, claims, deps);
    const body = (await res.json()) as { content: { text: string }[] };
    expect(JSON.parse(body.content[0]!.text).decision.behavior).toBe("deny");
    expect(opened).toBe(false);
  });
  test("a normal turn is untouched: the guard does not run without the claim", async () => {
    const { wake: _w, bgRun: _b, ...normal } = claims;
    const res = await executeToolCall("slack", "no_such_tool", {}, normal as JobClaims, {} as never);
    expect(res.status).toBe(404);
  });
});
