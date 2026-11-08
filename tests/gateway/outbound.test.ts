/**
 * The outbound choke point and owner reply rules (design section 4): deny,
 * redact, audit and hold-and-approve on every agent-authored path, streamed
 * edits judged on the whole text, wakes refusing an approve, and formatting
 * unchanged when no owner rule matches.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHome } from "../../src/config/home";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, refreshGuardrails } from "../../src/guardrails/snapshot";
import { deliver, formatOutbound, NOT_POSTED_TEXT, outbound, outboundSync, OutboundRefusal, setOutboundApprover, WAITING_TEXT, type HoldRequest } from "../../src/gateway/slack/outbound";
import { SlackSurface } from "../../src/gateway/slack/surface";
import { surfaceTools } from "../../src/gateway/core/surface-mcp";
import { slackHandlers, type SlackContext } from "../../src/gateway/slack/mcp-tools";
import { sendProactive } from "../../src/proactive/heartbeat";
import { proposalBlocks } from "../../src/background/proposal-cards";
import { SoulDataSchema } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { db } from "../../src/db/schema";
import { flushAudits } from "../../src/audit/emit";
import { ensureGuardrailKeyForPg } from "../guardrails/helpers";

ensureGuardrailKeyForPg();

const RULES = [
  "---\nname: replies\n---\n```rules",
  "- id: no-codes\n  on: reply\n  match: { text: 'launch code \\d+' }\n  action: deny\n  message: Launch codes are never posted.",
  "- id: hide-cards\n  on: reply\n  match: { text: '\\b\\d{4}-\\d{4}-\\d{4}-\\d{4}\\b' }\n  action: redact",
  "- id: prices\n  on: reply\n  match: { text: '(?i)price is \\$\\d+' }\n  action: approve\n  message: Prices need an approver.",
  "- id: watch\n  on: reply\n  match: { text: '(?i)roadmap' }\n  action: audit",
  "```",
].join("\n");

async function install(md = RULES) {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  await applyGuardrailChange("default", { upsert: [{ slug: "replies", md, source: "file" }], by: "t" });
  await refreshGuardrails("default");
}

type Held = HoldRequest;
let held: Held[] = [];
let answer: (r: Held) => Promise<{ approved: boolean; by: string; note?: string }> = async () => ({ approved: true, by: "UAPPROVER" });

beforeAll(() => ensureHome());
beforeEach(async () => {
  held = [];
  answer = async () => ({ approved: true, by: "UAPPROVER" });
  setOutboundApprover(async (r) => {
    held.push(r);
    return answer(r);
  });
  await install();
});
afterAll(async () => {
  setOutboundApprover(undefined);
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});

const opts = (over: Partial<Parameters<typeof outbound>[1]> = {}) => ({ kind: "reply" as const, persona: "default", channel: "C1", thread: { channel: "C1", threadTs: "1.1" }, sessionId: "S-out", ...over });

/** A fake Slack message store: post and edit by ts. */
function fakeSlack() {
  const msgs = new Map<string, string>();
  const log: string[] = [];
  let n = 0;
  const client: any = {
    chat: {
      postMessage: async (a: any) => {
        const ts = `9.${++n}`;
        msgs.set(ts, a.text);
        log.push(`post ${ts} ${a.text}`);
        return { ts, channel: a.channel };
      },
      update: async (a: any) => {
        msgs.set(a.ts, a.text);
        log.push(`edit ${a.ts} ${a.text}`);
        return {};
      },
      postEphemeral: async (a: any) => {
        log.push(`ephemeral ${a.text}`);
        return { message_ts: "e.1" };
      },
    },
    files: { uploadV2: async (a: any) => { log.push(`upload ${a.initial_comment ?? ""}`); return { files: [{ id: "F1" }] }; } },
    conversations: {
      setTopic: async (a: any) => { log.push(`topic ${a.topic}`); return {}; },
      setPurpose: async (a: any) => { log.push(`purpose ${a.purpose}`); return {}; },
      info: async () => ({ channel: { properties: { canvas: { file_id: "CANVAS1" } } } }),
      canvases: { create: async (a: any) => { log.push(`canvas ${a.document_content.markdown}`); return { canvas_id: "CV1" }; } },
    },
    canvases: { edit: async (a: any) => { log.push(`canvas-edit ${a.changes[0].document_content.markdown}`); return {}; } },
  };
  return { client, msgs, log };
}

