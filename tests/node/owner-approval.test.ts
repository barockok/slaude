/**
 * Owner tool approve on nodes (spike, section "Node path"): the node's
 * resolver skips its local policy and asks with force_card and rule_id; the
 * gateway re-evaluates the rule from its own verified set before it opens the
 * card, and records the node's report of how the card ended.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ensureHome } from "../../src/config/home";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests } from "../../src/guardrails/snapshot";
import { makeNodePermissionResolver } from "../../src/node/shims/permission";
import { recordNodeGuardrailEvent, verifyForcedCard } from "../../src/gateway/core/owner-guardrails";
import { executeRuntimeTool } from "../../src/gateway/api/tools/runtime";
import { db } from "../../src/db/schema";
import { flushAudits } from "../../src/audit/emit";
import { wakeRefusal } from "../../src/proactive/wake-guard";
import { ensureGuardrailKeyForPg } from "../guardrails/helpers";

ensureGuardrailKeyForPg();

const APPROVE = "---\nname: deploys\n---\n```rules\n- id: ask\n  on: tool\n  match: { tool: Bash, input: { command: '^deploy' } }\n  action: approve\n  message: Deploys need an approver.\n- id: no-rm\n  on: tool\n  match: { tool: Bash, input: { command: 'rm -rf' } }\n  action: deny\n  message: never\n```";
const SCOPED = "---\nname: elsewhere\nchannels: [C-OTHER]\n---\n```rules\n- id: ask2\n  on: tool\n  match: { tool: Write }\n  action: approve\n```";
const claims = { tenant: "default", persona: "default", channel: "C1", session: "S1", thread: "1.1", job: "J1" };

const savedAuto = process.env.SLAUDE_AUTO_ALLOW_TOOLS;
beforeAll(() => {
  ensureHome();
  process.env.SLAUDE_AUTO_ALLOW_TOOLS = "Bash";
});
afterAll(async () => {
  // Later files in this process see no guardrail set.
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  if (savedAuto === undefined) delete process.env.SLAUDE_AUTO_ALLOW_TOOLS;
  else process.env.SLAUDE_AUTO_ALLOW_TOOLS = savedAuto;
});
beforeEach(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  await applyGuardrailChange("default", { upsert: [{ slug: "deploys", md: APPROVE, source: "file" }, { slug: "elsewhere", md: SCOPED, source: "file" }], by: "t" });
});

describe("the node's resolver", () => {
  const owner = { ruleId: "deploys#ask", message: "Deploys need an approver.", deadline: Date.now() + 120_000 };
  it("an owner approval skips the local auto-allow and asks the gateway with force_card, rule_id and ttl_ms", async () => {
    const sent: any[] = [];
    const client: any = {
      postTool: async (_s: string, _t: string, body: unknown) => {
        sent.push(body);
        return { content: [{ type: "text", text: JSON.stringify({ decision: { behavior: "deny", message: "re-evaluated: no" } }) }] };
      },
    };
    const r = makeNodePermissionResolver({ client, tokenFor: () => "tok" });
    const out = await r("S1", "Bash", { command: "deploy prod" }, { signal: new AbortController().signal, toolUseID: "tu-n1", ownerApproval: owner } as any);
    expect(out).toEqual({ behavior: "deny", message: "re-evaluated: no" });
    expect(sent[0]).toMatchObject({ tool_name: "Bash", tool_use_id: "tu-n1", force_card: true, rule_id: "deploys#ask" });
    expect(sent[0].ttl_ms).toBeGreaterThan(100_000);
    expect(sent[0].ttl_ms).toBeLessThanOrEqual(120_000);
    // Without the marker the same call is the node's auto-allow, never asked.
    expect((await r("S1", "Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu-n2" } as any)).behavior).toBe("allow");
    expect(sent).toHaveLength(1);
  });

  it("an owner approval keeps the local policy's hard denies: never asked", async () => {
    const client: any = { postTool: async () => { throw new Error("must not ask"); } };
    const r = makeNodePermissionResolver({ client, tokenFor: () => "tok" });
    const out = await r("S1", "mcp__mail__authenticate", {}, { signal: new AbortController().signal, toolUseID: "tu-n4", ownerApproval: owner } as any);
    expect(out.behavior).toBe("deny");
  });

  it("a wake is refused before anything, owner approval or not", async () => {
    const client: any = { postTool: async () => { throw new Error("must not ask"); } };
    const r = makeNodePermissionResolver({ client, tokenFor: () => "tok", wakeFor: () => true });
    expect(await r("S1", "Bash", {}, { signal: new AbortController().signal, toolUseID: "tu-n3", ownerApproval: owner } as any)).toEqual({ behavior: "deny", message: wakeRefusal("Bash") });
  });
});

describe("the gateway re-evaluates a forced card", () => {
  it("opens only for the rule its own set says asks for this call", async () => {
    const ok = await verifyForcedCard(claims, { toolName: "Bash", input: { command: "deploy prod" }, ruleId: "deploys#ask", ttlMs: 90_000 });
    expect(ok).toEqual({ ok: true, ruleId: "deploys#ask", message: "Deploys need an approver.", ttlMs: 90_000 });
    // The remote alias counts as its builtin, as on the node.
    expect((await verifyForcedCard(claims, { toolName: "mcp__remote__bash", input: { command: "deploy prod" }, ruleId: "deploys#ask", ttlMs: undefined }, 600)).ok).toBe(true);
    // The ttl is capped by the gateway's own cap.
    expect(await verifyForcedCard(claims, { toolName: "Bash", input: { command: "deploy x" }, ruleId: "deploys#ask", ttlMs: 10_000_000 }, 60)).toMatchObject({ ttlMs: 60_000 });
  });

  it("refuses a rule that does not match, does not apply here, is not approve, a deny that decides, or no rule", async () => {
    expect(await verifyForcedCard(claims, { toolName: "Bash", input: { command: "ls" }, ruleId: "deploys#ask", ttlMs: 1 })).toEqual({ ok: false, message: "the owner's guardrails do not ask for a card on Bash" });
    expect((await verifyForcedCard(claims, { toolName: "Write", input: {}, ruleId: "elsewhere#ask2", ttlMs: 1 })).ok).toBe(false);
    expect((await verifyForcedCard({ ...claims, channel: "C-OTHER" }, { toolName: "Write", input: {}, ruleId: "elsewhere#ask2", ttlMs: 1 })).ok).toBe(true);
    expect(await verifyForcedCard(claims, { toolName: "Bash", input: { command: "deploy; rm -rf /" }, ruleId: "deploys#ask", ttlMs: 1 })).toEqual({ ok: false, message: "never" });
    expect((await verifyForcedCard(claims, { toolName: "Bash", input: { command: "deploy" }, ruleId: "deploys#no-rm", ttlMs: 1 })).ok).toBe(false);
    expect((await verifyForcedCard(claims, { toolName: "Bash", input: { command: "deploy" }, ruleId: undefined, ttlMs: 1 })).ok).toBe(false);
  });

  it("the can_use_tool route denies a forced card that does not verify, and opens a verified one forced", async () => {
    const opened: any[] = [];
    const deps: any = {
      slackCtx: () => ({ channel: "C1", threadTs: "1.1", inboundTs: "1.1", client: {} }),
      openPermission: async (_c: unknown, a: unknown) => {
        opened.push(a);
        return { pendingId: "p1" };
      },
    };
    const deny = await executeRuntimeTool("can_use_tool", { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "x1", force_card: true, rule_id: "deploys#ask" }, claims as any, deps);
    expect(JSON.parse(deny!.content[0]!.text).decision.behavior).toBe("deny");
    expect(opened).toHaveLength(0);
    const ok = await executeRuntimeTool("can_use_tool", { tool_name: "Bash", input: { command: "deploy" }, tool_use_id: "x2", force_card: true, rule_id: "deploys#ask", ttl_ms: 5000 }, claims as any, deps);
    expect(JSON.parse(ok!.content[0]!.text)).toEqual({ pendingId: "p1" });
    expect(opened[0].forced).toEqual({ ruleId: "deploys#ask", message: "Deploys need an approver.", ttlMs: 5000 });
  });

  it("an unavailable set refuses the card", async () => {
    const r = await verifyForcedCard({ ...claims, tenant: "no-such-tenant-xyz" }, { toolName: "Bash", input: {}, ruleId: "deploys#ask", ttlMs: 1 });
    expect(r.ok).toBe(false);
  });
});

describe("the node's report of a card", () => {
  it("records approved or refused for an approve rule, the action always the gateway's", async () => {
    await db.run("DELETE FROM audit_events WHERE action LIKE 'guardrail.tool.%'");
    const ev = (applied: any, job: string) => ({ claims: { ...claims, session: `S-${job}`, job }, events: [{ on: "tool" as const, slug: "deploys", ruleId: "ask", action: "deny" as const, applied, deciding: true, toolName: "Bash" }] });
    for (const [applied, job] of [["approved", "J-a"], ["refused", "J-r"], ["deny", "J-d"]] as const) {
      const e = ev(applied, job);
      await recordNodeGuardrailEvent(e.claims, { kind: "firing", events: e.events, slugs: [] });
    }
    await flushAudits();
    const rows = await db.query<{ action: string; session_id: string }>(`SELECT action, session_id FROM audit_events WHERE action LIKE 'guardrail.tool.%' ORDER BY session_id`);
    expect(rows).toEqual([
      { action: "guardrail.tool.approved", session_id: "S-J-a" },
      { action: "guardrail.tool.refused", session_id: "S-J-d" },
      { action: "guardrail.tool.refused", session_id: "S-J-r" },
    ]);
  });
});

describe("a card the node stopped waiting on", () => {
  it("the node cancels the gateway's row when the hook aborts", async () => {
    const cancelled: string[] = [];
    const client: any = {
      postTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ pendingId: "pend-9" }) }] }),
      getPending: () => new Promise(() => {}),
      cancelPending: async (id: string) => void cancelled.push(id),
    };
    const r = makeNodePermissionResolver({ client, tokenFor: () => "tok" });
    const ac = new AbortController();
    const p = r("S1", "Bash", { command: "deploy" }, { signal: ac.signal, toolUseID: "tu-c1", ownerApproval: { ruleId: "deploys#ask", message: "m", deadline: Date.now() + 60_000 } } as any);
    await new Promise((res) => setTimeout(res, 10));
    ac.abort();
    expect(await p).toEqual({ behavior: "deny", message: "aborted" });
    expect(cancelled).toEqual(["pend-9"]);
  });

  it("DELETE /v1/pending/:id cancels only the session's own poll row; a late click then finds it cancelled", async () => {
    const { handlePendingCancel } = await import("../../src/gateway/api/pending");
    const PendingGates = await import("../../src/db/pending-gates");
    await PendingGates.create({ id: "pc-1", kind: "perm", sessionId: "S-pc", payload: { toolName: "Bash", waiter: "poll", guardrail: "deploys#ask" }, expiresAt: Date.now() + 60_000 });
    expect((await handlePendingCancel("pc-1", "S-other")).status).toBe(404);
    expect((await handlePendingCancel("nope", "S-pc")).status).toBe(404);
    const r = await handlePendingCancel("pc-1", "S-pc");
    expect(await r.json()).toEqual({ status: "cancelled" });
    expect((await PendingGates.get("pc-1"))?.status).toBe("cancelled");
    expect(await (await handlePendingCancel("pc-1", "S-pc")).json()).toEqual({ status: "cancelled" });
    await PendingGates.create({ id: "pc-2", kind: "approval", sessionId: "S-pc", payload: { waiter: "poll" }, expiresAt: Date.now() + 60_000 });
    expect((await handlePendingCancel("pc-2", "S-pc")).status).toBe(404);
  });
});

describe("mixed gateway versions", () => {
  it("the node sends an approve card's outcome in its own batch, so an rc.9 gateway still records the rest", async () => {
    const { makeNodeGuardrailSink } = await import("../../src/node/worker");
    const bodies: any[] = [];
    const sink = makeNodeGuardrailSink({ client: { request: async (_p: string, o: any) => { bodies.push(o.body); return new Response("{}"); } } as any, tokenFor: () => "tok" });
    sink.firing("S1", [
      { on: "tool", slug: "deploys", ruleId: "ask", action: "approve", applied: "approved", deciding: true, toolName: "Bash" },
      { on: "tool", slug: "watch", ruleId: "w", action: "audit", applied: "audit", deciding: false, toolName: "Bash" },
    ], { persona: "default", channelId: "C1", kind: "interactive" });
    await new Promise((r) => setTimeout(r, 5));
    expect(bodies.map((b) => b.events.map((e: any) => e.applied))).toEqual([["audit"], ["approved"]]);
    sink.firing("S1", [{ on: "tool", slug: "watch", ruleId: "w", action: "audit", applied: "audit", deciding: true }], { persona: "default", channelId: "C1", kind: "interactive" });
    await new Promise((r) => setTimeout(r, 5));
    expect(bodies).toHaveLength(3);
  });
});
