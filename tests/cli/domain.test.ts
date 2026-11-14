import { describe, expect, spyOn, test } from "bun:test";
import { main } from "../../src/cli/domain";
import type { ReconcileOptions, ReconcileReport } from "../../src/domain/reconcile";

const src = () => ({ created: 1, existing: 2, skipped: { grid: 1 } });
const report = (dryRun: boolean): ReconcileReport => ({
  dryRun,
  sources: { accounts: src(), slackIdentities: src(), grantUsers: src(), grantChannels: src(), sessionChannels: src(), auditActors: src() },
  conflicts: [{ kind: "email", accountId: "acc-1", heldByUserId: "usr-1" }],
  linkTokensPurged: 0,
  grantSubjects: { created: 0, existing: 0, skipped: {} },
  lockTeams: { created: 0, existing: 0, skipped: {} },
  workspaceGrants: { total: 1, mismatched: 1, rows: [{ grantId: "grant-1", teamId: "T0EXAMPLE" }], unjudged: 0 },
  unprovenEmails: { total: 2, byIssuer: { "https://idp.example.com": 2 }, demoted: 0, unaccounted: 0 },
  typedGrantSubjects: 0,
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
    expect(lines[0]).toContain("grant=grant-1 team=T0EXAMPLE");
  });
  test("--json prints the report object", async () => {
    const lines: string[] = [];
    await main(["reconcile", "--json"], { out: (s) => lines.push(s), reconcile: async () => report(false) });
    expect(JSON.parse(lines[0]!).conflicts[0].accountId).toBe("acc-1");
  });
  test("--demote-unproven-emails alone reports and does not ask for demotion", async () => {
    const lines: string[] = [];
    let seen: ReconcileOptions | undefined;
    const code = await main(["reconcile", "--demote-unproven-emails"], { out: (s) => lines.push(s), reconcile: async (o) => ((seen = o), report(false)) });
    expect(code).toBe(0);
    expect(seen?.demoteUnprovenEmails).toBeFalsy();
    expect(lines[0]).toContain("unproven email bindings: 2");
    expect(lines[0]).toContain("--demote-unproven-emails --apply");
  });
  test("--demote-unproven-emails --apply passes the demotion through", async () => {
    let seen: ReconcileOptions | undefined;
    await main(["reconcile", "--demote-unproven-emails", "--apply"], { out: () => {}, reconcile: async (o) => ((seen = o), report(false)) });
    expect(seen?.demoteUnprovenEmails).toBe(true);
    expect(seen?.dryRun).toBe(false);
  });
  test("a plain run never asks for demotion", async () => {
    let seen: ReconcileOptions | undefined;
    await main(["reconcile"], { out: () => {}, reconcile: async (o) => ((seen = o), report(false)) });
    expect(seen?.demoteUnprovenEmails).toBeFalsy();
  });
  test("--apply without the flag, or with --dry-run, is a usage error", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["reconcile", "--apply"])).toBe(2);
    expect(await main(["reconcile", "--demote-unproven-emails", "--apply", "--dry-run"])).toBe(2);
    err.mockRestore();
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
