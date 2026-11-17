import { describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { SoulDataSchema } from "../../src/soul/data";

const FIXTURE = `name: ana
soul: Prose.
access:
  manager: slack:user:T0EXAMPLE/U0MGR
  backupManager: U0BAK
  approvers:
    - user: slack:user:U0APP
    - user: slack:user:T0EXAMPLE/U0OPS
      channel: slack:channel:C0OPS
      scope: deploys
  channels:
    public: [slack:channel:C0PUB]
    trusted: [C0TEAM]
  dm: [slack:user:U0DM]
  blocked: [slack:user:T0EXAMPLE/U0BAD]
`;

const compile = (text: string) => parseAgentYaml("ana", text).spec.definition.soulData;

describe("compile keeps the legacy arrays exactly (golden, captured before accessEntries)", () => {
  test("legacy fields", () => {
    const s = compile(FIXTURE);
    expect(s.manager).toEqual({ userId: "U0MGR" });
    expect(s.backupManager).toEqual({ userId: "U0BAK" });
    expect(s.approvers).toEqual([{ userId: "U0APP", scope: "anything", catchall: true }]);
    expect(s.allowedChannels).toEqual(["C0PUB"]);
    expect(s.trustedChannels).toEqual(["C0TEAM"]);
    expect(s.blockedUsers).toEqual(["U0BAD"]);
    expect(s.dmAllowedUsers).toEqual(["U0DM"]);
    expect(s.channelOverrides).toEqual([{ channel: "C0OPS", approvers: [{ userId: "U0OPS", scope: "deploys", catchall: false }] }]);
  });
});

describe("accessEntries", () => {
  test("defaults to an empty list", () => {
    expect(SoulDataSchema.parse({}).accessEntries).toEqual([]);
  });

  test("every Slack reference is kept with workspace, field, role, deny, dm-only and channel scope", () => {
    const e = compile(FIXTURE).accessEntries;
    const by = (field: string) => e.filter((x) => x.field === field);
    expect(by("manager")).toEqual([{ field: "manager", kind: "user", id: "U0MGR", workspace: "T0EXAMPLE", role: "manager", deny: false, dmOnly: false }]);
    expect(by("backupManager")).toEqual([{ field: "backupManager", kind: "user", id: "U0BAK", role: "manager", deny: false, dmOnly: false }]);
    expect(by("approvers")).toEqual([
      { field: "approvers", kind: "user", id: "U0APP", role: "approver", deny: false, dmOnly: false },
      { field: "approvers", kind: "user", id: "U0OPS", workspace: "T0EXAMPLE", role: "approver", deny: false, dmOnly: false, channel: "C0OPS" },
    ]);
    expect(by("channels.public")).toEqual([{ field: "channels.public", kind: "channel", id: "C0PUB", role: "member", deny: false, dmOnly: false }]);
    expect(by("channels.trusted")).toEqual([{ field: "channels.trusted", kind: "channel", id: "C0TEAM", role: "member", deny: false, dmOnly: false }]);
    expect(by("dm")).toEqual([{ field: "dm", kind: "user", id: "U0DM", role: "member", deny: false, dmOnly: true }]);
    expect(by("blocked")).toEqual([{ field: "blocked", kind: "user", id: "U0BAD", workspace: "T0EXAMPLE", role: "member", deny: true, dmOnly: false }]);
    expect(e).toHaveLength(8);
  });

  test("a definition with no access has none", () => {
    expect(compile("name: ana\nsoul: Prose.\n").accessEntries).toEqual([]);
  });

  test("email and user references stay refused at compile", () => {
    expect(() => compile("name: ana\nsoul: x\naccess:\n  manager: email:a@example.com\n")).toThrow(/cannot be resolved yet/);
    expect(() => compile("name: ana\nsoul: x\naccess:\n  dm: [user:abc]\n")).toThrow(/cannot be resolved yet/);
  });

  test("the entries and the legacy arrays name the same people", () => {
    const s = compile(FIXTURE);
    const ids = (field: string) => s.accessEntries.filter((x) => x.field === field).map((x) => x.id).sort();
    expect(ids("manager")).toEqual([s.manager.userId!]);
    expect(ids("backupManager")).toEqual([s.backupManager.userId!]);
    expect(ids("blocked")).toEqual([...s.blockedUsers].sort());
    expect(ids("dm")).toEqual([...s.dmAllowedUsers].sort());
    expect(ids("channels.public")).toEqual([...s.allowedChannels].sort());
    expect(ids("channels.trusted")).toEqual([...s.trustedChannels].sort());
    expect(ids("approvers")).toEqual([...s.approvers.map((a) => a.userId), ...s.channelOverrides.flatMap((c) => c.approvers.map((a) => a.userId))].sort());
  });
});

describe("collectRefs uses the written workspace", () => {
  test("a workspace-qualified entry carries its workspace to the sync records", async () => {
    const { collectRefs } = await import("../../src/domain/sync-refs");
    const s = compile(FIXTURE);
    const refs = collectRefs("ana", s, "Prose.");
    const mgr = refs.find((r) => r.field === "access.manager")!.ref;
    expect(mgr).toMatchObject({ id: "U0MGR", workspace: "T0EXAMPLE" });
    const bak = refs.find((r) => r.field === "access.backupManager")!.ref;
    expect((bak as { workspace?: string }).workspace).toBeUndefined();
  });
});
