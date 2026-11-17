/**
 * Slice C task 22: `email:` and `user:` references in agent.yaml access fields.
 * Accepted only while SLAUDE_ACCESS_SOURCE=internal; under any other value (the
 * default is shadow) they are refused with the same message as before, so no
 * inert email grant exists while the legacy readers are authoritative. An
 * accepted reference lives in `accessRefs`, never in the Slack-id arrays.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deriveSoulGrants } from "../../src/access/grants";
import { collectRefs } from "../../src/domain/sync-refs";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { channelApproversOf } from "../../src/soul/per-persona";

const DOC = `name: ana
soul: Prose.
access:
  manager: email:Boss@Example.com
  backupManager: slack:user:T0EXAMPLE/U0BAK
  approvers:
    - user: email:lead@example.com
    - user: slack:user:U0APP
    - user: email:ops@example.com
      channel: slack:channel:C0OPS
  dm: [user:u-123, slack:user:U0DM]
  blocked: [email:spam@example.com]
`;
const compile = (text: string) => parseAgentYaml("ana", text).spec.definition.soulData;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.SLAUDE_ACCESS_SOURCE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
  else process.env.SLAUDE_ACCESS_SOURCE = saved;
});

describe("refused unless the source is internal", () => {
  for (const source of ["unset", "shadow", "legacy", "bogus"]) {
    test(`${source}: the existing message`, () => {
      if (source === "unset") delete process.env.SLAUDE_ACCESS_SOURCE;
      else process.env.SLAUDE_ACCESS_SOURCE = source;
      expect(() => compile(DOC)).toThrow(/cannot be resolved yet/);
      expect(() => compile("name: ana\nsoul: x\naccess:\n  manager: email:a@example.com\n")).toThrow(/access\.manager.*'email'.*cannot be resolved yet/);
      expect(() => compile("name: ana\nsoul: x\naccess:\n  dm: [user:abc]\n")).toThrow(/cannot be resolved yet/);
    });
  }
});

describe("accepted under internal", () => {
  beforeEach(() => {
    process.env.SLAUDE_ACCESS_SOURCE = "internal";
  });

  test("a reference is kept in accessRefs and never in the Slack-id arrays", () => {
    const s = compile(DOC);
    expect(s.manager).toEqual({});
    expect(s.backupManager).toEqual({ userId: "U0BAK" });
    expect(s.approvers.map((a) => a.userId)).toEqual(["U0APP"]);
    expect(s.dmAllowedUsers).toEqual(["U0DM"]);
    expect(s.blockedUsers).toEqual([]);
    expect(s.channelOverrides.flatMap((c) => c.approvers.map((a) => a.userId))).toEqual([]);
    const all = JSON.stringify([s.manager, s.backupManager, s.approvers, s.dmAllowedUsers, s.blockedUsers, s.channelOverrides]);
    expect(all).not.toContain("email:");
    expect(all).not.toContain("example.com");
    const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    expect([...s.accessRefs].sort(byJson)).toEqual([
      { field: "manager", ref: { service: "email", address: "boss@example.com" }, role: "manager", deny: false, dmOnly: false },
      { field: "approvers", ref: { service: "email", address: "lead@example.com" }, role: "approver", deny: false, dmOnly: false },
      { field: "approvers", ref: { service: "email", address: "ops@example.com" }, role: "approver", deny: false, dmOnly: false, channel: "C0OPS" },
      { field: "dm", ref: { service: "user", userId: "u-123" }, role: "member", deny: false, dmOnly: true },
      { field: "blocked", ref: { service: "email", address: "spam@example.com" }, role: "member", deny: true, dmOnly: false },
    ].sort(byJson) as never);
  });

  test("the Slack entries are untouched", () => {
    const s = compile(DOC);
    expect(s.accessEntries.map((e) => e.id).sort()).toEqual(["U0APP", "U0BAK", "U0DM"]);
  });

  test("the references become grants with typed subjects, beside the Slack ones", () => {
    const s = compile(DOC);
    const grants = deriveSoulGrants(s, channelApproversOf(s));
    const typed = grants.filter((g) => g.subject?.service !== "slack");
    const rows = typed.map((g) => [g.subjectId, g.role, g.deny, g.dmOnly, g.channelId ?? null, g.source] as const).sort((a, b) => a[0].localeCompare(b[0]));
    expect(rows).toEqual([
      ["email:boss@example.com", "manager", false, false, null, "soul"],
      ["email:lead@example.com", "approver", false, false, null, "soul"],
      ["email:ops@example.com", "approver", false, false, "C0OPS", "soul"],
      ["email:spam@example.com", "member", true, false, null, "soul"],
      ["user:u-123", "member", false, true, null, "soul"],
    ]);
    expect(typed.find((g) => g.subjectId === "email:boss@example.com")!.subject).toEqual({ service: "email", address: "boss@example.com" });
    expect(typed.find((g) => g.subjectId === "user:u-123")!.subject).toEqual({ service: "user", userId: "u-123" });
    expect(grants.some((g) => g.subjectId === "U0BAK" && g.role === "manager")).toBe(true);
  });

  test("a definition sync carries each reference as a declared record", () => {
    const s = compile(DOC);
    const uses = collectRefs("ana", s, "");
    const kinds = uses.filter((u) => u.ref.kind === "email" || u.ref.kind === "internal").map((u) => (u.ref.kind === "email" ? `email:${u.ref.address}` : `user:${(u.ref as { id: string }).id}`));
    expect(kinds.sort()).toEqual(["email:boss@example.com", "email:lead@example.com", "email:ops@example.com", "email:spam@example.com", "user:u-123"]);
  });

  test("a malformed reference is still refused, naming the field and never the value", () => {
    expect(() => compile("name: ana\nsoul: x\naccess:\n  manager: email:not-an-address\n")).toThrow(/access\.manager/);
    let msg = "";
    try {
      compile("name: ana\nsoul: x\naccess:\n  manager: email:secret@@example.com\n");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain("secret");
  });

  test("a phone or other service in a user field is still refused", () => {
    expect(() => compile("name: ana\nsoul: x\naccess:\n  dm: [whatsapp:phone:+15551230000]\n")).toThrow(/cannot be resolved yet/);
  });

  test("a definition with Slack references only compiles exactly as before", () => {
    const text = "name: ana\nsoul: x\naccess:\n  manager: slack:user:T0EXAMPLE/U0MGR\n  dm: [slack:user:U0DM]\n";
    const before = compile(text);
    expect(before.accessRefs).toEqual([]);
    delete process.env.SLAUDE_ACCESS_SOURCE;
    const after = compile(text);
    expect(after.accessRefs).toEqual([]);
    expect(JSON.stringify({ ...before, accessRefs: [] })).toBe(JSON.stringify({ ...after, accessRefs: [] }));
  });
});
