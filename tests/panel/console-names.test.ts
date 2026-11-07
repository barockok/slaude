/**
 * Console polish: Slack names resolved on the gateway (cached, falling back to
 * the id), the sessions list paged with a model shown for every row, and
 * labels on mandates, audit rows and history mentions.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { createSlackNames, mentionNames, plainChannelRefs, type SlackNameClient } from "../../src/gateway/panel/slack-names";
import { readableMandates } from "../../src/gateway/panel/console-views";
import { sessionModel } from "../../src/gateway/panel/enumerator";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { audit as emitAuditRow } from "../../src/audit";
import type { AuditPageResponse, MandateView, SessionDetailResponse, SessionsResponse } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const cookie = `${AT_COOKIE}=${mintSession({ sub: "s", email: "op@example.com" }, "at", { secret: SECRET })}`;

/** A stub Slack client: channels and users by id, with a call log; `fail` ids throw. */
function stubSlack(o: { channels?: Record<string, Record<string, unknown>>; users?: Record<string, string>; fail?: string[] } = {}) {
  const calls: string[] = [];
  const client: SlackNameClient = {
    conversations: {
      info: async ({ channel }) => {
        calls.push(`conversations.info:${channel}`);
        if (o.fail?.includes(channel)) throw new Error("channel_not_found");
        const ch = o.channels?.[channel];
        return ch ? { ok: true, channel: { id: channel, ...ch } } : { ok: false };
      },
    },
    users: {
      info: async ({ user }) => {
        calls.push(`users.info:${user}`);
        if (o.fail?.includes(user)) throw new Error("user_not_found");
        const name = o.users?.[user];
        return name ? { ok: true, user: { id: user, name: name.toLowerCase(), profile: { display_name: "", real_name: name } } } : { ok: false };
      },
    },
  };
  return { client, calls };
}

describe("createSlackNames", () => {
  it("resolves a channel to #name, caches it, and asks through the context's client", async () => {
    const { client, calls } = stubSlack({ channels: { CTEAM: { name: "team" } } });
    const seen: unknown[] = [];
    const names = createSlackNames({ clientFor: (ctx) => (seen.push(ctx), client) });
    expect(await names.channelLabel("CTEAM", { persona: "scout", appId: "A1" })).toBe("#team");
    expect(await names.channelLabel("CTEAM")).toBe("#team");
    expect(calls).toEqual(["conversations.info:CTEAM"]);
    expect(seen[0]).toEqual({ persona: "scout", appId: "A1" });
  });

  it("a DM reads as `DM with <name>`, or `DM` when the user does not resolve", async () => {
    const { client } = stubSlack({ channels: { DALICE: { is_im: true, user: "UALICE" }, DGHOST: { is_im: true, user: "UGHOST" } }, users: { UALICE: "Jane Doe" } });
    const names = createSlackNames({ clientFor: () => client });
    expect(await names.channelLabel("DALICE")).toBe("DM with Jane Doe");
    expect(await names.channelLabel("DGHOST")).toBe("DM");
  });

  it("failures, timeouts, no client and non-ids answer null; a failure is retried after its shorter TTL", async () => {
    const { client, calls } = stubSlack({ fail: ["CBAD"] });
    let t = 0;
    const names = createSlackNames({ clientFor: () => client, now: () => t, ttlMs: 1_000, failTtlMs: 100 });
    expect(await names.channelLabel("CBAD")).toBeNull();
    expect(await names.channelLabel("CBAD")).toBeNull();
    expect(calls.length).toBe(1);
    t = 150;
    await names.channelLabel("CBAD");
    expect(calls.length).toBe(2);

    expect(await createSlackNames({ clientFor: () => null }).channelLabel("CTEAM")).toBeNull();
    expect(await createSlackNames({ clientFor: () => { throw new Error("no app"); } }).channelLabel("CTEAM")).toBeNull();
    expect(await names.channelLabel("not-an-id")).toBeNull();

    const slow: SlackNameClient = { conversations: { info: () => new Promise(() => undefined) }, users: { info: () => new Promise(() => undefined) } };
    expect(await createSlackNames({ clientFor: () => slow, timeoutMs: 20 }).channelLabel("CSLOW")).toBeNull();
  });

  it("concurrent lookups of one id share one call", async () => {
    const { client, calls } = stubSlack({ channels: { CTEAM: { name: "team" } } });
    const names = createSlackNames({ clientFor: () => client });
    await Promise.all([names.channelLabel("CTEAM"), names.channelLabel("CTEAM"), names.channelLabel("CTEAM")]);
    expect(calls).toEqual(["conversations.info:CTEAM"]);
  });

  it("mentionNames resolves the <@U…> in texts; plainChannelRefs rewrites <#C…>", async () => {
    const { client } = stubSlack({ users: { UALICE: "Jane Doe" } });
    const names = createSlackNames({ clientFor: () => client });
    expect(await mentionNames(names, [{ text: "ask <@UALICE> and <@UNOBODY>" }, { text: "no mentions" }])).toEqual({ UALICE: "Jane Doe" });
    expect(await mentionNames(names, [{ text: "none" }])).toBeUndefined();
    expect(await mentionNames(null, [{ text: "<@UALICE>" }])).toBeUndefined();
    const labels = new Map([["CTEAM", "#team"]]);
    expect(plainChannelRefs("in <#CTEAM> and <#COPS|ops> and <#CX>", labels)).toBe("in #team and #ops and #CX");
  });
});

