import { describe, expect, test } from "bun:test";
import {
  ALWAYS_OWNER_ONLY,
  DEFAULT_OWNER_ONLY_TOOLS,
  innerToolNames,
  isNamedGuestTurn,
  ownerOnlyMatch,
  parseOwnerOnlyRules,
  readsAsReadOnly,
  speakerRole,
} from "../../src/agent/guests";

const MGRS = ["U0MGR", "U0BACKUP"];
const locked = (guests?: string[]) => ({ locked_user: "U0OWNER", open_scope: null, ...(guests ? { guests } : {}) });
const open = { locked_user: "U0OWNER", open_scope: "read-only", guests: [] };

describe("speakerRole", () => {
  test("owner, manager, named guest, not heard", () => {
    const l = locked(["U0QA"]);
    expect(speakerRole(l, "U0OWNER", MGRS)).toBe("owner");
    expect(speakerRole(l, "U0MGR", MGRS)).toBe("manager");
    expect(speakerRole(l, "U0BACKUP", MGRS)).toBe("manager");
    expect(speakerRole(l, "U0QA", MGRS)).toBe("guest");
    expect(speakerRole(l, "U0OTHER", MGRS)).toBeNull();
  });
  test("open mode: everyone else is a guest", () => {
    expect(speakerRole(open, "U0OTHER", MGRS)).toBe("guest");
    expect(speakerRole(open, "U0OWNER", MGRS)).toBe("owner");
  });
  test("no lock or no user → null", () => {
    expect(speakerRole(null, "U0QA", MGRS)).toBeNull();
    expect(speakerRole(locked(["U0QA"]), undefined, MGRS)).toBeNull();
  });
  test("an owner who is also a manager is the owner; empty manager ids never match", () => {
    expect(speakerRole({ ...locked(), locked_user: "U0MGR" }, "U0MGR", MGRS)).toBe("owner");
    expect(speakerRole(locked(), "U0X", [undefined, null, ""])).toBeNull();
  });
});

describe("isNamedGuestTurn", () => {
  test("only an invited guest of a LOCKED 1on1", () => {
    expect(isNamedGuestTurn(locked(["U0QA"]), "U0QA", MGRS)).toBe(true);
    expect(isNamedGuestTurn(locked(["U0QA"]), "U0OWNER", MGRS)).toBe(false);
    expect(isNamedGuestTurn(locked(["U0QA"]), "U0MGR", MGRS)).toBe(false);
    // Open mode keeps its model-enforced scope.
    expect(isNamedGuestTurn(open, "U0OTHER", MGRS)).toBe(false);
    expect(isNamedGuestTurn(null, "U0QA", MGRS)).toBe(false);
  });
});

describe("parseOwnerOnlyRules", () => {
  const sources = (raw?: string) => parseOwnerOnlyRules(raw).map((r) => r.source);
  test("unset or blank → always-owner-only + defaults", () => {
    expect(sources(undefined)).toEqual([...ALWAYS_OWNER_ONLY, ...DEFAULT_OWNER_ONLY_TOOLS]);
    expect(sources("  ")).toEqual([...ALWAYS_OWNER_ONLY, ...DEFAULT_OWNER_ONLY_TOOLS]);
  });
  test("none → only the always-owner-only tools", () => {
    expect(sources("none")).toEqual([...ALWAYS_OWNER_ONLY]);
  });
  test("a list replaces the defaults; a leading + adds to them", () => {
    expect(sources("Bash, mcp__x__y")).toEqual([...ALWAYS_OWNER_ONLY, "Bash", "mcp__x__y"]);
    expect(sources("+Bash")).toEqual([...ALWAYS_OWNER_ONLY, ...DEFAULT_OWNER_ONLY_TOOLS, "Bash"]);
  });
});