describe("outbound(): the rules", () => {
  it("no rule matches: exactly the path's own formatting", async () => {
    expect(await outbound("**hi** there", opts())).toEqual({ action: "send", text: formatOutbound("**hi** there", "reply", "default") });
    expect(formatOutbound("**hi**", "reply")).toBe("*hi*");
    expect(formatOutbound("**hi**", "canvas")).toBe("**hi**");
    expect(formatOutbound("token=sk-abcdefghijklmnopqrstuvwxyz1234", "proposal_preview")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
  });

  it("deny: nothing to post, the rule's message", async () => {
    expect(await outbound("the launch code 1234", opts())).toEqual({ action: "deny", message: "Launch codes are never posted." });
  });

  it("redact: every match is [REDACTED], the soul's marker; soul patterns still apply first", async () => {
    setSoulData(SoulDataSchema.parse({ redactPatterns: ["internal-host"] }));
    try {
      const v = await outbound("card 1111-2222-3333-4444 and 5555-6666-7777-8888 on internal-host", opts());
      expect(v).toEqual({ action: "send", text: "card [REDACTED] and [REDACTED] on [REDACTED]" });
    } finally {
      __resetSoulDataMemo();
    }
  });

  it("approve: held with the redactions applied; a wake or no thread is a deny", async () => {
    const v = await outbound("The price is $40 for 1111-2222-3333-4444", opts());
    expect(v).toEqual({ action: "hold", text: "The price is $40 for [REDACTED]", message: "Prices need an approver.", slug: "replies", ruleId: "prices" });
    const wake = await outbound("The price is $40", opts({ unattended: true }));
    expect(wake.action).toBe("deny");
    expect((wake as any).message).toContain("nobody is in this turn to ask");
    expect((await outbound("The price is $40", opts({ thread: null }))).action).toBe("deny");
  });

  it("audit and every firing is recorded without the text", async () => {
    await db.run("DELETE FROM audit_events WHERE action LIKE 'guardrail.reply.%'");
    expect(await outbound("our roadmap says so", opts())).toEqual({ action: "send", text: "our roadmap says so" });
    await outbound("launch code 7 and roadmap", opts({ sessionId: "S-aud" }));
    await outbound("price is $9", opts({ sessionId: "S-held" }));
    await outbound("card 1111-2222-3333-4444", opts({ sessionId: "S-red" }));
    await flushAudits();
    const rows = await db.query<{ action: string; target_id: string; summary: string; details: string }>(`SELECT action, target_id, summary, details FROM audit_events WHERE action LIKE 'guardrail.reply.%' ORDER BY id`);
    expect(rows.map((r) => `${r.action} ${r.target_id}`).sort()).toEqual([
      "guardrail.reply.audited replies#watch",
      "guardrail.reply.audited replies#watch",
      "guardrail.reply.denied replies#no-codes",
      "guardrail.reply.held replies#prices",
      "guardrail.reply.redacted replies#hide-cards",
    ]);
    const all = JSON.stringify(rows);
    for (const t of ["launch code", "roadmap", "$9", "1111"]) expect(all).not.toContain(t);
    expect(rows.every((r) => (typeof r.details === "string" ? JSON.parse(r.details) : r.details).kind === "reply")).toBe(true);
  });

  it("a set that cannot be verified refuses every agent post (fail closed); runtime text still goes", async () => {
    await db.run("UPDATE guardrails SET md = md || ' tampered'");
    __resetGuardrailSnapshotsForTests();
    const bad = await outbound("hello", opts());
    expect(bad.action).toBe("deny");
    expect(outboundSync("hello", { kind: "proposal_preview", channel: null }).action).toBe("deny");
    expect(await outbound("hello", opts({ kind: "runtime" }))).toEqual({ action: "send", text: "hello" });
  });
});

describe("deliver(): hold and approve", () => {
  it("allow: a placeholder, a card to the approvers with the text privately, then the placeholder becomes the reply", async () => {
    const { client, msgs, log } = fakeSlack();
    const io = { post: async (t: string) => String((await client.chat.postMessage({ text: t })).ts), edit: async (ref: string, t: string) => void (await client.chat.update({ ts: ref, text: t })) };
    const r = await deliver("The price is $40", opts(), io);
    expect(r).toEqual({ ok: true, ref: "9.1", note: "held for approval, approved by <@UAPPROVER>" });
    expect(log).toEqual([`post 9.1 ${WAITING_TEXT("replies")}`, "edit 9.1 The price is $40"]);
    expect(msgs.get("9.1")).toBe("The price is $40");
    expect(held[0]).toMatchObject({ channel: "C1", threadTs: "1.1", detail: "The price is $40", sessionId: "S-out", timeoutSeconds: 600 });
    expect(held[0]!.summary).toContain("replies#prices");
    expect(held[0]!.summary).not.toContain("$40");
  });

  it("deny and timeout: the placeholder becomes a refusal note; the tool gets an error", async () => {
    const { client, msgs } = fakeSlack();
    const io = { post: async (t: string) => String((await client.chat.postMessage({ text: t })).ts), edit: async (ref: string, t: string) => void (await client.chat.update({ ts: ref, text: t })) };
    answer = async () => ({ approved: false, by: "UBOSS" });
    expect(await deliver("The price is $40", opts(), io)).toEqual({ ok: false, error: "Prices need an approver. Not posted: denied by <@UBOSS>." });
    expect(msgs.get("9.1")).toBe(NOT_POSTED_TEXT("denied by <@UBOSS>"));
    answer = async () => ({ approved: false, by: "system", note: "timeout-600s" });
    expect(await deliver("The price is $40", opts(), io)).toEqual({ ok: false, error: "Prices need an approver. Not posted: no approver decided in time." });
    expect(msgs.get("9.2")).toBe(NOT_POSTED_TEXT("no approver decided in time"));
    answer = async () => { throw new Error("this agent has no approver to ask"); };
    expect(await deliver("The price is $40", opts(), io)).toEqual({ ok: false, error: "Prices need an approver. Not posted: this agent has no approver to ask." });
    setOutboundApprover(undefined);
    expect((await deliver("The price is $40", opts(), io)).ok).toBe(false);
  });

  it("a path with no message to hold in place posts only after the card", async () => {
    const posted: string[] = [];
    const r = await deliver("The price is $40", opts({ kind: "upload_caption" }), { post: async (t) => void posted.push(t) });
    expect(r.ok).toBe(true);
    expect(posted).toEqual(["The price is $40"]);
    answer = async () => ({ approved: false, by: "UBOSS" });
    expect((await deliver("The price is $40", opts({ kind: "upload_caption" }), { post: async (t) => void posted.push(t) })).ok).toBe(false);
    expect(posted).toHaveLength(1);
  });
});

describe("the surface (mono and node replies)", () => {
  const surface = (client: any, over: Record<string, unknown> = {}) =>
    new SlackSurface(client, { conversationId: "C1", threadRef: "1.1", inboundRef: "1.1", requestApproval: async () => ({ approved: true, by: "U" }), reloadSession: () => true, sessionId: "S-surf", ...over } as any);

  it("reply: deny is the tool's error and nothing is posted; redact is posted redacted; runtime text is never ruled", async () => {
    const { client, log } = fakeSlack();
    const tools = surfaceTools(surface(client));
    const reply = tools.find((t) => t.name === "reply")!;
    const denied = await reply.handler({ text: "launch code 42" });
    expect(denied).toEqual({ content: [{ type: "text", text: "Launch codes are never posted." }], isError: true } as any);
    expect(log).toEqual([]);
    await reply.handler({ text: "card 1111-2222-3333-4444" });
    expect(log).toEqual(["post 9.1 card [REDACTED]"]);
    await surface(client).reply({ text: "launch code 42", runtime: true });
    expect(log[1]).toBe("post 9.2 launch code 42");
  });

  it("reply held and approved: the tool result says so", async () => {
    const { client } = fakeSlack();
    const reply = surfaceTools(surface(client)).find((t) => t.name === "reply")!;
    const r = await reply.handler({ text: "The price is $5" });
    expect(r.content[0]!.text).toBe("posted ref=9.1 (held for approval, approved by <@UAPPROVER>)");
  });

  it("a wake's surface refuses a held reply at once", async () => {
    const { client, log } = fakeSlack();
    await expect(surface(client, { unattended: true }).reply({ text: "The price is $5" })).rejects.toBeInstanceOf(OutboundRefusal);
    expect(log).toEqual([]);
    expect(held).toEqual([]);
  });

  it("streamed edits: each edit is judged on the whole text, so a pattern split across chunks is caught", async () => {
    const { client, msgs } = fakeSlack();
    const s = surface(client);
    const edit = surfaceTools(s).find((t) => t.name === "edit")!;
    const { ref } = await s.reply({ text: "the launch" });
    expect(((await edit.handler({ ref, text: "the launch code" })) as any).isError).toBeUndefined();
    const r = await edit.handler({ ref, text: "the launch code 99" });
    expect(r).toMatchObject({ isError: true, content: [{ text: "Launch codes are never posted." }] });
    expect(msgs.get(ref)).toBe("the launch code");
    // Redaction stays in sync: the whole message is replaced each time.
    await edit.handler({ ref, text: "card 1111-2222-" });
    await edit.handler({ ref, text: "card 1111-2222-3333-4444 ok" });
    expect(msgs.get(ref)).toBe("card [REDACTED] ok");
    // A held edit: the message shows the placeholder, then the approved text.
    const held2 = await edit.handler({ ref, text: "the price is $7" });
    expect(held2.content[0]!.text).toBe("edited (held for approval, approved by <@UAPPROVER>)");
    expect(msgs.get(ref)).toBe("the price is $7");
  });

  it("upload caption goes through the rules", async () => {
    const { client, log } = fakeSlack();
    const dir = mkdtempSync(join(tmpdir(), "outbound-up-"));
    const f = join(dir, "a.txt");
    writeFileSync(f, "x");
    const upload = surfaceTools(surface(client)).find((t) => t.name === "upload")!;
    expect(((await upload.handler({ path: f, initial_comment: "launch code 1" })) as any).isError).toBe(true);
    await upload.handler({ path: f, initial_comment: "card 1111-2222-3333-4444" });
    await upload.handler({ path: f });
    expect(log).toEqual(["upload card [REDACTED]", "upload "]);
  });
});

describe("the legacy slack tools", () => {
  const ctx = (client: any, over: Partial<SlackContext> = {}): SlackContext => ({ client, channel: "C1", threadTs: "1.1", inboundTs: "1.1", sessionId: "S-leg", ...over });

  it("reply, edit, post_message, post_ephemeral, topic, purpose and canvases are ruled", async () => {
    const { client, log } = fakeSlack();
    expect((await slackHandlers.reply(ctx(client), { text: "launch code 5" })).isError).toBe(true);
    expect((await slackHandlers.reply(ctx(client), { text: "hi **there**" })).content[0]!.text).toBe("posted ts=9.1");
    expect((await slackHandlers.edit(ctx(client), { ts: "9.1", text: "launch code 5" })).content[0]!.text).toBe("Launch codes are never posted.");
    expect((await slackHandlers.edit(ctx(client), { ts: "9.1", text: "fine" })).content[0]!.text).toBe("edited");
    expect((await slackHandlers.post_message(ctx(client), { channel: "C2", text: "card 1111-2222-3333-4444" })).content[0]!.text).toBe("posted channel=C2 ts=9.2");
    expect((await slackHandlers.post_message(ctx(client), { channel: "C2", text: "The price is $3", thread_ts: "5.5" })).content[0]!.text).toContain("held for approval");
    expect((await slackHandlers.post_ephemeral(ctx(client), { user: "U1", text: "launch code 1" })).isError).toBe(true);
    expect((await slackHandlers.post_ephemeral(ctx(client), { user: "U1", text: "ok" })).content[0]!.text).toBe("posted ephemeral ts=e.1");
    expect((await slackHandlers.set_topic(ctx(client), { topic: "launch code 3" })).isError).toBe(true);
    expect((await slackHandlers.set_purpose(ctx(client), { purpose: "card 1111-2222-3333-4444" })).content[0]!.text).toBe("purpose set");
    expect((await slackHandlers.create_canvas(ctx(client), { markdown: "launch code 3" })).isError).toBe(true);
    expect((await slackHandlers.create_canvas(ctx(client), { markdown: "**plan**" })).content[0]!.text).toBe("canvas created canvas_id=CV1");
    expect((await slackHandlers.append_canvas(ctx(client), { markdown: "card 1111-2222-3333-4444" })).content[0]!.text).toBe("canvas appended");
    expect(log).toEqual([
      "post 9.1 hi *there*",
      "edit 9.1 fine",
      "post 9.2 card [REDACTED]",
      `post 9.3 ${WAITING_TEXT("replies")}`,
      "edit 9.3 The price is $3",
      "ephemeral ok",
      "purpose card [REDACTED]",
      "canvas **plan**",
      "canvas-edit card [REDACTED]",
    ]);
  });

  it("a wake's legacy post_message refuses an approve", async () => {
    const { client, log } = fakeSlack();
    const r = await slackHandlers.reply(ctx(client, { wake: { runId: "r", deps: {} as any } }), { text: "The price is $3" });
    expect(r.isError).toBe(true);
    expect(log).toEqual([]);
  });
});

describe("proactive posts and proposal previews", () => {
  it("a proactive post is refused by deny and approve (nobody to ask), redacted by redact", async () => {
    const posts: any[] = [];
    const ctx: any = { agentId: "agent-ob", personaId: "default", managerId: "U0MGR", post: async (m: any) => { posts.push(m); return { ts: "p.1", channel: m.channel }; }, call: async () => ({}), now: () => new Date("2026-11-08T10:00:00Z"), timeZone: "UTC", config: () => ({ enabled: true, highest: "act", quietHours: null, dailyCap: 10, cooldownHours: 0, channels: [] }) };
    const a = (text: string) => ({ audience: "manager" as const, topic: "t", text, evidence: "e" });
    const denied = await sendProactive(a("launch code 9"), ctx, { posts: 0 });
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("Launch codes are never posted.") });
    const held2 = await sendProactive(a("the price is $9"), ctx, { posts: 0 });
    expect(held2.ok).toBe(false);
    expect(posts).toEqual([]);
  });

  it("a preview a deny rule matches is hidden; a redact rule redacts it", () => {
    const base: any = { id: "p1", agentId: "agent-x", kind: "lesson-promotion", toKind: "manager", scope: "agent", status: "open", createdAt: 0, expiresAt: 0, toUser: null };
    const hidden = JSON.stringify(proposalBlocks({ ...base, payload: { lesson: "launch code 12" } }));
    expect(hidden).toContain("preview hidden by the owner's guardrails");
    expect(hidden).not.toContain("launch code 12");
    const red = JSON.stringify(proposalBlocks({ ...base, payload: { lesson: "card 1111-2222-3333-4444" } }));
    expect(red).toContain("card [REDACTED]");
    expect(outboundSync("price is $1", { kind: "proposal_preview", channel: null }).action).toBe("deny");
  });

  it("no set loaded yet: a preview goes through unchanged", () => {
    __resetGuardrailSnapshotsForTests();
    expect(outboundSync("launch code 1", { kind: "proposal_preview", channel: null })).toEqual({ action: "send", text: "launch code 1" });
  });
});
