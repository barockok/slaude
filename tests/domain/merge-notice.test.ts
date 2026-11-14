import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { __setGrantsReader, invalidateGrants } from "../../src/access/role";
import type { Grant } from "../../src/access/grants";
import { db } from "../../src/db/schema";
import { mergeUsers, type MergeInput } from "../../src/domain/merge";
import { beginNoticeRun, flushMergeNotices, setMergeNoticeSender, sweepPendingNotices, type NoticePost } from "../../src/domain/merge-notice";
import { verifyLinkToken } from "../../src/gateway/portal/link-token";

const TEAM = "T0EXAMPLE";
const slackKey = (value: string) => ({ service: "slack", kind: "user", workspace: TEAM, value });
const mailKey = (value: string) => ({ service: "email", kind: "address", workspace: "", value });
const oidcKey = (subject: string) => ({ service: "oidc", kind: "subject", workspace: "https://idp.example.com", value: subject });

async function person(opts: { slack?: string; slackState?: Domain.State; email?: string; emailState?: Domain.State; oidc?: string } = {}) {
  const u = await Domain.ensureUser({});
  if (opts.slack) await Domain.ensureBinding({ ...slackKey(opts.slack), userId: u.id, state: opts.slackState ?? "observed", source: "test" });
  if (opts.email) await Domain.ensureBinding({ ...mailKey(opts.email), userId: u.id, state: opts.emailState ?? "observed", source: "test" });
  if (opts.oidc) await Domain.ensureBinding({ ...oidcKey(opts.oidc), userId: u.id, state: "verified", source: "test" });
  return u.id;
}
const putGrant = (id: string, subjectId: string, role: string, persona = "scout") =>
  db.run(
    `INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at${db.dialect === "pg" ? ", tenant_id" : ""})
     VALUES (?, ?, 'user', ?, ?, ${db.dialect === "pg" ? "FALSE, FALSE" : "0, 0"}, 'UOP', 1${db.dialect === "pg" ? ", 'default'" : ""})`,
    [id, persona, subjectId, role],
  );
const noticeState = async (mergeId: string) => (await db.one<{ notice_state: string }>("SELECT notice_state FROM user_merges WHERE id = ?", [mergeId]))!.notice_state;

interface Sent { channel: string; app?: { apiAppId?: string; teamId?: string }; text: string }
let sent: Sent[];
let failWith: Error | null;
const post: NoticePost = {
  post: async (m) => {
    sent.push({ channel: m.channel, app: m.app, text: m.text });
    if (failWith) throw failWith;
  },
  apps: async () => [{ apiAppId: "A0EXAMPLE", teamId: TEAM }],
};

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_MERGE_NOTICE", "SLAUDE_ROLE", "SLAUDE_PORTAL", "SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_PUBLIC_URL"];
beforeEach(async () => {
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
  for (const k of ENV) saved[k] = process.env[k];
  await db.run("DELETE FROM agent_grants");
  await db.run("DELETE FROM audit_events");
  await Domain._wipeForTests();
  sent = [];
  failWith = null;
  setMergeNoticeSender(post);
  __setGrantsReader(async (persona) => (persona === "scout" ? ([{ subjectKind: "user", subjectId: "U0BOSS", role: "manager", deny: false, dmOnly: false, source: "console" } as unknown as Grant]) : []));
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_ACCESS_SOURCE;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  setMergeNoticeSender(null);
  __setGrantsReader(null);
  invalidateGrants();
  spyOn(console, "log").mockRestore();
  spyOn(console, "warn").mockRestore();
});

/** A proof merge: the survivor holds a verified Slack binding, the loser an observed email that the proof raises. */
async function proofMerge(over: { slackState?: Domain.State } = {}) {
  const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: over.slackState ?? "verified" });
  const l = await person({ email: "boss@example.com", slack: "U0LOSE" });
  await putGrant("g-member", "email:boss@example.com", "member");
  await putGrant("g-manager", "email:boss@example.com", "manager");
  const held = (await Domain.findBinding(mailKey("boss@example.com")))!;
  const i: MergeInput = { survivorId: s, loserId: l, kind: "proof", actor: "system", raise: { bindingId: held.id } };
  const out = await mergeUsers(i);
  if (out.status !== "merged") throw new Error(`merge ${out.status}`);
  await flushMergeNotices();
  return out;
}

