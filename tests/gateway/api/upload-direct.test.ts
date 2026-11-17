/**
 * upload_begin / upload_complete on the /v1 tool plane: Slack's presigned
 * upload, split across the gateway (the two Slack calls) and a node (the
 * bytes). Driven through executeToolCall, so Zod validation, the wake
 * allow-list and the metric apply.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensureHome } from "../../../src/config/home";
import { executeToolCall } from "../../../src/gateway/api/tools";
import { bindingFor } from "../../../src/gateway/core/gateway";
import { SlackSurface } from "../../../src/gateway/slack/surface";
import { mintJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { mintUploadHandle } from "../../../src/gateway/upload/handle";
import { localUploadLimiter, __setUploadLimiter } from "../../../src/gateway/upload/limiter";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, refreshGuardrails } from "../../../src/guardrails/snapshot";
import { __resetHeldDecisionsForTests, setOutboundApprover } from "../../../src/gateway/slack/outbound";
import { metrics } from "../../../src/metrics";
import { suppressibleSurface } from "../../../src/gateway/panel/suppress";
import { flushAudits } from "../../../src/audit/emit";
import { db } from "../../../src/db/schema";
import { ensureGuardrailKeyForPg } from "../../guardrails/helpers";

ensureGuardrailKeyForPg();
const SECRET = "upload-direct-secret";

let held = false;
const calls: Array<{ name: string; args: any }> = [];
const client: any = {
  chat: { postMessage: async () => ({ ts: "1.1" }), update: async () => ({}) },
  files: {
    getUploadURLExternal: async (a: any) => {
      calls.push({ name: "begin", args: a });
      return { ok: true, upload_url: "https://upload.invalid/SECRET-URL", file_id: "F123" };
    },
    completeUploadExternal: async (a: any) => {
      calls.push({ name: "complete", args: a });
      return { ok: true, files: [{ id: a.files[0].id }] };
    },
  },
};

const deps: any = {
  slackCtx: (claims: JobClaims) => ({
    client, channel: claims.channel, threadTs: claims.thread, inboundTs: claims.thread, userId: claims.initiator,
    teamId: claims.team, sessionId: claims.session, personaId: undefined, apiAppId: claims.app,
    ...(claims.post === "channel" ? { postTarget: "channel" as const } : {}),
    ...(claims.wake ? { unattended: true } : {}),
    ...(typeof claims.exp === "number" ? { turnDeadline: claims.exp * 1000 - 30_000 } : {}),
  }),
  surfaceFor: (ctx: any) => suppressibleSurface(new SlackSurface(client, bindingFor(ctx)), ctx.sessionId, async () => held),
  surfaceOpts: () => ({}),
};

const claimsFor = (over: Partial<JobClaims> = {}): JobClaims => ({
  tenant: "default", persona: "default", session: "S-up", team: "T1", channel: "C1", thread: "1.0",
  initiator: "U1", scope: "turn", exp: Math.floor(Date.now() / 1000) + 900, ...over,
});

async function call(tool: string, body: unknown, claims = claimsFor()) {
  const res = await executeToolCall("surface", tool, body, claims, deps);
  const json: any = await res.json();
  return { status: res.status, json, text: json?.content?.[0]?.text as string | undefined };
}
async function begin(body: any = { filename: "report.csv", size: 12 }, claims = claimsFor()) {
  const r = await call("upload_begin", body, claims);
  return { ...r, data: r.json.isError || r.status !== 200 ? undefined : JSON.parse(r.text!) };
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["SLAUDE_JOB_SECRET", "SLAUDE_UPLOAD_MAX_BYTES", "SLAUDE_BRAIN_DISABLED"]) saved[k] = process.env[k];
  process.env.SLAUDE_JOB_SECRET = SECRET;
  saved.SLAUDE_UPLOAD_ALLOWED_HOSTS = process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS;
  process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS = "upload.invalid";
  process.env.SLAUDE_BRAIN_DISABLED = "1";
  ensureHome();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  setOutboundApprover(undefined);
});
beforeEach(() => {
  held = false;
  calls.length = 0;
  __setUploadLimiter(localUploadLimiter());
  delete process.env.SLAUDE_UPLOAD_MAX_BYTES;
});
afterEach(() => __setUploadLimiter(undefined));

describe("upload_begin", () => {
  test("returns Slack's URL, the file id and a handle, calling getUploadURLExternal with the declared length", async () => {
    const r = await begin({ filename: "report.csv", size: 12, alt_text: "alt" });
    expect(r.data).toMatchObject({ uploadUrl: "https://upload.invalid/SECRET-URL", fileId: "F123" });
    expect(typeof r.data.handle).toBe("string");
    expect(calls).toEqual([{ name: "begin", args: { filename: "report.csv", length: 12, alt_text: "alt" } }]);
  });

  test("the file name is reduced to a safe base name", async () => {
    await begin({ filename: "../../etc/pass\u0000wd\u0007", size: 1 });
    await begin({ filename: "a".repeat(400) + ".png", size: 1 });
    await begin({ filename: "dir\\sub/ok.txt", size: 1 });
    expect(calls[0]!.args.filename).toBe("passwd");
    expect(calls[1]!.args.filename.length).toBeLessThanOrEqual(255);
    expect(calls[1]!.args.filename.endsWith(".png")).toBe(true);
    expect(calls[2]!.args.filename).toBe("ok.txt");
  });

  test("a lone surrogate in a name is replaced, so the name is well-formed", async () => {
    await begin({ filename: "a\ud800b.txt", size: 1 });
    expect(calls[0]!.args.filename).toBe("a\ufffdb.txt");
    expect(calls[0]!.args.filename.isWellFormed()).toBe(true);
  });

  test("a name with nothing left after cleaning falls back to a fixed name", async () => {
    await begin({ filename: "..", size: 1 });
    expect(calls[0]!.args.filename).toBe("file");
  });

  test("a file over SLAUDE_UPLOAD_MAX_BYTES is refused before Slack is called", async () => {
    process.env.SLAUDE_UPLOAD_MAX_BYTES = "100";
    const ok = await begin({ filename: "a", size: 100 });
    expect(ok.data).toBeDefined();
    calls.length = 0;
    const r = await begin({ filename: "a", size: 101 });
    expect(r.json.isError).toBe(true);
    expect(r.text).toContain("101 bytes");
    expect(r.text).toContain("100 bytes");
    expect(calls).toHaveLength(0);
  });

  test("the default cap is Slack's one gigabyte", async () => {
    expect((await begin({ filename: "a", size: 1_073_741_824 })).data).toBeDefined();
    expect((await begin({ filename: "a", size: 1_073_741_825 })).json.isError).toBe(true);
  });

  test("invalid input is a 400 (zero size, a fraction, unknown keys)", async () => {
    for (const body of [{ filename: "a", size: 0 }, { filename: "a", size: 1.5 }, { filename: "a", size: 1, path: "/x" }, { size: 1 }]) {
      expect((await call("upload_begin", body)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("ten begins a minute per session; the eleventh is refused, another session is not", async () => {
    for (let i = 0; i < 10; i++) expect((await begin()).data).toBeDefined();
    const r = await begin();
    expect(r.json.isError).toBe(true);
    expect(r.text).toContain("10 uploads per minute");
    expect((await begin(undefined, claimsFor({ session: "S-other" }))).data).toBeDefined();
  });

  test("a wake cannot call begin or complete (the allow-list is default-deny)", async () => {
    const wake = claimsFor({ wake: true, bgRun: "run1" });
    for (const tool of ["upload_begin", "upload_complete"]) {
      const r = await call(tool, tool === "upload_begin" ? { filename: "a", size: 1 } : { handle: "x" }, wake);
      expect(r.json.isError).toBe(true);
      expect(r.text).toContain("not available when you woke");
    }
    expect(calls).toHaveLength(0);
  });

  test("an upload URL on another host is begin_failed, and nothing is handed to the node", async () => {
    const orig = client.files.getUploadURLExternal;
    client.files.getUploadURLExternal = async () => ({ ok: true, upload_url: "https://evilslack.com/SECRET-URL", file_id: "F9" });
    try {
      const r = await begin();
      expect(r.json.isError).toBe(true);
      expect(r.text).not.toContain("evilslack");
      expect(r.text).not.toContain("SECRET-URL");
    } finally {
      client.files.getUploadURLExternal = orig;
    }
    expect(metrics.render()).toMatch(/slaude_upload_total\{[^}]*result="begin_failed"/);
  });

  test("a Slack failure is a tool error and never carries the URL", async () => {
    const orig = client.files.getUploadURLExternal;
    client.files.getUploadURLExternal = async () => { throw new Error("An API error occurred: not_allowed_token_type"); };
    try {
      const r = await begin();
      expect(r.json.isError).toBe(true);
      expect(r.text).toContain("not_allowed_token_type");
    } finally {
      client.files.getUploadURLExternal = orig;
    }
  });

  test("counts slaude_upload_total by result", async () => {
    await begin();
    process.env.SLAUDE_UPLOAD_MAX_BYTES = "1";
    await begin({ filename: "a", size: 2 });
    const out = metrics.render();
    expect(out).toMatch(/slaude_upload_total\{[^}]*result="begun"[^}]*\} \d+/);
    expect(out).toMatch(/slaude_upload_total\{[^}]*result="too_large"[^}]*\} \d+/);
  });
});

describe("upload_complete", () => {
  test("finishes into the channel and thread signed into the handle, and returns ok and the file id", async () => {
    const b = await begin();
    calls.length = 0;
    const r = await call("upload_complete", { handle: b.data.handle, title: "Q2" });
    expect(JSON.parse(r.text!)).toEqual({ ok: true, file_id: "F123" });
    expect(calls).toEqual([{ name: "complete", args: { files: [{ id: "F123", title: "Q2" }], channel_id: "C1", thread_ts: "1.0" } }]);
  });

  test("the longest alt text and a 255-character multibyte name still complete (the handle stays small)", async () => {
    const name = "\u65e5".repeat(251) + ".png";
    const b = await begin({ filename: name, size: 5, alt_text: "a".repeat(4000) });
    expect(b.data).toBeDefined();
    expect(b.data.handle.length).toBeLessThan(4096);
    const r = await call("upload_complete", { handle: b.data.handle });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text!).ok).toBe(true);
  });

  test("the title defaults to the cleaned file name", async () => {
    const b = await begin({ filename: "x/y.txt", size: 3 });
    calls.length = 0;
    await call("upload_complete", { handle: b.data.handle });
    expect(calls[0]!.args.files[0].title).toBe("y.txt");
  });

  test("a channel-session root turn posts at the channel root (post is carried by the handle)", async () => {
    const b = await begin(undefined, claimsFor({ thread: "5.5", post: "channel" }));
    calls.length = 0;
    // The caller's claims at complete no longer say so: the handle does.
    await call("upload_complete", { handle: b.data.handle }, claimsFor({ thread: "9.9" }));
    expect(calls[0]!.args.channel_id).toBe("C1");
    expect(calls[0]!.args).not.toHaveProperty("thread_ts");
  });

  test("the destination is the handle's, not the caller's current claims or the body", async () => {
    const b = await begin(undefined, claimsFor({ channel: "C-begin", thread: "7.7" }));
    calls.length = 0;
    await call("upload_complete", { handle: b.data.handle }, claimsFor({ channel: "C-other", thread: "8.8" }));
    expect(calls[0]!.args).toMatchObject({ channel_id: "C-begin", thread_ts: "7.7" });
    expect((await call("upload_complete", { handle: b.data.handle, channel: "C-evil" })).status).toBe(400);
  });

  test("a handle from another session is refused", async () => {
    const b = await begin(undefined, claimsFor({ session: "S-a" }));
    calls.length = 0;
    const r = await call("upload_complete", { handle: b.data.handle }, claimsFor({ session: "S-b" }));
    expect(r.json.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("an expired, tampered, forged-type or job-token handle is refused", async () => {
    const claims = claimsFor();
    const old = mintUploadHandle({ tenant: "default", persona: "default", session: "S-up", team: "T1", channel: "C1", thread: "1.0", fileId: "F1", filename: "a", size: 1 }, { now: Date.now() - 11 * 60_000 });
    const tampered = (await begin()).data.handle.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
    const jobToken = mintJobToken(claims);
    for (const handle of [old, tampered, jobToken, "garbage"]) {
      const r = await call("upload_complete", { handle }, claims);
      expect(r.json.isError).toBe(true);
      expect(r.text).toContain("upload handle");
    }
    expect(calls.filter((c) => c.name === "complete")).toHaveLength(0);
  });

  test("a begin shortly before the job token expires still completes with a refreshed token", async () => {
    const soon = claimsFor({ exp: Math.floor(Date.now() / 1000) + 5 });
    const b = await begin(undefined, soon);
    const refreshed = claimsFor({ exp: Math.floor(Date.now() / 1000) + 900, iat0: Math.floor(Date.now() / 1000) });
    const r = await call("upload_complete", { handle: b.data.handle }, refreshed);
    expect(JSON.parse(r.text!).ok).toBe(true);
  });

  test("a Slack failure at complete is a tool error", async () => {
    const orig = client.files.completeUploadExternal;
    client.files.completeUploadExternal = async () => { throw new Error("An API error occurred: channel_not_found"); };
    try {
      const b = await begin();
      const r = await call("upload_complete", { handle: b.data.handle });
      expect(r.json.isError).toBe(true);
      expect(r.text).toContain("channel_not_found");
    } finally {
      client.files.completeUploadExternal = orig;
    }
  });

  test("the audit event surface.upload records channel, declared size and file name, never a path or URL", async () => {
    const b = await begin({ filename: "r.csv", size: 77 });
    await call("upload_complete", { handle: b.data.handle });
    await flushAudits();
    const rows = await db.query<{ action: string; channel_id: string | null; details: string | Record<string, unknown>; summary: string }>(
      `SELECT action, channel_id, details, summary FROM audit_events WHERE action = ?`, ["surface.upload"],
    );
    const row = rows.at(-1)!;
    expect(row.channel_id).toBe("C1");
    const d = typeof row.details === "string" ? JSON.parse(row.details) : row.details; // jsonb on Postgres arrives parsed
    expect(d).toMatchObject({ size: 77, filename: "r.csv", via: "direct" });
    expect(JSON.stringify(row)).not.toContain("upload.invalid");
    expect(JSON.stringify(row)).not.toContain(b.data.handle);
  });
});

describe("a held caption at upload_complete", () => {
  const RULES = [
    "---\nname: replies\n---\n```rules",
    "- id: prices\n  on: reply\n  match: { text: '(?i)price is \\$\\d+' }\n  action: approve\n  message: Prices need an approver.",
    "- id: no-codes\n  on: reply\n  match: { text: 'launch code \\d+' }\n  action: deny\n  message: Launch codes are never posted.",
    "```",
  ].join("\n");
  let answer: (() => Promise<{ approved: boolean; by: string }>) = async () => ({ approved: true, by: "UAPPROVER" });
  const asked: any[] = [];

  beforeAll(async () => {
    await __clearGuardrailsForTests();
    __resetGuardrailSnapshotsForTests();
    await applyGuardrailChange("default", { upsert: [{ slug: "replies", md: RULES, source: "file" }], by: "t" });
    await refreshGuardrails("default");
  });
  afterAll(async () => {
    await __clearGuardrailsForTests();
    __resetGuardrailSnapshotsForTests();
  });
  beforeEach(() => {
    asked.length = 0;
    __resetHeldDecisionsForTests();
    setOutboundApprover({ approvers: async () => ["UAPPROVER"], ask: async (r) => { asked.push(r); return answer(); } });
  });

  test("approved: the file completes with the caption after the card", async () => {
    answer = async () => ({ approved: true, by: "UAPPROVER" });
    const b = await begin();
    calls.length = 0;
    const r = await call("upload_complete", { handle: b.data.handle, initial_comment: "The price is $40" });
    expect(JSON.parse(r.text!).ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.initial_comment).toContain("price is $40");
  });

  test("denied: Slack's upload is never completed and the agent hears why", async () => {
    answer = async () => ({ approved: false, by: "UAPPROVER" });
    const b = await begin();
    calls.length = 0;
    const r = await call("upload_complete", { handle: b.data.handle, initial_comment: "The price is $40" });
    expect(r.json.isError).toBe(true);
    expect(r.text).toContain("Not posted");
    expect(calls).toHaveLength(0);
  });

  test("a denying rule refuses without a card", async () => {
    const b = await begin();
    calls.length = 0;
    const r = await call("upload_complete", { handle: b.data.handle, initial_comment: "the launch code 12" });
    expect(r.json.isError).toBe(true);
    expect(r.text).toContain("Launch codes are never posted.");
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("a session the console holds", () => {
  test("begin is refused with no Slack call and no limiter budget spent", async () => {
    held = true;
    for (let i = 0; i < 12; i++) {
      const r = await begin();
      expect(r.json.isError).toBe(true);
      expect(r.text).toContain("console");
    }
    expect(calls).toHaveLength(0);
    held = false;
    expect((await begin()).data).toBeDefined(); // the ten-a-minute allowance was never spent
  });

  test("a hold that starts between begin and complete: not completed, not audited, counted suppressed, and the agent is told", async () => {
    const b = await begin({ filename: "held-in-between.csv", size: 9 });
    calls.length = 0;
    held = true;
    const r = await call("upload_complete", { handle: b.data.handle });
    expect(r.json.isError).toBe(true);
    expect(r.text).toContain("not sent");
    expect(r.text).toContain("console");
    expect(calls).toHaveLength(0);
    expect(metrics.render()).toMatch(/slaude_upload_total\{[^}]*result="suppressed"[^}]*\} \d+/);
    await flushAudits();
    const rows = await db.query<{ details: string }>(`SELECT details FROM audit_events WHERE action = ?`, ["surface.upload"]);
    expect(rows.some((x) => JSON.stringify(x.details).includes("held-in-between.csv"))).toBe(false);
  });
});
