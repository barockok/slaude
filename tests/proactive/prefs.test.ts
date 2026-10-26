import { describe, expect, it } from "bun:test";
import { composePage } from "../../src/knowledge/memory-pages";
import { SUPERSEDED_TAG } from "../../src/knowledge/memory-trail";
import { profileSourceId, type BrainScope } from "../../src/knowledge/scope";
import { muted, NO_PREFS, optedIn, prefsFromProfile, readPingPrefs } from "../../src/proactive/prefs";
import { fakeBrain } from "../memory/fake-brain";

const NOW = new Date("2026-10-26T12:00:00Z");
const scopeOf = (source: string): BrainScope => ({ clientId: "test", sourceId: source, allowedSources: [source] });

function profile(fields: Record<string, string>): string {
  const c = composePage({ slug: "profile", content: "Prefers short answers.", type: "profile", subject: "U0ALICE", fields }, NOW);
  if ("error" in c) throw new Error(c.error);
  return c.content;
}

describe("prefsFromProfile", () => {
  it("reads every field", () => {
    expect(
      prefsFromProfile({ pings: "yes", topics: "deploys, Oncall ,", mutes: "release notes", quiet_hours: "21:00-08:00", timezone: "Asia/Jakarta" }),
    ).toEqual({ pings: true, topics: ["deploys", "oncall"], mutes: ["release notes"], quietHours: { start: 21 * 60, end: 8 * 60 }, timeZone: "Asia/Jakarta" });
  });

  it("is lenient: junk is ignored, never thrown", () => {
    expect(prefsFromProfile({ pings: "sure", quiet_hours: "evenings", timezone: "Mars/Olympus" })).toEqual(NO_PREFS);
    expect(prefsFromProfile({})).toEqual(NO_PREFS);
  });

  it("mutes: all mutes everything", () => {
    const p = prefsFromProfile({ mutes: "All" });
    expect(p.mutes).toBe("all");
    expect(muted(p, "anything")).toBe(true);
  });
});

describe("muted / optedIn", () => {
  const p = prefsFromProfile({ pings: "yes", topics: "deploys, oncall", mutes: "flaky tests" });
  it("matches topics case-insensitively and trimmed", () => {
    expect(optedIn(p, "  Deploys ")).toBe(true);
    expect(optedIn(p, "billing")).toBe(false);
    expect(muted(p, "Flaky Tests")).toBe(true);
    expect(muted(p, "deploys")).toBe(false);
  });

  it("no pings means not opted in, whatever the topics", () => {
    expect(optedIn(prefsFromProfile({ topics: "deploys" }), "deploys")).toBe(false);
  });

  it("an empty topic never matches", () => {
    expect(optedIn(p, " ")).toBe(false);
    expect(muted(p, "")).toBe(false);
  });
});

describe("readPingPrefs", () => {
  it("reads only the person's own profile source", async () => {
    const b = fakeBrain();
    const seen: string[][] = [];
    const call = async (n: string, params: Record<string, unknown>, s: BrainScope) => {
      seen.push(s.allowedSources);
      return b.call(n, params, s);
    };
    await b.call("put_page", { slug: "profile", content: profile({ pings: "yes", topics: "deploys" }) }, scopeOf(profileSourceId("T0TEAM", "U0ALICE")));
    await b.call("put_page", { slug: "profile", content: profile({ pings: "no" }) }, scopeOf(profileSourceId("T0TEAM", "U0BOB")));
    const p = await readPingPrefs(call, "T0TEAM", "U0ALICE");
    expect(p.pings).toBe(true);
    expect(p.topics).toEqual(["deploys"]);
    expect(seen).toEqual([[profileSourceId("T0TEAM", "U0ALICE")]]);
  });

  it("no profile, no team, or a brain failure reads as no prefs", async () => {
    const b = fakeBrain();
    expect(await readPingPrefs(b.call, "T0TEAM", "U0NOBODY")).toEqual(NO_PREFS);
    expect(await readPingPrefs(b.call, null, "U0ALICE")).toEqual(NO_PREFS);
    const boom = async () => {
      throw new Error("brain down");
    };
    expect(await readPingPrefs(boom, "T0TEAM", "U0ALICE")).toEqual(NO_PREFS);
  });

  it("a superseded profile is ignored", async () => {
    const b = fakeBrain();
    const src = profileSourceId("T0TEAM", "U0ALICE");
    await b.call("put_page", { slug: "profile", content: profile({ pings: "yes" }) }, scopeOf(src));
    await b.call("add_tag", { slug: "profile", tag: SUPERSEDED_TAG }, scopeOf(src));
    // The fake brain returns only content; a gbrain record carries tags.
    const call = async (n: string, params: Record<string, unknown>, s: BrainScope) => {
      const r = (await b.call(n, params, s)) as Record<string, unknown> | null;
      return n === "get_page" && r ? { ...r, tags: [SUPERSEDED_TAG] } : r;
    };
    expect(await readPingPrefs(call, "T0TEAM", "U0ALICE")).toEqual(NO_PREFS);
  });
});
