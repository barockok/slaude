/**
 * Console session detail: earlier turns from the conversation record
 * (GET /panel/api/sessions/:id/history) and the session's activity.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import * as Sessions from "../../src/db/sessions";
import { resetAgentId, setAgentId } from "../../src/knowledge/agent-identity";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { parseUserLine, turnLines } from "../../src/gateway/panel/history";
import type { MemoryBrowser, MemoryTimelineRow } from "../../src/knowledge/memory-browse";
import type { SessionDetailResponse, SessionHistoryResponse } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;

const envelope = (text: string, o: { source?: string; name?: string } = {}) =>
  `<channel source="${o.source ?? "slack"}" channel_id="CCHAN" thread_ts="1.1" inbound_ts="1.2" user_id="UALICE" user_name="${o.name ?? "alice"}" trust="trusted" one_on_one="false" locked_user="">\n` +
  `${text}\n</channel>\n\nReply by calling \`mcp__slaude_surface__reply\`.`;

const turn = (id: number, user: string, assistant: string, createdAt = 1_000 * id): MemoryTimelineRow => ({
  id, date: "2026-11-07", summary: user.slice(0, 200), detail: `<user>${user}</user>\n<assistant>${assistant}</assistant>`, createdAt,
});

function memoryWith(bySource: Record<string, Record<string, MemoryTimelineRow[]>>, seen: string[] = []): MemoryBrowser {
  return {
    stores: async () => [],
    pages: async () => [],
    page: async () => null,
    timeline: async (store, slug) => {
      seen.push(`${store}:${slug}`);
      return bySource[store]?.[slug] ?? [];
    },
  };
}

function registryWith(personas: Array<{ name: string; slackUserId: string }>, managed = true): PersonaRegistry {
  const full = personas.map((p) => ({ config: { slackUserId: p.slackUserId, name: p.name }, outClient: null, ...p }) as unknown as Persona);
  return {
    lookupByUserId: (id) => full.find((p) => p.slackUserId === id) ?? null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => managed,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, runsOn: null }),
  };
}

async function get<T>(api: ReturnType<typeof createPanelApi>, path: string, who = cookie("op@example.com")) {
  const res = (await api.fetch(new Request(`https://panel.example.com${path}`, { headers: { cookie: who } })))!;
  return { status: res.status, body: (await res.json()) as T };
}

let seq = 0;
async function session(persona?: string) {
  seq++;
  return Sessions.createForThread({
    thread: { team_id: "T1", channel_id: "CHIST", thread_ts: `${Date.now()}.${seq}`, ...(persona ? { persona_id: persona } : {}) },
    model: "m",
    working_dir: "/tmp/history",
  });
}

beforeEach(() => {
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_OPERATORS = "op@example.com";
  __resetRoleCache();
  setAgentId("UAGENT");
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
  __resetRoleCache();
  __resetPersonaRegistry();
  resetAgentId();
});

describe("history line parsing", () => {
  it("shows the message and the sender's name, not the envelope or the runtime instructions", () => {
    expect(parseUserLine(envelope("is the deploy done?"))).toEqual({ text: "is the deploy done?", name: "alice" });
    expect(parseUserLine(envelope("hi", { source: "panel", name: "op@example.com" }))).toEqual({ text: "hi", name: "op@example.com (console)" });
    // A record cut at 800 characters has no closing tag.
    expect(parseUserLine(`<channel source="slack" user_name="bob">\nlong message that was cut…`).text).toBe("long message that was cut…");
    expect(parseUserLine("plain text turn")).toEqual({ text: "plain text turn" });
  });

  it("redacts secrets and skips an empty answer", () => {
    const lines = turnLines(turn(1, envelope("my token=abc123secret please"), ""));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.who).toBe("user");
    expect(lines[0]!.text).not.toContain("abc123secret");
  });
});

describe("history line times", () => {
  const withTs = (ts: string) =>
    `<channel source="slack" channel_id="CCHAN" thread_ts="1.1" inbound_ts="${ts}" user_id="UALICE" user_name="alice" trust="trusted">\nhello\n</channel>`;

  it("the user line carries its Slack message time; the agent line the record's write time", () => {
    const [user, agent] = turnLines(turn(7, withTs("1762506060.000100"), "hi", 1_762_506_090_000));
    expect(user!.at).toBe(1_762_506_060_000);
    expect(user!.dateOnly).toBeUndefined();
    expect(agent!.at).toBe(1_762_506_090_000);
    expect(agent!.dateOnly).toBeUndefined();
  });

  it("a user line with no message time (cron, wake, an older row) is date only", () => {
    const [user] = turnLines(turn(8, "<cron id=\"c1\">\nrun it\n</cron>", "done", 5_000));
    expect(user).toMatchObject({ at: 5_000, dateOnly: true });
  });

  it("a row with no write time at all: both lines date only, on the record's day", () => {
    const row = { ...turn(9, withTs("1762506060.000100"), "ok"), createdAt: null };
    const [user, agent] = turnLines(row);
    expect(user!.dateOnly).toBeUndefined();
    expect(agent).toMatchObject({ at: Date.parse("2026-11-07T00:00:00Z"), dateOnly: true });
  });
});

describe("GET /panel/api/sessions/:id/history", () => {
  it("returns the agent's own conversation record, oldest first, paged with a cursor", async () => {
    const row = await session();
    const slug = `conversations/${row.id.toLowerCase()}`;
    const rows = Array.from({ length: 5 }, (_, i) => turn(i + 1, envelope(`question ${i + 1}`), `answer ${i + 1}`));
    const seen: string[] = [];
    const api = createPanelApi({
      registry: null, pubsub: null, panelLock: null, chat: async () => {},
      memory: memoryWith({ "agent-uagent": { [slug]: [...rows].reverse() } }, seen),
    });
    const first = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((i) => `${i.who}:${i.text}`)).toEqual(["user:question 4", "agent:answer 4", "user:question 5", "agent:answer 5"]);
    expect(first.body.items[0]!.name).toBe("alice");
    // The envelope's inbound_ts is not a Slack ts: only the record's write time, as a date.
    expect(first.body.items[0]!.at).toBe(4_000);
    expect(first.body.items[0]!.dateOnly).toBe(true);
    expect(first.body.items[1]!.dateOnly).toBeUndefined();
    expect(first.body.items.map((i) => i.id)).toEqual(["4:user", "4:agent", "5:user", "5:agent"]);
    expect(first.body.nextCursor).toBe("4");
    expect(seen[0]).toBe(`agent-uagent:${slug}`);

    const second = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history?limit=2&cursor=4`);
    expect(second.body.items.map((i) => i.text)).toEqual(["question 2", "answer 2", "question 3", "answer 3"]);
    expect(second.body.nextCursor).toBe("2");
    const last = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history?limit=2&cursor=2`);
    expect(last.body.items.map((i) => i.text)).toEqual(["question 1", "answer 1"]);
    expect(last.body.nextCursor).toBeNull();

    expect((await get(api, `/panel/api/sessions/${row.id}/history?cursor=abc`)).status).toBe(400);
  });

  it("at gbrain's row cap, the oldest page says older turns are not shown", async () => {
    const { MAX_ROWS } = await import("../../src/gateway/panel/history");
    const row = await session();
    const slug = `conversations/${row.id.toLowerCase()}`;
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => turn(i + 1, envelope(`q${i + 1}`), `a${i + 1}`));
    const api = createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {}, memory: memoryWith({ "agent-uagent": { [slug]: rows } }) });
    const newest = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history?limit=10`);
    expect(newest.body.note).toBeUndefined();
    const oldest = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history?limit=10&cursor=11`);
    expect(oldest.body.items[0]!.text).toBe("q1");
    expect(oldest.body.nextCursor).toBeNull();
    expect(oldest.body.note).toContain("older turns are not");
  });

  it("falls back to the legacy agent source for the default persona", async () => {
    const row = await session();
    const slug = `conversations/${row.id.toLowerCase()}`;
    const api = createPanelApi({
      registry: null, pubsub: null, panelLock: null, chat: async () => {},
      memory: memoryWith({ agent: { [slug]: [turn(1, envelope("old"), "older answer")] } }),
    });
    const r = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history`);
    expect(r.body.items.map((i) => i.text)).toEqual(["old", "older answer"]);
  });

  it("reads a named persona's own slice and never a person's slice", async () => {
    setPersonaRegistry(registryWith([{ name: "scout", slackUserId: "USCOUT" }]));
    const row = await session("scout");
    const slug = `conversations/${row.id.toLowerCase()}`;
    const seen: string[] = [];
    const api = createPanelApi({
      registry: null, pubsub: null, panelLock: null, chat: async () => {},
      memory: memoryWith({ "agent-uscout": { [slug]: [turn(1, envelope("q"), "a")] }, "user-ualice": { [slug]: [turn(2, envelope("private"), "x")] } }, seen),
    });
    const r = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history`);
    expect(r.body.items.map((i) => i.text)).toEqual(["q", "a"]);
    expect(seen.every((s) => s.startsWith("agent-uscout:"))).toBe(true);
  });

  it("resolves the slice as the writer does: an unmanaged registry's unknown persona is the process agent; a managed one not live has none", async () => {
    setPersonaRegistry(registryWith([], false));
    const row = await session("ghost");
    const slug = `conversations/${row.id.toLowerCase()}`;
    const seen: string[] = [];
    const api = createPanelApi({
      registry: null, pubsub: null, panelLock: null, chat: async () => {},
      memory: memoryWith({ "agent-uagent": { [slug]: [turn(1, envelope("q"), "a")] } }, seen),
    });
    const r = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history`);
    expect(r.body.items.map((i) => i.text)).toEqual(["q", "a"]);

    setPersonaRegistry(registryWith([], true));
    seen.length = 0;
    const gone = await get<SessionHistoryResponse>(api, `/panel/api/sessions/${row.id}/history`);
    expect(gone.body.items).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("degrades to a note when memory is off, and when the read fails", async () => {
    const row = await session();
    const prev = process.env.SLAUDE_BRAIN_DISABLED;
    process.env.SLAUDE_BRAIN_DISABLED = "1";
    try {
      const off = createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {} });
      const r = await get<SessionHistoryResponse>(off, `/panel/api/sessions/${row.id}/history`);
      expect(r.status).toBe(200);
      expect(r.body.items).toEqual([]);
      expect(r.body.note).toContain("disabled");
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_BRAIN_DISABLED;
      else process.env.SLAUDE_BRAIN_DISABLED = prev;
    }
    const broken = createPanelApi({
      registry: null, pubsub: null, panelLock: null, chat: async () => {},
      memory: { ...memoryWith({}), timeline: async () => { throw new Error("engine closed"); } },
    });
    const r2 = await get<SessionHistoryResponse>(broken, `/panel/api/sessions/${row.id}/history`);
    expect(r2.status).toBe(200);
    expect(r2.body.note).toBeDefined();
  });

  it("needs a signed-in operator, like the session detail", async () => {
    const row = await session();
    const api = createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {}, memory: memoryWith({}) });
    const res = (await api.fetch(new Request(`https://panel.example.com/panel/api/sessions/${row.id}/history`)))!;
    expect(res.status).toBe(401);
    expect((await get(api, `/panel/api/sessions/nope/history`)).status).toBe(404);
  });
});

describe("GET /panel/api/sessions/:id activity", () => {
  it("gateway: a stored running row no node holds is idle; warm with a turn in flight is working", async () => {
    const stale = await session();
    await Sessions.setStatus(stale.id, "running");
    const busy = await session();
    await Sessions.setStatus(busy.id, "running");
    const registry = { lookupMany: async (ids: string[]) => ids.map((id) => (id === busy.id ? { node: "node-a", since: 1, lastBeat: Date.now(), fresh: true } : null)) } as any;
    const pubsub = { recentEventsMany: async (ids: string[]) => ids.map(() => [{ id: "2", event: { type: "toolCall" } }, { id: "1", event: { type: "turnStart" } }]) } as any;
    const api = createPanelApi({ registry, pubsub, panelLock: null, chat: async () => {} });
    const a = (await get<SessionDetailResponse>(api, `/panel/api/sessions/${stale.id}`)).body;
    expect(a.warm).toBe(false);
    expect(a.activity).toBe("idle");
    expect(a.session.status).toBe("running");
    const b = (await get<SessionDetailResponse>(api, `/panel/api/sessions/${busy.id}`)).body;
    expect(b.warm).toBe(true);
    expect(b.turn_in_flight).toBe(true);
    expect(b.activity).toBe("working");
  });

  it("mono: the in-process manager says warm and in flight", async () => {
    const row = await session();
    const api = createPanelApi({
      registry: null, pubsub: null, panelLock: null, chat: async () => {},
      local: { isWarm: () => true, turnInFlight: () => false, count: () => 1 },
    });
    const d = (await get<SessionDetailResponse>(api, `/panel/api/sessions/${row.id}`)).body;
    expect(d.activity).toBe("warm");
    expect(d.turn_in_flight).toBe(false);
  });
});
