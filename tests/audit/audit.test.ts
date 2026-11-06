import { beforeEach, describe, expect, test } from "bun:test";
import { db, dbDialect } from "../../src/db/schema";
import * as AuditEvents from "../../src/db/audit-events";
import { audit, newAuditId } from "../../src/audit";
import { redactEvent } from "../../src/audit/redact";
import { metrics } from "../../src/metrics";

beforeEach(async () => {
  await db.run("DELETE FROM audit_events");
});

function row(n: number, over: Partial<AuditEvents.AuditEvent> = {}): AuditEvents.AuditEvent {
  return {
    id: `${String(1_000 + n).padStart(13, "0")}-r${n}`,
    tenantId: "default",
    persona: "default",
    at: 1_000 + n,
    actorKind: "slack_user",
    actorId: "U1",
    action: "gate.permission.decided",
    targetKind: "tool",
    targetId: "Bash",
    decision: "allow",
    sessionId: "s1",
    channelId: "C1",
    threadTs: "1.0",
    summary: `event ${n}`,
    details: { n },
    ...over,
  };
}

function failures(): number {
  const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_audit_write_failures_total"));
  return line ? Number(line.split(" ").pop()) : 0;
}

describe("audit_events repo", () => {
  test("insert and list round trip", async () => {
    const ev = row(1, { details: { nested: { a: [1, "two"] } } });
    await AuditEvents.insert(ev);
    const { items, nextCursor } = await AuditEvents.list({});
    expect(items).toEqual([ev]);
    expect(nextCursor).toBeNull();
  });

  test("nullable columns come back as null", async () => {
    await AuditEvents.insert({
      id: newAuditId(5),
      at: 5,
      actorKind: "system",
      actorId: "system",
      action: "persona.sync",
      summary: "",
      details: {},
    });
    const [it] = (await AuditEvents.list({})).items;
    expect(it).toMatchObject({
      persona: null,
      targetKind: null,
      targetId: null,
      decision: null,
      sessionId: null,
      channelId: null,
      threadTs: null,
      details: {},
    });
  });

  test("newest first, cursor pages across three pages", async () => {
    for (let i = 1; i <= 7; i++) await AuditEvents.insert(row(i));
    const p1 = await AuditEvents.list({}, { limit: 3 });
    expect(p1.items.map((e) => e.at)).toEqual([1007, 1006, 1005]);
    expect(p1.nextCursor).toBe(p1.items[2]!.id);
    const p2 = await AuditEvents.list({}, { limit: 3, cursor: p1.nextCursor! });
    expect(p2.items.map((e) => e.at)).toEqual([1004, 1003, 1002]);
    const p3 = await AuditEvents.list({}, { limit: 3, cursor: p2.nextCursor! });
    expect(p3.items.map((e) => e.at)).toEqual([1001]);
    expect(p3.nextCursor).toBeNull();
  });

  test("limit is clamped to at least one and at most 500", async () => {
    for (let i = 1; i <= 3; i++) await AuditEvents.insert(row(i));
    expect((await AuditEvents.list({}, { limit: 0 })).items).toHaveLength(1);
    expect((await AuditEvents.list({}, { limit: 10_000 })).items).toHaveLength(3);
  });

  test("filters: persona, action exact and prefix, actor, session, time range", async () => {
    await AuditEvents.insert(row(1, { persona: "alpha", action: "gate.permission.decided" }));
    await AuditEvents.insert(row(2, { persona: "beta", action: "gate.approval.expired", actorId: "U2" }));
    await AuditEvents.insert(row(3, { persona: "alpha", action: "grant.created", sessionId: "s2" }));
    await AuditEvents.insert(row(4, { persona: "alpha", action: "gate.permission.expired", actorId: "U2" }));
    const ats = async (f: AuditEvents.AuditFilter) => (await AuditEvents.list(f)).items.map((e) => e.at);

    expect(await ats({ persona: "alpha" })).toEqual([1004, 1003, 1001]);
    expect(await ats({ action: "grant.created" })).toEqual([1003]);
    expect(await ats({ action: "gate." })).toEqual([1004, 1002, 1001]);
    expect(await ats({ action: "gate.permission." })).toEqual([1004, 1001]);
    expect(await ats({ action: "gate" })).toEqual([]);
    expect(await ats({ actorId: "U2" })).toEqual([1004, 1002]);
    expect(await ats({ sessionId: "s2" })).toEqual([1003]);
    expect(await ats({ since: 1002, until: 1003 })).toEqual([1003, 1002]);
    expect(await ats({ persona: "alpha", actorId: "U2", action: "gate." })).toEqual([1004]);
  });

  test("tenant filter scopes on Postgres and is a no-op on sqlite", async () => {
    await AuditEvents.insert(row(1, { tenantId: "t1" }));
    await AuditEvents.insert(row(2, { tenantId: "t2" }));
    const ats = (await AuditEvents.list({ tenantId: "t1" })).items.map((e) => e.at);
    expect(ats).toEqual(dbDialect() === "pg" ? [1001] : [1002, 1001]);
  });

  test("purgeOlderThan deletes only rows older than the horizon", async () => {
    await AuditEvents.insert(row(1, { at: 100 }));
    await AuditEvents.insert(row(2, { at: 900 }));
    expect(await AuditEvents.purgeOlderThan(500, 1000)).toBe(1);
    expect((await AuditEvents.list({})).items.map((e) => e.at)).toEqual([900]);
  });
});

