/**
 * The gateway's owner guardrail wiring: the resolver and sink it installs,
 * what a snapshot change does (signal nodes, reload mono sessions, survive a
 * failed publish), the reply quiet window's bound, and the snapshot's change
 * listeners and failure dedupe.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../../src/db/schema";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, onGuardrailsChanged, refreshGuardrails } from "../../../src/guardrails/snapshot";
import { auditSink, gatewaySessionGuardrails, installOwnerGuardrails, makeReplyQuiet } from "../../../src/gateway/core/owner-guardrails";
import { flushAudits } from "../../../src/audit/emit";
import { ensureGuardrailKeyForPg } from "../../guardrails/helpers";

ensureGuardrailKeyForPg();

const MD = (body: string) => `---\nname: house\n---\n${body}`;

beforeEach(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  await db.run("DELETE FROM audit_events WHERE action LIKE 'guardrail.%'");
});
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});

function fakeAgent() {
  const calls: { reloads: number[]; resolver?: any; sink?: any } = { reloads: [] };
  const agent = {
    setGuardrailResolver: (r: any) => (calls.resolver = r),
    setGuardrailSink: (s: any) => (calls.sink = s),
    reloadForGuardrails: (v: number) => (calls.reloads.push(v), 2),
  } as any;
  return { agent, calls };
}

describe("installOwnerGuardrails", () => {
  it("installs the resolver and sink; a change signals nodes and reloads mono sessions; a failed publish is logged, not thrown", async () => {
    const { agent, calls } = fakeAgent();
    const published: string[] = [];
    let failPublish = false;
    const pubsub = { publishReload: async (t: string) => { if (failPublish) throw new Error("redis down"); published.push(t); return 1; } } as any;
    const stop = installOwnerGuardrails(agent, { pubsub, mono: true, pollMs: 60_000 });
    try {
      await refreshGuardrails();
      expect(typeof calls.resolver).toBe("function");
      expect(calls.sink).toBe(auditSink);
      const g = await calls.resolver("S1", undefined, "C1");
      expect(g.version).toBe(0);
      await applyGuardrailChange("default", { upsert: [{ slug: "house", md: MD("Be kind."), source: "file" }], by: "t" });
      await refreshGuardrails();
      expect(published).toEqual(["default"]);
      expect(calls.reloads).toEqual([1]);
      failPublish = true;
      await applyGuardrailChange("default", { upsert: [{ slug: "house", md: MD("Be kinder."), source: "file" }], by: "t" });
      await refreshGuardrails();
      await Bun.sleep(5);
      expect(calls.reloads).toEqual([1, 2]);
    } finally {
      stop();
    }
  });

  it("a gateway role (no mono) only signals; no pub/sub, nothing breaks", async () => {
    const { agent, calls } = fakeAgent();
    const stop = installOwnerGuardrails(agent, { pubsub: null, mono: false, pollMs: 60_000 });
    try {
      await refreshGuardrails();
      await applyGuardrailChange("default", { upsert: [{ slug: "house", md: MD("x"), source: "file" }], by: "t" });
      await refreshGuardrails();
      expect(calls.reloads).toEqual([]);
    } finally {
      stop();
    }
  });

  it("the sink records firings and deliveries; the session resolver reads the verified set", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "house", md: MD("Prose.\n\n```rules\n- id: r\n  on: tool\n  match: { tool: Bash }\n  action: deny\n```") }].map((u) => ({ ...u, source: "file" as const })), by: "t" });
    const g = await gatewaySessionGuardrails("default", "C1", { sessionId: "S2" });
    expect(g.toolRules).toHaveLength(1);
    auditSink.firing("S2", [{ on: "tool", slug: "house", ruleId: "r", action: "deny", applied: "deny", deciding: true, toolName: "Bash" }], { persona: "default", channelId: "C1", kind: "wake" });
    auditSink.delivered("S2", ["house"], { persona: "default", channelId: "C1", kind: "wake", via: "tool", toolName: "Bash" });
    await flushAudits();
    const rows = await db.query<{ action: string }>(`SELECT action FROM audit_events WHERE action LIKE 'guardrail.%'`);
    expect(rows.map((r) => r.action).sort()).toEqual(["guardrail.guidance.delivered", "guardrail.tool.denied"]);
  });
});

describe("the snapshot's listeners and failures", () => {
  it("a listener that throws never blocks the others; one audit row per distinct failure", async () => {
    await refreshGuardrails();
    const seen: Array<number | null> = [];
    onGuardrailsChanged(() => { throw new Error("listener bug"); });
    onGuardrailsChanged((_t, s) => seen.push(s ? s.version : null));
    await applyGuardrailChange("default", { upsert: [{ slug: "house", md: MD("x"), source: "file" }], by: "t" });
    await refreshGuardrails();
    expect(seen).toEqual([1]);
    await db.run("UPDATE guardrails SET md = 'tampered'");
    await refreshGuardrails();
    await refreshGuardrails();
    await refreshGuardrails();
    expect(seen).toEqual([1, null]);
    await flushAudits();
    const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'guardrail.integrity.failed'`);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe("the reply quiet window", () => {
  it("forgets the oldest key past its cap", () => {
    let now = 0;
    const quiet = makeReplyQuiet(() => 1000, 2, () => now);
    expect(quiet("a")).toBe(true);
    expect(quiet("b")).toBe(true);
    expect(quiet("c")).toBe(true);
    // "a" was evicted: it may reply again within the window.
    expect(quiet("a")).toBe(true);
    expect(quiet("c")).toBe(false);
  });
});
