import { describe, expect, test } from "bun:test";
import { loadUserNames, makeUsersCache, namesOf, USERS_RETRY_MS, USERS_TTL_MS } from "../../../src/gateway/engage/users";

const tick = () => new Promise((r) => setTimeout(r, 5));

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
});

describe("users cache", () => {
  test("unknown is the safe side: a name counts as shared until a snapshot says otherwise", async () => {
    const c = makeUsersCache();
    expect(c.sameNamed("T1", "sam")).toBe(true);
    c.ensure("T1", async () => new Set(["jane"]));
    await tick();
    expect(c.sameNamed("T1", "sam")).toBe(false);
    expect(c.sameNamed("T1", "jane")).toBe(true);
    expect(c.sameNamed("T2", "sam")).toBe(true);
  });
  test("a refresh is at most hourly and single-flight, a failure keeps the last snapshot and retries later", async () => {
    let t = 1_000_000;
    const c = makeUsersCache(() => t);
    let loads = 0;
    const ok = async () => (loads++, new Set(["jane"]));
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
    c.ensure("T1", async () => new Set(["sam"]));
    await tick();
    expect(c.sameNamed("T1", "sam")).toBe(true);
  });
});

describe("loadUserNames", () => {
  test("pages are followed within a bound; a partial list or a late answer is a failure", async () => {
    const pages = [{ ok: true, members: [{ id: "U1", name: "ana" }], response_metadata: { next_cursor: "c" } }, { ok: true, members: [{ id: "U2", name: "bo" }] }];
    let i = 0;
    expect([...(await loadUserNames({ users: { list: async () => pages[i++] } }))].sort()).toEqual(["ana", "bo"]);
    await expect(loadUserNames({ users: { list: async () => ({ ok: true, members: [], response_metadata: { next_cursor: "more" } }) } })).rejects.toThrow();
    await expect(loadUserNames({ users: { list: () => new Promise(() => {}) } }, 20)).rejects.toThrow();
    await expect(loadUserNames({ users: { list: async () => ({ ok: false }) } })).rejects.toThrow();
  });
});
