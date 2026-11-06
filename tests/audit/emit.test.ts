import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as AuditEvents from "../../src/db/audit-events";
import * as Sessions from "../../src/db/sessions";
import { auditExpiredGates, emitAudit, flushAudits, gateActionKind, gateTarget } from "../../src/audit/emit";

beforeEach(async () => {
  await db.run("DELETE FROM audit_events");
});

const gate = (kind: "perm" | "approval" | "mcp_connect", payload: Record<string, unknown>) => ({
  id: `g-${kind}`,
  sessionId: "S_EMIT",
  kind,
  payload,
  status: "expired" as const,
  resolvedBy: "system",
  resolvedAt: 1,
  expiresAt: 1,
  createdAt: 1,
  instanceId: null,
});

describe("emitAudit", () => {
  test("persona falls back to the session's persona, then to default", async () => {
    const s = await Sessions.createForThread({
      thread: { team_id: "T", channel_id: "C", thread_ts: `${Date.now()}.9`, persona_id: "helper" },
      model: "m",
      working_dir: "/tmp",
    });
    emitAudit({ actorKind: "system", actorId: "system", action: "x.one", sessionId: s.id });
    emitAudit({ actorKind: "system", actorId: "system", action: "x.two", sessionId: "missing" });
    emitAudit({ actorKind: "system", actorId: "system", action: "x.three", persona: "named", sessionId: s.id });
    await flushAudits();
    const by = Object.fromEntries((await AuditEvents.list({ action: "x." })).items.map((e) => [e.action, e.persona]));
    expect(by).toEqual({ "x.one": "helper", "x.two": "default", "x.three": "named" });
  });

  test("a failing writer never throws out of emitAudit", async () => {
    emitAudit(
      { actorKind: "system", actorId: "system", action: "x.fail" },
      { insert: async () => { throw new Error("db down"); }, sink: () => {} },
    );
    await flushAudits();
  });
});

describe("gate helpers", () => {
  test("action kind and target per gate kind", () => {
    expect(gateActionKind("perm")).toBe("permission");
    expect(gateActionKind("approval")).toBe("approval");
    expect(gateTarget(gate("perm", { toolName: "Bash" }))).toEqual({ targetKind: "tool", targetId: "Bash" });
    expect(gateTarget(gate("perm", {}))).toEqual({ targetKind: "tool", targetId: "unknown" });
    expect(gateTarget(gate("approval", { scope: "shared", category: "kb" }))).toEqual({ targetKind: "approval", targetId: "shared" });
    expect(gateTarget(gate("approval", {}))).toEqual({ targetKind: "approval", targetId: "plan" });
    expect(gateTarget(gate("mcp_connect", { serverName: "docs" }))).toEqual({ targetKind: "mcp_server", targetId: "docs" });
    expect(gateTarget(gate("mcp_connect", {}))).toEqual({ targetKind: "mcp_server", targetId: "g-mcp_connect" });
  });

  test("auditExpiredGates: one expired row per gate, context from the payload", async () => {
    auditExpiredGates([
      gate("mcp_connect", { serverName: "docs", channelId: "C9", threadTs: "2.0", personaName: "helper" }),
      gate("approval", { channel: "C8", threadTs: "3.0", category: "kb" }),
    ]);
    await flushAudits();
    const items = (await AuditEvents.list({ action: "gate." })).items;
    const byAction = Object.fromEntries(items.map((e) => [e.action, e]));
    expect(byAction["gate.mcp_connect.expired"]).toMatchObject({
      persona: "helper", channelId: "C9", threadTs: "2.0", targetId: "docs", decision: "expired", actorKind: "system",
    });
    expect(byAction["gate.approval.expired"]).toMatchObject({ channelId: "C8", threadTs: "3.0", targetId: "kb" });
    expect(byAction["gate.approval.expired"]!.details).toMatchObject({ category: "kb", gateId: "g-approval" });
  });
});
