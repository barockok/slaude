import { beforeEach, describe, it, expect } from "bun:test";
import { db } from "../../src/db/schema";
import * as AuditEvents from "../../src/db/audit-events";
import { flushAudits } from "../../src/audit/emit";
import { audit, panelAuditInput } from "../../src/gateway/panel/auth/audit";

async function capture(fn: (sink: (l: string) => void) => void): Promise<string[]> {
  const lines: string[] = [];
  fn((l) => lines.push(l));
  await flushAudits();
  return lines;
}

beforeEach(async () => {
  // Writes left in flight by an earlier test must land before the wipe.
  await flushAudits();
  await db.run("DELETE FROM audit_events");
});

describe("panel audit", () => {
  it("emits exactly one line of valid JSON, through the shared writer, and one durable row", async () => {
    const lines = await capture((sink) =>
      audit({ action: "control.reset", operator: "lead@example.com", role: "superadmin", session: "S-1" }, sink),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.includes("\n")).toBe(false);
    const rec = JSON.parse(lines[0]!);
    expect(rec.evt).toBe("audit");
    expect(rec.action).toBe("panel.session.control");
    expect(rec.actor_kind).toBe("operator");
    expect(rec.actor_id).toBe("lead@example.com");
    expect(rec.session).toBe("S-1");
    expect(rec.detail).toMatchObject({ panelAction: "control.reset", role: "superadmin", outcome: "ok" });
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
    const [row] = (await AuditEvents.list({ actorId: "lead@example.com" })).items;
    expect(row).toMatchObject({ action: "panel.session.control", actorKind: "operator", targetKind: "session", targetId: "S-1" });
  });

  it("omits session when absent; auth actions keep their name under panel.", async () => {
    const [line] = await capture((sink) => audit({ action: "auth.login", operator: "alice@example.com" }, sink));
    const rec = JSON.parse(line!);
    expect(rec.action).toBe("panel.auth.login");
    expect("session" in rec).toBe(false);
  });

  it("a denied outcome is a refusal and carries its detail", async () => {
    const [line] = await capture((sink) =>
      audit(
        { action: "force-release", operator: "alice@example.com", role: "operator", session: "S-2",
          outcome: "denied", detail: { required: "superadmin" } },
        sink,
      ),
    );
    const rec = JSON.parse(line!);
    expect(rec.decision).toBe("refused");
    expect(rec.detail).toMatchObject({ outcome: "denied", required: "superadmin", panelAction: "force-release" });
  });

  it("drops undefined detail values rather than emitting nulls", async () => {
    const [line] = await capture((sink) =>
      audit({ action: "control.model", operator: "a@example.com", detail: { model: "m", mode: undefined } }, sink),
    );
    const d = JSON.parse(line!).detail;
    expect(d.model).toBe("m");
    expect("mode" in d).toBe(false);
  });

  it("maps persona actions: onboard, override set and clear, reload", () => {
    expect(panelAuditInput({ action: "persona.create", operator: "o", detail: { tenantId: "t1", persona: "helper" } })).toMatchObject({
      action: "panel.persona.onboard", persona: "helper", tenantId: "t1", targetKind: "persona", targetId: "helper",
    });
    const set = panelAuditInput({ action: "persona.override", operator: "o", detail: { persona: "helper", field: "model", op: "set" } });
    expect(set).toMatchObject({ action: "soul.override.set", targetKind: "soul_field", targetId: "model", persona: "helper" });
    expect(panelAuditInput({ action: "persona.override", operator: "o", detail: { field: "soul", op: "clear" } }).action).toBe("soul.override.cleared");
    expect(panelAuditInput({ action: "persona.override", operator: "o", outcome: "denied" })).toMatchObject({
      action: "panel.persona.override", decision: "refused", targetKind: "soul_field", targetId: null,
    });
    expect(panelAuditInput({ action: "reload", operator: "o" }).action).toBe("panel.config.reload");
    for (const a of ["chat", "lock", "release", "force-release", "control.unlock-1on1"]) {
      expect(panelAuditInput({ action: a, operator: "o", session: "S" }).action).toBe("panel.session.control");
    }
  });
});
