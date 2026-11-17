import { describe, expect, test } from "bun:test";
import { loadUserNames, makeUsersCache, namesOf, USERS_RETRY_MS, USERS_TTL_MS, USERS_WARN_MS, type UsersSnapshot } from "../../../src/gateway/engage/users";

const tick = () => new Promise((r) => setTimeout(r, 5));
const snap = (names: string[], complete = true): UsersSnapshot => ({ names: new Set(names), complete });

describe("namesOf", () => {
  test("names and first names of people; bots, deactivated users and Slackbot are skipped", () => {
    const n = namesOf([
      { id: "U1", name: "jane.doe", real_name: "Jane Doe", profile: { display_name: "Janey" } },
      { id: "U2", name: "samsbot", is_bot: true },
      { id: "U3", name: "gone", deleted: true },
      { id: "USLACKBOT", name: "slackbot" },
    ]);
    expect([...n].sort()).toEqual(["doe", "jane", "jane doe", "jane.doe", "janey"].sort());
  });
  test("the agent's own user ids are left out, so a persona posting as a real user is not its own namesake", () => {
    const members = [{ id: "UAGENT", name: "sam", real_name: "Sam" }, { id: "U9", name: "jane" }];
    expect([...namesOf(members, new Set(["UAGENT"]))]).toEqual(["jane"]);
    expect(namesOf(members).has("sam")).toBe(true);
  });
});

describe("users cache", () => {
  test("unknown is the safe side: a name counts as shared until a snapshot says otherwise", async () => {
    const c = makeUsersCache();
    expect(c.sameNamed("T1", "sam")).toBe(true);
    c.ensure("T1", async () => snap(["jane"]));
    await tick();
    expect(c.sameNamed("T1", "sam")).toBe(false);
    expect(c.sameNamed("T1", "jane")).toBe(true);
    expect(c.sameNamed("T2", "sam")).toBe(true);
  });
  test("a partial snapshot treats a missing name as shared, and is retried sooner", async () => {
    let t = 1_000_000;
    const c = makeUsersCache(() => t);
    let loads = 0;
    c.ensure("T1", async () => (loads++, snap(["jane"], false)));
    await tick();
    expect(c.sameNamed("T1", "sam")).toBe(true);
    t += USERS_RETRY_MS;
    c.ensure("T1", async () => (loads++, snap(["jane"], true)));
    await tick();
    expect(loads).toBe(2);
    expect(c.sameNamed("T1", "sam")).toBe(false);
  });
  test("a refresh is at most hourly and single-flight, a failure keeps the last snapshot and retries later", async () => {
    let t = 1_000_000;
    const c = makeUsersCache(() => t, () => {});
    let loads = 0;
    const ok = async () => (loads++, snap(["jane"]));
    c.ensure("T1", ok);
    c.ensure("T1", ok);
    await tick();
    expect(loads).toBe(1);
    t += USERS_TTL_MS - 1;
    c.ensure("T1", ok);
    await tick();
    expect(loads).toBe(1);
    t += 1;
    let fail = 0;
    c.ensure("T1", async () => (fail++, Promise.reject(new Error("down"))));
    await tick();
    expect(c.sameNamed("T1", "jane")).toBe(true);
    expect(c.sameNamed("T1", "sam")).toBe(false);
    c.ensure("T1", async () => (fail++, Promise.reject(new Error("down"))));
    await tick();
    expect(fail).toBe(1);
    t += USERS_RETRY_MS;
    c.ensure("T1", async () => snap(["sam"]));
    await tick();
    expect(c.sameNamed("T1", "sam")).toBe(true);
  });
  test("one warning per team per hour on failure, with the error code only (a missing scope reads as missing_scope)", async () => {
    let t = 1_000_000;
    const lines: string[] = [];
    const c = makeUsersCache(() => t, (l) => lines.push(l));
    const down = async () => { throw Object.assign(new Error("secret detail xoxb-123"), { data: { error: "missing_scope" } }); };
    c.ensure("T1", down);
    await tick();
    t += USERS_RETRY_MS;
    c.ensure("T1", down);
    await tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("code=missing_scope");
    expect(lines[0]).not.toContain("xoxb");
    t += USERS_WARN_MS;
    c.ensure("T1", down);
    await tick();
    c.ensure("T2", down);
    await tick();
    expect(lines).toHaveLength(3);
  });
});

describe("loadUserNames", () => {
  const page = (names: string[], next = "") => ({ ok: true, members: names.map((n, i) => ({ id: `U${n}${i}`, name: n })), response_metadata: { next_cursor: next } });
  test("pages are followed and a workspace past the bound is partial, not an error", async () => {
    const pages = [page(["ana"], "c1"), page(["bo"])];
    let i = 0;
    const r = await loadUserNames({ users: { list: async () => pages[i++] } });
    expect([...r.names].sort()).toEqual(["ana", "bo"]);
    expect(r.complete).toBe(true);
    let calls = 0;
    const long = await loadUserNames({ users: { list: async () => (calls++, page([`n${calls}`], "more")) } });
    expect(calls).toBe(5);
    expect(long.complete).toBe(false);
    expect(long.names.size).toBe(5);
  });
  test("a page that fails or is late after the first keeps what was read; the first page failing throws", async () => {
    let n = 0;
    const r = await loadUserNames({ users: { list: async () => (n++ === 0 ? page(["ana"], "c1") : Promise.reject(Object.assign(new Error("x"), { data: { error: "ratelimited" } }))) } });
    expect([...r.names]).toEqual(["ana"]);
    expect(r.complete).toBe(false);
    n = 0;
    const late = await loadUserNames({ users: { list: () => (n++ === 0 ? Promise.resolve(page(["ana"], "c1")) : new Promise(() => {})) } }, { pageDeadlineMs: 20 });
    expect(late.complete).toBe(false);
    await expect(loadUserNames({ users: { list: () => new Promise(() => {}) } }, { pageDeadlineMs: 20 })).rejects.toThrow();
    await expect(loadUserNames({ users: { list: async () => ({ ok: false, error: "missing_scope" }) } })).rejects.toThrow();
  });
  test("the total deadline stops the read and the agent's ids are excluded", async () => {
    const r = await loadUserNames({ users: { list: async () => ({ ok: true, members: [{ id: "UAGENT", name: "sam" }, { id: "U2", name: "bo" }] }) } }, { exclude: new Set(["UAGENT"]) });
    expect([...r.names]).toEqual(["bo"]);
    let calls = 0;
    const slow = await loadUserNames({ users: { list: async () => (calls++, await new Promise((res) => setTimeout(res, 30)), page([`n${calls}`], "more")) } }, { totalDeadlineMs: 50, pageDeadlineMs: 40 });
    expect(slow.complete).toBe(false);
    expect(calls).toBeLessThan(5);
  });
});
