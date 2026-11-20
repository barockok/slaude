/**
 * MCP OAuth connect, paste-back and loopback: the authorize link and the code never
 * appear in the thread. The link comes by DM with an Enter code button, the code goes
 * into a modal, and the result is a private notice.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../../src/db/schema";
import { paths } from "../../../src/config/home";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __setProactiveSoulSource } from "../../../src/soul/proactive";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { OAUTH_PASTE_ACTION, OAUTH_PASTE_VIEW } from "../../../src/gateway/slack/oauth-paste";
import * as SlackOauthFlows from "../../../src/db/slack-oauth-flows";
import * as PendingGates from "../../../src/db/pending-gates";
import { encodeRemoteOffer } from "../../../src/gateway/core/remote-command";
import { BOT, SENDER, makeGw, nextTs, tick, type Gw } from "./private-harness";

const mcpJsonPath = join(paths.home, ".mcp.json");
const AUTH_URL = "https://idp.example/authorize?client_id=cid&state=STATE1";
const REDIRECT = "http://127.0.0.1:9/cb";

const gatewayOpts = (log: { exchanged: string[] }) => ({
  oauthPrepare: async () => ({ authorizeUrl: AUTH_URL, state: "STATE1", parts: { tokenEndpoint: "https://idp.example/token", redirectUri: REDIRECT, clientId: "cid", verifier: "v", resource: "http://127.0.0.1:1/mcp" } }),
  oauthExchange: async (_p: unknown, code: string) => {
    log.exchanged.push(code);
    return { access_token: "atk", refresh_token: "rtk", expires_in: 3600 } as any;
  },
});

const inThread = (g: Gw, user: string, text: string, thread: string) => ({
  event: { type: "message", channel: "C1", channel_type: "channel", user, team: "T", ts: nextTs(), thread_ts: thread, text },
  client: g.client,
  context: { teamId: "T" },
});

const dms = (g: Gw, user = SENDER) => g.posts.filter((p) => p.channel === user);
const inChannel = (g: Gw) => g.posts.filter((p) => p.channel === "C1");
const buttonOf = (post: any) => (post.blocks as any[]).find((b) => b.type === "actions").elements[0];

describe("private MCP OAuth connect", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of ["SLAUDE_OAUTH_REDIRECT_URL", "SLAUDE_MASTER_KEY"]) saved[k] = process.env[k];
    process.env.SLAUDE_OAUTH_REDIRECT_URL = REDIRECT;
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture({ ...WORLD, trusted: ["C1"] });
    mkdirSync(paths.claudeConfig, { recursive: true });
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { svc: { type: "http", url: "http://127.0.0.1:1/mcp" } } }), "utf8");
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(mcpJsonPath, { force: true });
    __setProactiveSoulSource(null);
    __resetPersonaRegistry();
  });

  const start = async (o: { ephemeralFails?: boolean; failPost?: (a: any) => boolean } = {}) => {
    const log = { exchanged: [] as string[] };
    const g = makeGw({ ...o, gateway: gatewayOpts(log) });
    const thread = nextTs();
    await g.emit("message", inThread(g, SENDER, `<@${BOT}> /mcp connect svc`, thread));
    await tick();
    return { g, log, thread };
  };

  it("the authorize link goes to the person by DM with an Enter code button, never to the thread", async () => {
    const { g } = await start();
    expect(inChannel(g).map((p) => p.text).join("\n")).not.toContain("idp.example");
    const link = dms(g).find((p) => String(p.text).includes("idp.example"));
    expect(link).toBeDefined();
    expect(buttonOf(link).action_id).toBe(OAUTH_PASTE_ACTION);
    expect(String(link.text)).not.toContain("back here in this thread");
  });

  it("Enter code opens a modal for the clicker, and a submitted code finishes the flow privately", async () => {
    const { g, log, thread } = await start();
    const btn = buttonOf(dms(g).find((p) => String(p.text).includes("idp.example")));
    await g.click(OAUTH_PASTE_ACTION, { value: btn.value, user: SENDER });
    expect(g.viewsOpened).toHaveLength(1);
    expect(g.viewsOpened[0].trigger_id).toBe("TRIG");
    expect(g.viewsOpened[0].view.callback_id).toBe(OAUTH_PASTE_VIEW);
    const meta = g.viewsOpened[0].view.private_metadata;
    await g.submit(OAUTH_PASTE_VIEW, { metadata: meta, fields: { oauth_paste: `${REDIRECT}?code=abc&state=STATE1` }, user: SENDER });
    await tick();
    expect(log.exchanged).toEqual(["abc"]);
    expect(inChannel(g).map((p) => p.text).join("\n")).not.toContain("connected");
    expect(g.ephemerals.map((e) => String(e.text)).join("\n")).toContain("`svc` connected");
    expect(g.ephemerals.at(-1).user).toBe(SENDER);
    expect(g.ephemerals.at(-1).thread_ts).toBe(thread);
  });

  it("a button click from anyone else opens nothing", async () => {
    const { g } = await start();
    const btn = buttonOf(dms(g).find((p) => String(p.text).includes("idp.example")));
    await g.click(OAUTH_PASTE_ACTION, { value: btn.value, user: "U0MEMBER" });
    expect(g.viewsOpened).toHaveLength(0);
  });

  it("a submit by someone else does not complete the flow", async () => {
    const { g, log } = await start();
    const btn = buttonOf(dms(g).find((p) => String(p.text).includes("idp.example")));
    await g.click(OAUTH_PASTE_ACTION, { value: btn.value, user: SENDER });
    const meta = g.viewsOpened[0].view.private_metadata;
    await g.submit(OAUTH_PASTE_VIEW, { metadata: meta, fields: { oauth_paste: `${REDIRECT}?code=abc&state=STATE1` }, user: "U0MEMBER" });
    await tick();
    expect(log.exchanged).toEqual([]);
  });

  it("a wrong state is refused privately and leaves the flow parked", async () => {
    const { g, log } = await start();
    const btn = buttonOf(dms(g).find((p) => String(p.text).includes("idp.example")));
    await g.click(OAUTH_PASTE_ACTION, { value: btn.value, user: SENDER });
    const meta = g.viewsOpened[0].view.private_metadata;
    await g.submit(OAUTH_PASTE_VIEW, { metadata: meta, fields: { oauth_paste: `${REDIRECT}?code=abc&state=WRONG` }, user: SENDER });
    await tick();
    expect(log.exchanged).toEqual([]);
    expect(g.ephemerals.map((e) => String(e.text)).join("\n")).toContain("state");
    expect(inChannel(g)).toHaveLength(0);
    await g.submit(OAUTH_PASTE_VIEW, { metadata: meta, fields: { oauth_paste: `${REDIRECT}?code=abc&state=STATE1` }, user: SENDER });
    await tick();
    expect(log.exchanged).toEqual(["abc"]);
  });

  it("a callback pasted into the thread still works, and the person is told privately to use the button", async () => {
    const { g, log, thread } = await start();
    await g.emit("message", inThread(g, SENDER, `${REDIRECT}?code=zzz&state=STATE1`, thread));
    await tick();
    expect(log.exchanged).toEqual(["zzz"]);
    expect(g.ephemerals.map((e) => String(e.text)).join("\n")).toContain("Enter code");
    expect(inChannel(g).map((p) => p.text).join("\n")).not.toContain("connected");
  });

  it("a callback with no parked flow is not sent to the model, and the person is told it has expired", async () => {
    const g = makeGw({ gateway: gatewayOpts({ exchanged: [] }) });
    const thread = nextTs();
    await g.emit("message", inThread(g, SENDER, `<@${BOT}> ${REDIRECT}?code=old&state=GONE`, thread));
    await tick();
    expect(g.sends).toHaveLength(0);
    expect(g.ephemerals.map((e) => String(e.text)).join("\n")).toContain("expired");
  });

  it("the sent link is edited away in the DM once the flow finishes", async () => {
    const { g } = await start();
    const btn = buttonOf(dms(g).find((p) => String(p.text).includes("idp.example")));
    await g.click(OAUTH_PASTE_ACTION, { value: btn.value, user: SENDER });
    await g.submit(OAUTH_PASTE_VIEW, { metadata: g.viewsOpened[0].view.private_metadata, fields: { oauth_paste: `${REDIRECT}?code=abc&state=STATE1` }, user: SENDER });
    await tick();
    const gone = g.updates.find((u) => String(u.text).includes("link removed"));
    expect(gone).toBeDefined();
    expect(gone.channel).toBe(SENDER);
    expect(gone.blocks).toEqual([]);
  });

  it("when the link cannot be delivered privately the flow does not start, and nothing is posted to the thread", async () => {
    const { g, thread } = await start({ failPost: (a) => a.channel === SENDER });
    expect(await SlackOauthFlows.peekFlow(`C1:${thread}:${SENDER}`)).toBeNull();
    expect(inChannel(g)).toHaveLength(0);
    expect(g.posts.map((p) => String(p.text)).join("\n")).not.toContain("idp.example");
  });

  it("with SLAUDE_PRIVATE_NOTICES off the link is posted to the thread as before, and is edited away afterwards", async () => {
    process.env.SLAUDE_PRIVATE_NOTICES = "off";
    try {
      const { g, log, thread } = await start();
      expect(inChannel(g).map((p) => String(p.text)).join("\n")).toContain("idp.example");
      await g.emit("message", inThread(g, SENDER, `${REDIRECT}?code=old&state=STATE1`, thread));
      await tick();
      expect(log.exchanged).toEqual(["old"]);
      expect(g.updates.some((u) => String(u.text).includes("link removed"))).toBe(true);
    } finally {
      delete process.env.SLAUDE_PRIVATE_NOTICES;
    }
  });

  describe("the Enter code form", () => {
    const offerFor = (thread: string, issuedAt = Date.now()) =>
      encodeRemoteOffer({ sessionId: "S", teamId: "T", channelId: "C1", threadTs: thread, userId: SENDER, issuedAt });

    it("an old form says it expired", async () => {
      const g = makeGw({ gateway: gatewayOpts({ exchanged: [] }) });
      await g.submit(OAUTH_PASTE_VIEW, { metadata: offerFor("9.9", Date.now() - 6 * 60 * 60 * 1000), fields: { oauth_paste: "x" }, user: SENDER });
      await tick();
      expect(g.ephemerals.map((e) => String(e.text)).join("\n")).toContain("form expired");
    });

    it("with no connect waiting for a code, it says the authorization expired", async () => {
      const g = makeGw({ gateway: gatewayOpts({ exchanged: [] }) });
      await g.submit(OAUTH_PASTE_VIEW, { metadata: offerFor("9.9"), fields: { oauth_paste: `${REDIRECT}?code=abc&state=S` }, user: SENDER });
      await tick();
      expect(g.ephemerals.map((e) => String(e.text)).join("\n")).toContain("authorization has expired");
    });

    it("text that is not a redirect URL or a code is refused and leaves the flow parked", async () => {
      const { g, log, thread } = await start();
      await g.submit(OAUTH_PASTE_VIEW, { metadata: offerFor(thread), fields: { oauth_paste: "not a code" }, user: SENDER });
      await tick();
      expect(g.ephemerals.map((e) => String(e.text)).join("\n")).toContain("did not look like");
      expect(log.exchanged).toEqual([]);
      expect(await SlackOauthFlows.peekFlow(`C1:${thread}:${SENDER}`)).not.toBeNull();
    });

    it("the button reports a connect that is no longer waiting", async () => {
      const g = makeGw({ gateway: gatewayOpts({ exchanged: [] }) });
      await g.click(OAUTH_PASTE_ACTION, { value: offerFor("9.9"), user: SENDER });
      expect(g.viewsOpened).toHaveLength(0);
      expect(g.responds.map((r) => String(r.text)).join("\n")).toContain("No connect is waiting");
    });
  });

  it("a Connect card for a server that is gone answers the person privately", async () => {
    const g = makeGw({ gateway: gatewayOpts({ exchanged: [] }) });
    const thread = nextTs();
    await PendingGates.create({
      id: "card-gone-1",
      kind: "mcp_connect",
      sessionId: "S-gone",
      payload: { channelId: "C1", threadTs: thread, userId: SENDER, serverName: "gone", scope: "global" },
      expiresAt: Date.now() + 60_000,
    });
    await g.click("slaude_mcp:connect:card-gone-1", { user: SENDER });
    await tick();
    expect(inChannel(g)).toHaveLength(0);
    expect(g.ephemerals.map((e) => String(e.text)).join("\n")).toContain("not available");
  });

  it("in a DM, a link that cannot be posted stops the flow instead of throwing", async () => {
    const log = { exchanged: [] as string[] };
    const g = makeGw({ failPost: (a) => a.channel === "D0OWN" && String(a.text).includes("idp.example"), gateway: gatewayOpts(log) });
    const thread = nextTs();
    await g.emit("message", {
      event: { type: "message", channel: "D0OWN", channel_type: "im", user: SENDER, team: "T", ts: thread, text: "/mcp connect svc" },
      client: g.client,
      context: { teamId: "T" },
    });
    await tick();
    expect(await SlackOauthFlows.peekFlow(`D0OWN:${thread}:${SENDER}`)).toBeNull();
    expect(g.posts.map((p) => String(p.text)).join("\n")).not.toContain("idp.example");
  });

  it("the loopback link is private too", async () => {
    delete process.env.SLAUDE_OAUTH_REDIRECT_URL;
    const g = makeGw({
      gateway: {
        oauthConnect: async ({ postAuthorizeUrl }: any) => {
          await postAuthorizeUrl("https://idp.example/authorize?loopback=1");
          return { access_token: "atk", expires_in: 3600 };
        },
      },
    });
    const thread = nextTs();
    await g.emit("message", inThread(g, SENDER, `<@${BOT}> /mcp connect svc`, thread));
    await tick();
    expect(inChannel(g).map((p) => p.text).join("\n")).not.toContain("idp.example");
    expect(dms(g).map((p) => String(p.text)).join("\n")).toContain("idp.example");
  });
});
