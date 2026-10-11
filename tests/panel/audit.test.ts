import { describe, it, expect } from "bun:test";
import { audit } from "../../src/gateway/panel/auth/audit";

function capture(fn: (sink: (l: string) => void) => void): string[] {
  const lines: string[] = [];
  fn((l) => lines.push(l));
  return lines;
}

describe("panel audit", () => {
  it("emits one line of valid JSON", () => {
    const [line] = capture((sink) =>
      audit({ action: "control.reset", operator: "lead@example.com", role: "superadmin", session: "S-1" }, sink),
    );
    expect(line!.includes("\n")).toBe(false);
    const rec = JSON.parse(line!);
    expect(rec.evt).toBe("panel.audit");
    expect(rec.action).toBe("control.reset");
    expect(rec.operator).toBe("lead@example.com");
    expect(rec.role).toBe("superadmin");
    expect(rec.session).toBe("S-1");
    expect(rec.outcome).toBe("ok");
    expect(typeof rec.ts).toBe("string");
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
  });

  it("omits session and detail when absent", () => {
    const [line] = capture((sink) => audit({ action: "auth.login", operator: "alice@example.com" }, sink));
    const rec = JSON.parse(line!);
    expect("session" in rec).toBe(false);
    expect("detail" in rec).toBe(false);
  });

  it("carries a denied outcome and detail", () => {
    const [line] = capture((sink) =>
      audit(
        { action: "force-release", operator: "alice@example.com", role: "operator", session: "S-2",
          outcome: "denied", detail: { required: "superadmin" } },
        sink,
      ),
    );
    const rec = JSON.parse(line!);
    expect(rec.outcome).toBe("denied");
    expect(rec.detail).toEqual({ required: "superadmin" });
  });

  it("drops undefined detail values rather than emitting nulls", () => {
    const [line] = capture((sink) =>
      audit({ action: "control.model", operator: "a@example.com", detail: { model: "m", mode: undefined } }, sink),
    );
    expect(JSON.parse(line!).detail).toEqual({ model: "m" });
  });
});
