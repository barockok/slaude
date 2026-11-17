import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { __setBoundaryResolver, createBoundaryResolver, primeBoundary, resetBoundaryResolver } from "../../src/domain/boundary-for";
import { checkRow, classifyRow } from "../../src/domain/boundary-check";
import { resetBoundaryState } from "../helpers/boundary-state";
import { flushFirstSightWork } from "../../src/domain/first-sight-flush";
import { metrics } from "../../src/metrics";

const WS = "T0EXAMPLE";
const CH = "C0EXAMPLE";
const row = (over: Record<string, unknown> = {}) => ({ slack_team_id: WS, slack_channel_id: CH, slack_thread_ts: "1.1", boundary_id: null as string | null, locator: null as string | null, ...over });
const count = (site: string, outcome: string): number => {
  const l = metrics.render().split("\n").find((x) => x.startsWith("slaude_boundary_check_total") && x.includes(`site="${site}"`) && x.includes(`outcome="${outcome}"`));
  return l ? Number(l.split(" ").pop()) : 0;
};

describe("classifyRow (pure)", () => {
  const known = { id: "b1" };
  test("every outcome", () => {
    expect(classifyRow(row({ boundary_id: "b1", locator: "1.1" }), known)).toBe("match");
    expect(classifyRow(row(), null)).toBe("both_none");
    expect(classifyRow(row(), known)).toBe("null_row");
    expect(classifyRow(row(), undefined)).toBe("unresolved");
    expect(classifyRow(row({ boundary_id: "b2", locator: "1.1" }), known)).toBe("mismatch");
    expect(classifyRow(row({ boundary_id: "b1", locator: "9.9" }), known)).toBe("locator_mismatch");
    expect(classifyRow(row({ boundary_id: "b1", locator: "1.1" }), undefined)).toBe("unverified");
    expect(classifyRow(row({ boundary_id: "b1", locator: "9.9" }), undefined)).toBe("locator_mismatch");
    expect(classifyRow(row({ boundary_id: "b1", locator: null }), undefined)).toBe("locator_mismatch");
  });
});

describe("checkRow on the sessions paths", () => {
  beforeAll(async () => {
    await db.query("SELECT 1"); // opens the database and applies the migrations once, with room
  }, 60_000);
  const clean = async () => {
    await resetBoundaryState();
    await db.run("DELETE FROM sessions");
    await Domain._wipeForTests();
  };
  beforeEach(clean);
  afterEach(clean);

  test("a find counts one outcome, returns the legacy row unchanged, and a wrong boundary counts mismatch", async () => {
    const b = (await Domain.ensureBoundary({ service: "slack", workspace: WS, value: CH, kind: "channel", state: "observed" })).boundary.id;
    primeBoundary(WS, CH, b);
    const made = await Sessions.createForThread({ thread: { team_id: WS, channel_id: CH, thread_ts: "1.1" }, model: "m", working_dir: "/w" });
    const k = { team_id: WS, channel_id: CH, thread_ts: "1.1" };
    const before = count("find_by_thread", "match");
    const found = await Sessions.findByThread(k);
    expect(found).toEqual(made);
    expect(count("find_by_thread", "match")).toBe(before + 1);
    await db.run("UPDATE sessions SET boundary_id = 'b-wrong'");
    const m0 = count("find_any_by_thread", "mismatch");
    const again = await Sessions.findAnyByThread(k);
    expect(again!.id).toBe(made.id); // the legacy row comes back as it is (without the internal pair)
    expect(count("find_any_by_thread", "mismatch")).toBe(m0 + 1);
    await db.run("UPDATE sessions SET boundary_id = ?, locator = 'x'", [b]);
    const l0 = count("find_by_thread", "locator_mismatch");
    await Sessions.findByThread(k);
    expect(count("find_by_thread", "locator_mismatch")).toBe(l0 + 1);
  });

  test("a brand new thread: find returns none and counts nothing, create counts once on the row it wrote", async () => {
    const k = { team_id: WS, channel_id: CH, thread_ts: "2.2" };
    const sites = ["find_by_thread", "find_any_by_thread", "create"];
    const total = (): number => sites.reduce((n, s) => n + ["match", "both_none", "null_row", "unresolved", "mismatch", "locator_mismatch", "unverified"].reduce((m, o) => m + count(s, o), 0), 0);
    const t0 = total();
    expect(await Sessions.findByThread(k)).toBeNull();
    expect(total()).toBe(t0);
    await Sessions.createForThread({ thread: k, model: "m", working_dir: "/w" });
    expect(total()).toBe(t0 + 1);
  });

  test("a cold row is null_row or unresolved, never a failure", async () => {
    const k = { team_id: WS, channel_id: CH, thread_ts: "3.3" };
    await db.run("INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('s', 1, 1, 'm', '/w', ?, ?, '3.3')", [WS, CH]);
    const u0 = count("find_by_thread", "unresolved");
    expect((await Sessions.findByThread(k))!.id).toBe("s");
    expect(count("find_by_thread", "unresolved")).toBe(u0 + 1);
  });

  test("the check never awaits a query: a hung resolver does not delay a find", async () => {
    const hung = new Proxy(db, {
      get(t, kk, r) {
        const v = Reflect.get(t, kk, r);
        if (kk === "one" || kk === "query") return () => new Promise(() => {});
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    __setBoundaryResolver(createBoundaryResolver({ db: () => hung, role: () => "gateway", timeoutMs: () => 100 }));
    await db.run("INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('s', 1, 1, 'm', '/w', ?, ?, '4.4')", [WS, CH]);
    const got = await Promise.race([Sessions.findByThread({ team_id: WS, channel_id: CH, thread_ts: "4.4" }).then(() => "ok"), new Promise((r) => setTimeout(() => r("late"), 1000))]);
    expect(got).toBe("ok");
  });

  test("the kill switch and a thrown check leave the row alone", async () => {
    await db.run("INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('s', 1, 1, 'm', '/w', ?, ?, '5.5')", [WS, CH]);
    process.env.SLAUDE_BOUNDARY_WRITE = "off";
    const before = count("find_by_thread", "unresolved") + count("find_by_thread", "both_none");
    expect((await Sessions.findByThread({ team_id: WS, channel_id: CH, thread_ts: "5.5" }))!.id).toBe("s");
    expect(count("find_by_thread", "unresolved") + count("find_by_thread", "both_none")).toBe(before);
    expect(() => checkRow("find_by_thread", null as never)).not.toThrow();
    expect(() => checkRow("find_by_thread", { boundary_id: {} } as never)).not.toThrow();
    resetBoundaryResolver();
  });
});