describe("the merge notice", () => {
  test("one DM to the person with the masked email and the counts, one to the persona's manager, state sent", async () => {
    const out = await proofMerge();
    expect(sent.map((x) => x.channel).sort()).toEqual(["U0BOSS", "U0SURV"]);
    const person = sent.find((x) => x.channel === "U0SURV")!;
    expect(person.app).toEqual({ apiAppId: "A0EXAMPLE", teamId: TEAM });
    expect(person.text).toContain("b***@example.com");
    expect(person.text).toContain("2 grants");
    expect(person.text).toContain("scout");
    const manager = sent.find((x) => x.channel === "U0BOSS")!;
    expect(manager.text).toContain("scout");
    expect(manager.text).toContain("manager");
    expect(await noticeState(out.merge.id)).toBe("sent");
    expect((await db.one<{ action: string }>("SELECT action FROM audit_events WHERE action = 'user.merge_notice'"))?.action).toBe("user.merge_notice");
  });

  test("no unmasked email and no Slack id of another person in any text", async () => {
    await proofMerge();
    for (const m of sent) {
      expect(m.text).not.toContain("boss@example.com");
      expect(m.text).not.toContain("U0LOSE");
      expect(m.text).not.toContain("U0SURV");
      if (m.channel !== "U0BOSS") expect(m.text).not.toContain("U0BOSS");
    }
  });

  test("a privileged grant that stays inactive is named with the reason and a fresh portal link for the unverified binding", async () => {
    process.env.SLAUDE_PORTAL = "1";
    process.env.SLAUDE_PANEL_SECRET = "s".repeat(32);
    process.env.SLAUDE_PANEL_PUBLIC_URL = "https://panel.example.com";
    await proofMerge({ slackState: "observed" });
    expect(sent.map((x) => x.channel)).toEqual(["U0SURV"]); // nothing privileged activated: no manager DM
    const t = sent[0]!.text;
    expect(t).toMatch(/stays? inactive/);
    expect(t).toContain("scout");
    expect(t).toContain("not verified");
    const url = /https:\/\/panel\.example\.com\/portal\/link\?t=([A-Za-z0-9._-]+)/.exec(t);
    expect(url).not.toBeNull();
    const claims = verifyLinkToken(url![1]);
    expect(claims.ok && claims.claims.slackUser).toBe("U0SURV");
    expect(claims.ok && claims.claims.team).toBe(TEAM);
  });

  test("a verified Slack binding gets no link", async () => {
    process.env.SLAUDE_PORTAL = "1";
    process.env.SLAUDE_PANEL_SECRET = "s".repeat(32);
    process.env.SLAUDE_PANEL_PUBLIC_URL = "https://panel.example.com";
    await proofMerge();
    expect(sent.find((x) => x.channel === "U0SURV")!.text).not.toContain("/portal/link");
  });

  test("sent once per merge: a second queue does not send again", async () => {
    const out = await proofMerge();
    const n = sent.length;
    const { queueMergeNotice } = await import("../../src/domain/merge-notice");
    queueMergeNotice(out.merge.id);
    await flushMergeNotices();
    expect(sent.length).toBe(n);
  });

  test("a failed send keeps the merge, marks the notice failed, and is not retried", async () => {
    failWith = new Error("channel_not_found");
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE" });
    const out = await mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" });
    await flushMergeNotices();
    if (out.status !== "merged") throw new Error("not merged");
    expect(await noticeState(out.merge.id)).toBe("failed");
    expect(sent.length).toBe(1);
    expect(await Domain.getUser(l)).toBeNull();
    expect((await db.one<{ state: string }>("SELECT state FROM user_merges WHERE id = ?", [out.merge.id]))!.state).toBe("applied");
    await flushMergeNotices();
    expect(sent.length).toBe(1);
  });

  test("a manager failure marks the notice failed even though the person was told", async () => {
    let n = 0;
    setMergeNoticeSender({ ...post, post: async (m) => { sent.push({ channel: m.channel, text: m.text }); if (++n === 2) throw new Error("boom"); } });
    const out = await proofMerge();
    expect(sent.length).toBe(2);
    expect(await noticeState(out.merge.id)).toBe("failed");
  });

  test("SLAUDE_MERGE_NOTICE=off sends nothing and marks the notice skipped", async () => {
    process.env.SLAUDE_MERGE_NOTICE = "off";
    const out = await proofMerge();
    expect(sent).toEqual([]);
    expect(await noticeState(out.merge.id)).toBe("skipped");
  });

  test("a node never sends and never touches the database", async () => {
    process.env.SLAUDE_ROLE = "node";
    const { queueMergeNotice } = await import("../../src/domain/merge-notice");
    queueMergeNotice("any-merge");
    await flushMergeNotices();
    expect(sent).toEqual([]);
  });

  test("no sender registered (a CLI process): the notice is skipped with the reason no sender", async () => {
    setMergeNoticeSender(null);
    const out = await proofMerge();
    expect(await noticeState(out.merge.id)).toBe("skipped");
    const ev = await db.one<{ details: unknown }>("SELECT details FROM audit_events WHERE action = 'user.merge_notice'");
    expect(JSON.stringify(ev!.details)).toContain("no sender");
  });

  test("a notice still pending after ten minutes is swept to failed, a fresh one is left", async () => {
    setMergeNoticeSender(null);
    process.env.SLAUDE_MERGE_NOTICE = "off";
    const out = await proofMerge();
    await db.run("UPDATE user_merges SET notice_state = 'pending', created_at = ? WHERE id = ?", [Date.now() - 11 * 60_000, out.merge.id]);
    expect(await sweepPendingNotices()).toBe(1);
    expect(await noticeState(out.merge.id)).toBe("failed");
    await db.run("UPDATE user_merges SET notice_state = 'pending', created_at = ? WHERE id = ?", [Date.now() - 60_000, out.merge.id]);
    expect(await sweepPendingNotices()).toBe(0);
  });

  test("no text carries an emoji shortcode", async () => {
    await proofMerge();
    for (const m of sent) expect(m.text).not.toMatch(/:[a-z0-9_+-]{2,}:/);
  });

  test("under shadow the person is told the accounts are linked and access is unchanged, and no manager is told", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "shadow";
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0BOSS" });
    await putGrant("g-mgr", "U0BOSS", "manager");
    const out = await mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" });
    await flushMergeNotices();
    if (out.status !== "merged") throw new Error("not merged");
    expect(sent.map((x) => x.channel)).toEqual(["U0SURV"]);
    expect(sent[0]!.text).toContain("access is unchanged");
    expect(sent[0]!.text).not.toContain("became active");
    expect(await noticeState(out.merge.id)).toBe("sent");
  });

  test("the first portal link of an existing manager, under internal, tells only the person: nothing newly activated", async () => {
    const s = await person({ oidc: "sub-1" });
    const l = await person({ slack: "U0BOSS" });
    await putGrant("g-mgr", "U0BOSS", "manager");
    const held = (await Domain.findBinding(slackKey("U0BOSS")))!;
    await mergeUsers({ survivorId: s, loserId: l, kind: "proof", actor: "system", raise: { bindingId: held.id }, proof: { slackBindingId: held.id } });
    await flushMergeNotices();
    expect(sent.map((x) => x.channel)).toEqual(["U0BOSS"]);
  });

  test("at most 3 manager DMs per merge; the rest are skipped, and the notice is still sent", async () => {
    __setGrantsReader(async (persona) =>
      persona === "scout"
        ? ["U0M1", "U0M2", "U0M3", "U0M4", "U0M5"].map((id) => ({ subjectKind: "user", subjectId: id, role: "manager", deny: false, dmOnly: false, source: "console" }) as unknown as Grant)
        : [],
    );
    const out = await proofMerge();
    expect(sent.filter((x) => x.channel.startsWith("U0M"))).toHaveLength(3);
    expect(await noticeState(out.merge.id)).toBe("sent");
    const ev = await db.one<{ details: unknown }>("SELECT details FROM audit_events WHERE action = 'user.merge_notice'");
    const d = typeof ev!.details === "string" ? JSON.parse(ev!.details) : (ev!.details as Record<string, unknown>);
    expect(d.managers_skipped).toBe(2);
  });

  test("a reconcile run shares 10 manager DMs across its merges", async () => {
    __setGrantsReader(async (persona) =>
      persona === "scout"
        ? ["U0M1", "U0M2", "U0M3"].map((id) => ({ subjectKind: "user", subjectId: id, role: "manager", deny: false, dmOnly: false, source: "console" }) as unknown as Grant)
        : [],
    );
    const end = beginNoticeRun(4);
    await proofMerge();
    await Domain._wipeForTests();
    await db.run("DELETE FROM agent_grants");
    await proofMerge();
    await end();
    expect(sent.filter((x) => x.channel.startsWith("U0M"))).toHaveLength(4);
  });

  test("a manager the app cannot reach (another workspace) does not fail the notice", async () => {
    setMergeNoticeSender({ ...post, post: async (m) => { sent.push({ channel: m.channel, text: m.text }); if (m.channel === "U0BOSS") throw Object.assign(new Error("x"), { data: { error: "user_not_found" } }); } });
    const out = await proofMerge();
    expect(await noticeState(out.merge.id)).toBe("sent");
  });

  test("a person with no Slack binding has nobody to tell: skipped", async () => {
    const s = await person({ oidc: "sub-1" });
    const l = await person({ email: "boss@example.com" });
    const out = await mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" });
    await flushMergeNotices();
    if (out.status !== "merged") throw new Error("not merged");
    expect(sent).toEqual([]);
    expect(await noticeState(out.merge.id)).toBe("skipped");
  });

  test("a manager who is the person is not told twice", async () => {
    __setGrantsReader(async (persona) => (persona === "scout" ? ([{ subjectKind: "user", subjectId: "U0SURV", role: "manager", deny: false, dmOnly: false, source: "console" } as unknown as Grant]) : []));
    await proofMerge();
    expect(sent.map((x) => x.channel)).toEqual(["U0SURV"]);
  });

  test("mrkdwn is escaped", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ email: "boss@example.com" });
    await putGrant("g1", "email:boss@example.com", "member", "a<b>&c");
    const held = (await Domain.findBinding(mailKey("boss@example.com")))!;
    await mergeUsers({ survivorId: s, loserId: l, kind: "proof", actor: "system", raise: { bindingId: held.id } });
    await flushMergeNotices();
    expect(sent[0]!.text).toContain("a&lt;b&gt;&amp;c");
  });
});
