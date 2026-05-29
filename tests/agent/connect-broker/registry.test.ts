import { describe, it, expect } from "bun:test";
import { getService, toolFlags, listServices } from "../../../src/agent/connect-broker/registry";

describe("registry", () => {
  it("exposes the jira service with a token auth strategy", () => {
    const svc = getService("jira");
    expect(svc?.auth_strategy).toBe("token");
    expect(svc?.spawn.command).toBeTruthy();
  });

  it("returns flags for a known tool", () => {
    const f = toolFlags("jira", "jira_search");
    expect(f.personal).toBe(true);
    expect(f.borrowable).toBe(true);
    expect(f.write).toBe(false);
  });

  it("marks a write tool non-borrowable", () => {
    const f = toolFlags("jira", "jira_delete_issue");
    expect(f.write).toBe(true);
    expect(f.borrowable).toBe(false);
  });

  it("fails closed for an unclassified tool (personal, non-borrowable, write)", () => {
    const f = toolFlags("jira", "totally_unknown_tool");
    expect(f).toEqual({ personal: true, borrowable: false, write: true });
  });

  it("returns null for an unknown service", () => {
    expect(getService("nope")).toBeNull();
    expect(listServices()).toContain("jira");
  });
});
