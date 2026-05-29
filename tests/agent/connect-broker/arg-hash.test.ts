import { describe, it, expect } from "bun:test";
import { canonicalArgsHash } from "../../../src/agent/connect-broker/arg-hash";

describe("canonicalArgsHash", () => {
  it("is stable regardless of key order", () => {
    const a = canonicalArgsHash("jira", "jira_search", { jql: "x", max: 10 });
    const b = canonicalArgsHash("jira", "jira_search", { max: 10, jql: "x" });
    expect(a).toBe(b);
  });

  it("changes when the tool changes", () => {
    expect(canonicalArgsHash("jira", "jira_search", { q: 1 }))
      .not.toBe(canonicalArgsHash("jira", "jira_delete", { q: 1 }));
  });

  it("changes when args change", () => {
    expect(canonicalArgsHash("jira", "t", { id: 1 }))
      .not.toBe(canonicalArgsHash("jira", "t", { id: 2 }));
  });
});
