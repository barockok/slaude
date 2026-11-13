import { describe, expect, spyOn, test } from "bun:test";
import { main } from "../../src/cli/domain";
import type { ReconcileReport } from "../../src/domain/reconcile";

const src = () => ({ created: 1, existing: 2, skipped: { grid: 1 } });
const report = (dryRun: boolean): ReconcileReport => ({
  dryRun,
  sources: { accounts: src(), slackIdentities: src(), grantUsers: src(), grantChannels: src(), sessionChannels: src(), auditActors: src() },
  conflicts: [{ kind: "email", accountId: "acc-1", heldByUserId: "usr-1" }],
  startedAt: 1,
  finishedAt: 2,
});

describe("slaude domain reconcile", () => {
  test("prints readable text, and passes --dry-run through", async () => {
    const lines: string[] = [];
    let seen: unknown;
    const code = await main(["reconcile", "--dry-run"], { out: (s) => lines.push(s), reconcile: async (o) => ((seen = o), report(true)) });
    expect(code).toBe(0);
    expect((seen as { dryRun: boolean }).dryRun).toBe(true);
    expect(lines[0]).toContain("dry run");
    expect(lines[0]).toContain("would create 1");
    expect(lines[0]).toContain("acc-1");
  });
  test("--json prints the report object", async () => {
    const lines: string[] = [];
    await main(["reconcile", "--json"], { out: (s) => lines.push(s), reconcile: async () => report(false) });
    expect(JSON.parse(lines[0]!).conflicts[0].accountId).toBe("acc-1");
  });
  test("bad usage exits 2", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main([])).toBe(2);
    expect(await main(["reconcile", "--nope"])).toBe(2);
    err.mockRestore();
  });
  test("a failure exits 1", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["reconcile"], { reconcile: async () => { throw new Error("x"); } })).toBe(1);
    err.mockRestore();
  });
});
