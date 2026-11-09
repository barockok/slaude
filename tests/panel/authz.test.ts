import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { requireSuperadmin, SUPERADMIN_ACTIONS } from "../../src/gateway/panel/api";

beforeEach(() => {
  process.env.SLAUDE_PANEL_SECRET = "a".repeat(32);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
});

describe("superadmin action set", () => {
  it("gates exactly reset, mode, force-release, reload, the persona changes, grant changes, private memory, console roles, skill retire and restore, and every guardrail write", () => {
    expect([...SUPERADMIN_ACTIONS].sort()).toEqual([
      "console.roles.read", "control.mode", "control.reset", "force-release", "grant.create", "grant.revoke", "guardrail.create", "guardrail.delete", "guardrail.edit", "guardrail.override.clear", "guardrail.toggle", "memory.private", "persona.create", "persona.override", "reload", "skill.restore", "skill.retire", "skill.version.private",
    ]);
  });

  it("leaves stop, model and unlock-1on1 to any operator", () => {
    for (const a of ["control.stop", "control.model", "control.unlock-1on1"]) {
      expect(SUPERADMIN_ACTIONS.has(a)).toBe(false);
    }
  });
});

describe("requireSuperadmin", () => {
  it("passes a superadmin through", () => {
    expect(requireSuperadmin("superadmin", { action: "control.reset", operator: "lead@example.com" })).toBeNull();
  });

  it("403s an operator with the required role named", async () => {
    const res = requireSuperadmin("operator", { action: "control.reset", operator: "alice@example.com", session: "S-1" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: string; required: string };
    expect(body.error).toContain("superadmin");
    expect(body.required).toBe("superadmin");
  });
});