describe("ownerOnlyMatch", () => {
  const rules = parseOwnerOnlyRules(undefined);
  const m = (tool: string, input: unknown = {}) => ownerOnlyMatch(tool, input, rules)?.source ?? null;

  test("default list: file writes and the sandbox/git tools of any server", () => {
    expect(m("Write")).toBe("Write");
    expect(m("Edit")).toBe("Edit");
    expect(m("mcp__sandbox__git_push")).toBe("mcp__*__git_push");
    expect(m("mcp__dev_box__git_commit")).toBe("mcp__*__git_commit");
    expect(m("mcp__sandbox__sandbox_lease")).toBe("mcp__*__sandbox_lease");
    expect(m("mcp__sandbox__delete_path")).toBe("mcp__*__delete_path");
  });
  test("reads, tests and the agent's own surface stay with the guest", () => {
    expect(m("Read")).toBeNull();
    expect(m("Bash")).toBeNull();
    expect(m("mcp__sandbox__run_tests")).toBeNull();
    expect(m("mcp__sandbox__read_file")).toBeNull();
    expect(m("mcp__slaude_surface__reply")).toBeNull();
    // Globs are anchored: a longer name is not a match.
    expect(m("mcp__sandbox__git_push_status")).toBeNull();
    expect(m("WriteNotes")).toBeNull();
  });
  test("always owner-only: changing the 1on1 and scheduling jobs", () => {
    expect(m("mcp__slaude_surface__set_one_on_one")).toBe("mcp__slaude_surface__set_one_on_one");
    expect(m("mcp__slaude_runtime__add_cron_job")).toBe("mcp__slaude_runtime__add_cron_job");
    expect(ownerOnlyMatch("mcp__slaude_runtime__edit_cron_job", {}, parseOwnerOnlyRules("none"))).not.toBeNull();
  });
  test("workbench execute_tools: gated when an inner call is a write", () => {
    const ex = (...tools: string[]) => ({ executions: tools.map((tool) => ({ tool, args: {} })) });
    expect(m("mcp__workbench__execute_tools", ex("JIRA_GET_ISSUE", "GITHUB_LIST_PULL_REQUESTS"))).toBeNull();
    expect(m("mcp__workbench__execute_tools", ex("JIRA_GET_ISSUE", "GITHUB_CREATE_ISSUE"))).toBe("mcp__workbench__execute_tools>:write");
    // A name that names no read verb is a write: unknown means the owner asks.
    expect(m("mcp__workbench__execute_tools", ex("FOO_SYNC"))).not.toBeNull();
    // Inner calls that cannot be read: fail closed.
    expect(m("mcp__workbench__execute_tools", {})).not.toBeNull();
    expect(m("mcp__workbench__execute_tools", { executions: [{ args: {} }] })).not.toBeNull();
    // Another server's execute_tools is not on the default list.
    expect(m("mcp__other__execute_tools", ex("GITHUB_CREATE_ISSUE"))).toBeNull();
  });
  test("an inner glob, and a plain meta-tool entry that gates every call", () => {
    const ex = (tool: string) => ({ executions: [{ tool }] });
    const r1 = parseOwnerOnlyRules("mcp__workbench__execute_tools>jira_*");
    expect(ownerOnlyMatch("mcp__workbench__execute_tools", ex("JIRA_GET_ISSUE"), r1)).not.toBeNull();
    expect(ownerOnlyMatch("mcp__workbench__execute_tools", ex("GITHUB_GET_REPO"), r1)).toBeNull();
    const r2 = parseOwnerOnlyRules("mcp__workbench__execute_tools");
    expect(ownerOnlyMatch("mcp__workbench__execute_tools", ex("JIRA_GET_ISSUE"), r2)).not.toBeNull();
  });
});

describe("readsAsReadOnly / innerToolNames", () => {
  test("read verbs without write verbs; camelCase is split", () => {
    expect(readsAsReadOnly("JIRA_GET_ISSUE")).toBe(true);
    expect(readsAsReadOnly("searchMessages")).toBe(true);
    expect(readsAsReadOnly("GITHUB_GET_AND_DELETE")).toBe(false);
    expect(readsAsReadOnly("createIssue")).toBe(false);
    expect(readsAsReadOnly("BUDGET_UPDATE")).toBe(false);
    expect(readsAsReadOnly("noop")).toBe(false);
  });
  test("executions[].tool only", () => {
    expect(innerToolNames({ executions: [{ tool: "A" }, { tool: "B" }] })).toEqual(["A", "B"]);
    expect(innerToolNames({ executions: [] })).toBeNull();
    expect(innerToolNames(null)).toBeNull();
    expect(innerToolNames({ executions: [{ tool: 3 }] })).toBeNull();
  });
});
