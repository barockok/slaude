/**
 * Owner guardrails reach nodes in the runtime bundle (design section 2): the
 * effective documents for the persona, the set's version as an explicit ETag
 * input, refusal (audited) of an agent with enforced rules to a node that does
 * not advertise the capability, and fail-closed on a set that does not verify.
 * The node side builds the same session guardrails from the bundle and sends
 * its firings to the gateway, which records only what its own set knows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ensureHome } from "../../src/config/home";
import { handleTenantRuntime } from "../../src/gateway/api/tenants";
import { __resetPersonaRegistry } from "../../src/persona/registry";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, refreshGuardrails } from "../../src/guardrails/snapshot";
import { CAPABILITIES_HEADER, GUARDRAILS_CAPABILITY, hasCapability } from "../../src/guardrails/capability";
import { bundleSessionGuardrails } from "../../src/guardrails/node";
import { db } from "../../src/db/schema";
import { flushAudits } from "../../src/audit/emit";
import { bundleFetchFailure, NodeApiError } from "../../src/node/client";
import { makeBundleGuardrailResolver, makeNodeGuardrailSink, NODE_CAPS } from "../../src/node/worker";
import { recordNodeGuardrailEvent } from "../../src/gateway/core/owner-guardrails";
import { BootFailure } from "../../src/gateway/core/failure-codes";
import { ensureGuardrailKeyForPg } from "../guardrails/helpers";

ensureGuardrailKeyForPg();

const PROSE = "---\nname: house\ndescription: d\n---\nSign as the team.";
const RULES = "---\nname: no-shell\ndescription: d\n---\n```rules\n- id: r\n  on: tool\n  match: { tool: Bash }\n  action: deny\n  message: no shell\n```";
const OTHER = "---\nname: only-bea\nscope: agents\nagents: [bea]\n---\nBea only.";

const get = (headers: Record<string, string> = {}) =>
  handleTenantRuntime(new Request("http://gw/x", { headers }), "default", "default", { nodeId: "node-old", sessionId: "S-b" });
const cap = { [CAPABILITIES_HEADER]: GUARDRAILS_CAPABILITY };

beforeAll(() => {
  ensureHome();
  __resetPersonaRegistry();
});
beforeEach(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});

describe.skipIf(process.env.SLAUDE_DB === "pg")("the runtime bundle", () => {
  it("no guardrail set: no field, the ETag as before", async () => {
    const a = await get();
    expect(a.status).toBe(200);
    expect(((await a.json()) as any).guardrails).toBeUndefined();
  });

  it("carries the persona's documents; the version busts the ETag", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "house", md: PROSE, source: "file" }, { slug: "only-bea", md: OTHER, source: "file" }], by: "t" });
    const r = await get(cap);
    const b = (await r.json()) as any;
    expect(b.guardrails).toMatchObject({ version: 1, enforced: false, proseMax: 4000 });
    expect(b.guardrails.docs.map((d: any) => d.slug)).toEqual(["house"]);
    const etag1 = r.headers.get("etag")!;
    expect((await get({ ...cap, "if-none-match": etag1 })).status).toBe(304);
    await applyGuardrailChange("default", { setEnabled: [{ slug: "only-bea", enabled: false }], by: "t" });
    const r2 = await get({ ...cap, "if-none-match": etag1 });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).guardrails.version).toBe(2);
  });

  it("an agent with enforced rules is refused to a node without the capability, audited", async () => {
    await db.run("DELETE FROM audit_events WHERE action = 'guardrail.node.unsupported'");
    await applyGuardrailChange("default", { upsert: [{ slug: "no-shell", md: RULES, source: "file" }], by: "t" });
    const old = await get();
    expect(old.status).toBe(409);
    expect(((await old.json()) as any).code).toBe("GUARDRAILS_UNSUPPORTED");
    expect((await get(cap)).status).toBe(200);
    await flushAudits();
    const rows = await db.query<{ action: string; target_id: string; session_id: string }>(`SELECT action, target_id, session_id FROM audit_events WHERE action = 'guardrail.node.unsupported'`);
    expect(rows).toEqual([{ action: "guardrail.node.unsupported", target_id: "node-old", session_id: "S-b" }]);
  });

  it("a set that does not verify refuses the bundle (fail closed)", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "house", md: PROSE, source: "file" }], by: "t" });
    await db.run("UPDATE guardrails SET md = 'tampered'");
    const r = await get(cap);
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).code).toBe("GUARDRAILS_UNAVAILABLE");
  });
});

describe("the node side", () => {
  it("advertises the capability; maps the gateway's refusals to typed boot failures", () => {
    expect(NODE_CAPS).toContain(GUARDRAILS_CAPABILITY);
    expect(hasCapability("a/1, guardrails/1")).toBe(true);
    expect(hasCapability(null)).toBe(false);
    for (const code of ["GUARDRAILS_UNAVAILABLE", "GUARDRAILS_UNSUPPORTED"]) {
      const f = bundleFetchFailure(new NodeApiError(code === "GUARDRAILS_UNSUPPORTED" ? 409 : 503, JSON.stringify({ code })));
      expect(f).toBeInstanceOf(BootFailure);
      expect(f.code).toBe(code as any);
      expect(f.transient).toBe(false);
    }
    expect(bundleFetchFailure(new NodeApiError(500, "not json")).code).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
  });

  it("builds the same session guardrails from the bundle", async () => {
    const docs = [{ slug: "no-shell", md: RULES, source: "file" as const, override: false, behindSource: false, enabled: true }];
    const bundle = { guardrails: { version: 4, enforced: true, proseMax: 4000, docs } } as any;
    const resolve = makeBundleGuardrailResolver({
      client: { getRuntime: async () => bundle },
      tenantFor: () => "default",
      tokenFor: () => "tok",
      personaFor: () => "default",
    });
    const g = (await resolve("S1", undefined, "C1"))!;
    expect(g.version).toBe(4);
    expect(g.toolRules.map((h) => h.rule.id)).toEqual(["r"]);
    expect(bundleSessionGuardrails(undefined, "default", null)).toBeNull();
    const none = makeBundleGuardrailResolver({ client: { getRuntime: async () => ({}) as any }, tenantFor: () => "default", tokenFor: () => "tok", personaFor: () => "default" });
    expect(await none("S1", undefined, null)).toBeNull();
    const refused = makeBundleGuardrailResolver({
      client: { getRuntime: async () => { throw new NodeApiError(503, JSON.stringify({ code: "GUARDRAILS_UNAVAILABLE" })); } },
      tenantFor: () => "default", tokenFor: () => "tok", personaFor: () => "default",
    });
    await expect(refused("S1", undefined, null)).rejects.toMatchObject({ code: "GUARDRAILS_UNAVAILABLE" });
  });

  it("posts firings and deliveries to the gateway, names only; no token, no post", async () => {
    const posts: any[] = [];
    const sink = makeNodeGuardrailSink({ client: { request: async (path: string, o: any) => (posts.push({ path, ...o }), new Response("{}")) } as any, tokenFor: (id) => (id === "S1" ? "tok" : undefined) });
    sink.firing("S1", [{ on: "tool", slug: "no-shell", ruleId: "r", action: "deny", applied: "deny", deciding: true, toolName: "Bash" }], { persona: "default", channelId: "C1", kind: "interactive" });
    sink.delivered("S1", ["care"], { persona: "default", channelId: "C1", kind: "wake", via: "tool", toolName: "Bash" });
    sink.firing("S2", [], { persona: "default", channelId: null, kind: "interactive" });
    expect(posts.map((p) => p.path)).toEqual(["/v1/tools/runtime/guardrail_event", "/v1/tools/runtime/guardrail_event"]);
    expect(posts[0].body).toEqual({ kind: "firing", session_kind: "interactive", events: [{ on: "tool", slug: "no-shell", rule_id: "r", action: "deny", applied: "deny", deciding: true, tool_name: "Bash" }] });
    expect(posts[1].body).toEqual({ kind: "delivery", session_kind: "wake", slugs: ["care"], via: "tool", tool_name: "Bash" });
  });

  it("the gateway records a node's report only for guardrails and rules its own set applies to the agent", async () => {
    await db.run("DELETE FROM audit_events WHERE action LIKE 'guardrail.%'");
    const CARE = "---\nname: care\nload: on-match\ntriggers: { tool: Bash }\n---\nCareful.";
    await applyGuardrailChange("default", { upsert: [{ slug: "no-shell", md: RULES, source: "file" }, { slug: "care", md: CARE, source: "file" }, { slug: "only-bea", md: OTHER, source: "file" }], by: "t" });
    await refreshGuardrails();
    const claims = { tenant: "default", persona: "default", session: "S9", channel: "C9", thread: "9.9" };
    const ev = (slug: string, ruleId: string, action: "deny" | "audit" = "deny") => ({ on: "tool" as const, slug, ruleId, action, applied: action, deciding: true, toolName: "Bash" });
    const r = await recordNodeGuardrailEvent(claims, { kind: "firing", sessionKind: "wake", events: [ev("no-shell", "r"), ev("no-shell", "forged"), ev("only-bea", "r"), ev("no-shell", "r", "audit")], slugs: [] });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ recorded: 1 });
    const d = await recordNodeGuardrailEvent(claims, { kind: "delivery", events: [], slugs: ["care", "no-shell", "nope"], via: "tool", toolName: "Bash" });
    expect(JSON.parse(d.content[0]!.text)).toEqual({ recorded: 1 });
    await flushAudits();
    const rows = await db.query<{ action: string; target_id: string; session_id: string; channel_id: string }>(`SELECT action, target_id, session_id, channel_id FROM audit_events WHERE action LIKE 'guardrail.%' ORDER BY id`);
    expect(rows.sort((a, b) => a.action.localeCompare(b.action))).toEqual([
      { action: "guardrail.guidance.delivered", target_id: "care", session_id: "S9", channel_id: "C9" },
      { action: "guardrail.tool.denied", target_id: "no-shell#r", session_id: "S9", channel_id: "C9" },
    ]);
  });
});

// The database is shared by every test file of the run: leave no guardrail behind.
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});