describe("audit ids", () => {
  test("zero padded epoch ms with a random suffix, lexically time sortable", () => {
    const a = newAuditId(999);
    const b = newAuditId(1_000);
    expect(a.startsWith("0000000000999-")).toBe(true);
    expect(a < b).toBe(true);
    expect(newAuditId(5)).not.toBe(newAuditId(5));
  });
});

describe("redaction", () => {
  test("token-like value in summary and a password key in nested details", () => {
    const out = redactEvent({
      summary: "approved curl with sk-test1234placeholder",
      details: {
        tool: "Bash",
        input: { command: "echo token=abc123", auth: { password: "hunter2", user: "jane" } },
        list: [{ api_key: "x" }, "Bearer abc.def.ghi", 3],
        ok: true,
        none: null,
      },
    });
    expect(out.summary).not.toContain("sk-test");
    expect(out.summary).toContain("approved curl with");
    expect(out.details).toEqual({
      tool: "Bash",
      input: { command: "echo ••••", auth: { password: "[redacted]", user: "jane" } },
      list: [{ api_key: "[redacted]" }, "••••", 3],
      ok: true,
      none: null,
    });
  });
});

describe("redaction depth", () => {
  test("objects nested past the depth limit are dropped, not stored raw", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 30; i++) deep = { child: deep };
    const out = redactEvent({ summary: "", details: deep }).details;
    expect(JSON.stringify(out)).toContain("[truncated]");
    expect(JSON.stringify(out)).not.toContain("leaf");
  });
});

describe("audit writer", () => {
  test("writes a redacted row and one stdout JSON line", async () => {
    const lines: string[] = [];
    await audit(
      {
        persona: "alpha",
        actorKind: "slack_user",
        actorId: "U1",
        action: "gate.permission.decided",
        targetKind: "tool",
        targetId: "Bash",
        decision: "allow",
        sessionId: "s1",
        summary: "allowed with password=hunter2",
        details: { secret: "x", note: "fine" },
      },
      { sink: (l) => lines.push(l), now: () => 4242 },
    );
    const [it] = (await AuditEvents.list({})).items;
    expect(it!.at).toBe(4242);
    expect(it!.id.startsWith("0000000004242-")).toBe(true);
    expect(it!.summary).toBe("allowed with ••••");
    expect(it!.details).toEqual({ secret: "[redacted]", note: "fine" });
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({
      evt: "audit",
      id: it!.id,
      action: "gate.permission.decided",
      actor_kind: "slack_user",
      actor_id: "U1",
      persona: "alpha",
      session: "s1",
      decision: "allow",
      summary: "allowed with ••••",
      detail: { secret: "[redacted]", note: "fine" },
    });
    expect(typeof line.ts).toBe("string");
  });

  test("a write failure does not throw: logs and counts", async () => {
    const before = failures();
    const lines: string[] = [];
    await expect(
      audit(
        { actorKind: "system", actorId: "system", action: "persona.sync" },
        {
          sink: (l) => lines.push(l),
          insert: async () => {
            throw new Error("db down");
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(failures()).toBe(before + 1);
    // The stdout line is still written: it is the record of last resort.
    expect(lines).toHaveLength(1);
  });

  test("a failing sink does not throw either", async () => {
    const before = failures();
    await audit(
      { actorKind: "system", actorId: "system", action: "persona.sync" },
      {
        sink: () => {
          throw new Error("stdout closed");
        },
      },
    );
    expect(failures()).toBe(before + 1);
    expect((await AuditEvents.list({})).items).toHaveLength(1);
  });

  test("details that cannot be read do not throw either", async () => {
    const before = failures();
    const lines: string[] = [];
    const details = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("unreadable");
      },
    });
    await audit({ actorKind: "system", actorId: "system", action: "persona.sync", details }, { sink: (l) => lines.push(l) });
    expect(failures()).toBe(before + 1);
    expect(lines).toHaveLength(0);
  });

  test("default sink is stdout", async () => {
    const orig = console.log;
    const lines: string[] = [];
    console.log = (l: string) => lines.push(l);
    try {
      await audit({ actorKind: "system", actorId: "system", action: "persona.sync" });
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(lines[0]!).evt).toBe("audit");
  });
});