describe("readableMandates", () => {
  it("titles and triggers show #name when known, else #C123; never a raw token", async () => {
    const { client } = stubSlack({ channels: { CTEAM: { name: "team" } } });
    const names = createSlackNames({ clientFor: () => client });
    const m = (id: string): MandateView => ({
      id: `channel:${id}`, kind: "channel", title: `Mandate in <#${id}>`, instructions: `Work in <#${id}>.`, triggers: [`messages in <#${id}>`],
      approvers: [], source: "soul", channelId: id,
    });
    const [team, ops] = await readableMandates([m("CTEAM"), m("COPS")], "scout", names);
    expect(team).toMatchObject({ title: "Mandate in #team", triggers: ["messages in #team"], instructions: "Work in #team.", channelLabel: "#team" });
    expect(ops).toMatchObject({ title: "Mandate in #COPS", triggers: ["messages in #COPS"] });
    expect(ops!.channelLabel).toBeUndefined();
    // No resolver at all: ids, still without Slack markup.
    const [plain] = await readableMandates([m("CTEAM")], "scout", null);
    expect(plain!.title).toBe("Mandate in #CTEAM");
  });
});

function registryWith(personas: Array<{ name: string; model?: string | null }>): PersonaRegistry {
  const full = personas.map((p) => ({ slackUserId: `U${p.name.toUpperCase()}`, config: { slackUserId: "UX", name: p.name }, outClient: null, ...p }) as unknown as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, runsOn: null }),
  };
}

describe("sessionModel", () => {
  afterEach(() => {
    __resetPersonaRegistry();
    delete process.env.SLAUDE_MODEL;
  });
  it("the row's model, else the agent's, else the deployment default", () => {
    setPersonaRegistry(registryWith([{ name: "scout", model: "agent-model" }, { name: "plain", model: null }]));
    expect(sessionModel({ model: "row-model", persona_id: "scout" })).toEqual({ effective_model: "row-model", model_source: "session" });
    expect(sessionModel({ model: "", persona_id: "scout" })).toEqual({ effective_model: "agent-model", model_source: "agent" });
    process.env.SLAUDE_MODEL = "env-model";
    expect(sessionModel({ model: "", persona_id: "plain" })).toEqual({ effective_model: "env-model", model_source: "deployment" });
    delete process.env.SLAUDE_MODEL;
    expect(sessionModel({ model: "", persona_id: "default" })).toEqual({ effective_model: null, model_source: "deployment" });
  });
});

describe("panel API: sessions pages, names and audit labels", () => {
  beforeEach(async () => {
    process.env.SLAUDE_PANEL_SECRET = SECRET;
    process.env.SLAUDE_PANEL_OPERATORS = "op@example.com";
    __resetRoleCache();
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM audit_events");
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
    __resetRoleCache();
  });

  const get = async <T>(api: ReturnType<typeof createPanelApi>, path: string) => {
    const res = (await api.fetch(new Request(`https://panel.example.com${path}`, { headers: { cookie } })))!;
    return { status: res.status, body: (await res.json()) as T };
  };

  async function seed(n: number, channel = "CTEAM") {
    for (let i = 0; i < n; i++) {
      const s = await Sessions.createForThread({ thread: { team_id: "T1", channel_id: channel, thread_ts: `1762506060.${String(i).padStart(6, "0")}` }, model: "", working_dir: "/tmp/x" });
      await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [1_000_000 + i, s.id]);
    }
  }

  it("pages with offset and limit (default 50), nextOffset null on the last page", async () => {
    await seed(53);
    const api = createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {} });
    const first = await get<SessionsResponse>(api, "/panel/api/sessions");
    expect(first.status).toBe(200);
    expect(first.body.sessions.length).toBe(50);
    expect(first.body.nextOffset).toBe(50);
    const second = await get<SessionsResponse>(api, "/panel/api/sessions?offset=50");
    expect(second.body.sessions.length).toBe(3);
    expect(second.body.nextOffset).toBeNull();
    const ids = new Set([...first.body.sessions, ...second.body.sessions].map((s) => s.id));
    expect(ids.size).toBe(53);
    const small = await get<SessionsResponse>(api, "/panel/api/sessions?limit=10&offset=10");
    expect(small.body.sessions.length).toBe(10);
    expect(small.body.nextOffset).toBe(20);
    expect((await get(api, "/panel/api/sessions?limit=0")).status).toBe(400);
    expect((await get(api, "/panel/api/sessions?offset=-1")).status).toBe(400);
    // An empty row model shows the deployment default.
    expect(first.body.sessions[0]!.model_source).toBe("deployment");
  });

  it("rows, detail and audit carry channel labels from the stub Slack client", async () => {
    await seed(1, "CTEAM");
    await seed(1, "CGONE");
    const { client } = stubSlack({ channels: { CTEAM: { name: "team" } }, fail: ["CGONE"] });
    const names = createSlackNames({ clientFor: () => client });
    const api = createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {}, names });
    const list = await get<SessionsResponse>(api, "/panel/api/sessions");
    const team = list.body.sessions.find((s) => s.slack_channel_id === "CTEAM")!;
    const gone = list.body.sessions.find((s) => s.slack_channel_id === "CGONE")!;
    expect(team.channel_label).toBe("#team");
    expect(gone.channel_label).toBeUndefined();
    const detail = await get<SessionDetailResponse>(api, `/panel/api/sessions/${team.id}`);
    expect(detail.body.channel_label).toBe("#team");
    expect(detail.body.model_source).toBe("deployment");

    await emitAuditRow({ persona: "default", actorKind: "slack_user", actorId: "UALICE", action: "gate.permission.decided", channelId: "CTEAM", targetKind: "channel", targetId: "CTEAM", summary: "x" });
    const page = await get<AuditPageResponse>(api, "/panel/api/audit");
    expect(page.body.items[0]).toMatchObject({ channelLabel: "#team", targetLabel: "#team" });
  });
});
