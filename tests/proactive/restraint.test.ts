/**
 * Restraint rules (phase E, spec §10.4): one test per audience-ladder row and
 * per rule, plus the proactive post ledger.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Posts from "../../src/db/proactive-posts";
import { NO_PREFS, prefsFromProfile, type PingPrefs } from "../../src/proactive/prefs";
import { checkProactive, textHash, type ProactiveRequest, type RestraintContext } from "../../src/proactive/restraint";
import { parseProactive, type ResolvedProactive } from "../../src/soul/proactive";

const MGR = "U0MANAGER";
const NOW = new Date("2026-10-26T12:00:00Z"); // a Monday, noon UTC
const H = 3_600_000;

function configFrom(soul: string): (channelId?: string) => ResolvedProactive {
  const c = parseProactive(soul);
  return (ch) => {
    const { channels, ...g } = c;
    return ch !== undefined && channels[ch] !== undefined ? { ...g, enabled: channels[ch]! } : g;
  };
}
const ON = configFrom("## Proactive\n- Enabled: yes\n");
const OFF = configFrom("## Proactive\n- Enabled: no\n");

const ctx = (over: Partial<RestraintContext> = {}): RestraintContext => ({
  config: ON, managerId: MGR, prefs: NO_PREFS, now: NOW, timeZone: "UTC", history: [], ...over,
});
const req = (over: Partial<ProactiveRequest> = {}): ProactiveRequest => ({ audience: "manager", recipient: MGR, topic: "deploys", text: "Deploy 42 is stuck in review.", ...over });
const prefs = (m: Record<string, string>): PingPrefs => prefsFromProfile(m);
const rule = (r: ReturnType<typeof checkProactive>) => (r.ok ? "ok" : r.rule);

describe("audience ladder", () => {
  test("manager: on → ok; off → disabled; someone else as 'manager' → not-manager", () => {
    expect(rule(checkProactive(req(), ctx()))).toBe("ok");
    expect(rule(checkProactive(req(), ctx({ config: OFF })))).toBe("disabled");
    expect(rule(checkProactive(req({ recipient: "U0ALICE" }), ctx()))).toBe("not-manager");
    expect(rule(checkProactive(req(), ctx({ managerId: null })))).toBe("not-manager");
  });

  test("person: needs the switch, pings: yes, and a listed topic", () => {
    const p = req({ audience: "person", recipient: "U0ALICE" });
    const yes = prefs({ pings: "yes", topics: "deploys" });
    expect(rule(checkProactive(p, ctx({ prefs: yes })))).toBe("ok");
    expect(rule(checkProactive(p, ctx({ prefs: yes, config: OFF })))).toBe("disabled");
    expect(rule(checkProactive(p, ctx({ prefs: prefs({ pings: "no", topics: "deploys" }) })))).toBe("not-opted-in");
    expect(rule(checkProactive({ ...p, topic: "billing" }, ctx({ prefs: yes })))).toBe("topic-not-opted-in");
  });

  test("channel: its own block decides, either direction", () => {
    const both = configFrom("## Proactive\n- Enabled: no\n\n## Channel C0TEAMCHAN\n### Proactive\n- Enabled: yes\n\n## Channel C0QUIET\n### Proactive\n- Enabled: no\n");
    const onGlobal = configFrom("## Proactive\n- Enabled: yes\n\n## Channel C0QUIET\n### Proactive\n- Enabled: no\n");
    expect(rule(checkProactive(req({ audience: "channel", recipient: "C0TEAMCHAN" }), ctx({ config: both })))).toBe("ok");
    expect(rule(checkProactive(req({ audience: "channel", recipient: "C0OTHER" }), ctx({ config: both })))).toBe("channel-disabled");
    expect(rule(checkProactive(req({ audience: "channel", recipient: "C0QUIET" }), ctx({ config: onGlobal })))).toBe("channel-disabled");
    expect(rule(checkProactive(req({ audience: "channel", recipient: "C0OTHER" }), ctx({ config: onGlobal })))).toBe("ok");
  });
});

describe("rules", () => {
  test("mutes: a topic, or everything; never applied to a channel", () => {
    expect(rule(checkProactive(req(), ctx({ prefs: prefs({ mutes: "Deploys" }) })))).toBe("muted");
    expect(rule(checkProactive(req({ topic: "billing" }), ctx({ prefs: prefs({ mutes: "all" }) })))).toBe("muted");
    expect(rule(checkProactive(req({ audience: "channel", recipient: "C0TEAMCHAN" }), ctx({ prefs: prefs({ mutes: "all" }) })))).toBe("ok");
  });

  test("SOUL quiet hours across midnight, in the persona timezone", () => {
    const quiet = configFrom("## Proactive\n- Enabled: yes\n- Quiet hours: 21:00–08:00\n");
    expect(rule(checkProactive(req(), ctx({ config: quiet, now: new Date("2026-10-26T23:00:00Z") })))).toBe("quiet-hours");
    expect(rule(checkProactive(req(), ctx({ config: quiet, now: new Date("2026-10-26T07:59:00Z") })))).toBe("quiet-hours");
    expect(rule(checkProactive(req(), ctx({ config: quiet })))).toBe("ok");
    // Noon UTC is 19:00 in a +07:00 zone, 23:00 UTC is 06:00 there.
    expect(rule(checkProactive(req(), ctx({ config: quiet, timeZone: "Asia/Jakarta" })))).toBe("ok");
    expect(rule(checkProactive(req(), ctx({ config: quiet, timeZone: "Asia/Jakarta", now: new Date("2026-10-26T23:00:00Z") })))).toBe("quiet-hours");
  });

  test("the recipient's quiet hours, in their own timezone", () => {
    // Noon UTC is 21:00 in Tokyo.
    expect(rule(checkProactive(req(), ctx({ prefs: prefs({ quiet_hours: "20:00-07:00", timezone: "Asia/Tokyo" }) })))).toBe("quiet-hours");
    expect(rule(checkProactive(req(), ctx({ prefs: prefs({ quiet_hours: "20:00-07:00" }) })))).toBe("ok");
  });

  test("daily cap per local day; a post after local midnight is a new day", () => {
    const capped = configFrom("## Proactive\n- Enabled: yes\n- Max per person per day: 1\n- Cooldown: 0 hours\n");
    const earlier = [{ postedAt: NOW.getTime() - 5 * H, textHash: "x" }];
    expect(rule(checkProactive(req(), ctx({ config: capped, history: earlier })))).toBe("daily-cap");
    const yesterday = [{ postedAt: Date.parse("2026-10-25T23:59:00Z"), textHash: "x" }];
    expect(rule(checkProactive(req(), ctx({ config: capped, history: yesterday })))).toBe("ok");
  });

  test("cooldown since the last post", () => {
    const cool = configFrom("## Proactive\n- Enabled: yes\n- Max per person per day: 5\n- Cooldown: 4 hours\n");
    expect(rule(checkProactive(req(), ctx({ config: cool, history: [{ postedAt: NOW.getTime() - 3 * H, textHash: "x" }] })))).toBe("cooldown");
    expect(rule(checkProactive(req(), ctx({ config: cool, history: [{ postedAt: NOW.getTime() - 5 * H, textHash: "x" }] })))).toBe("ok");
  });

  test("unchanged: the same text within 7 days posts nothing", () => {
    const loose = configFrom("## Proactive\n- Enabled: yes\n- Max per person per day: 9\n- Cooldown: 0 hours\n");
    const h = textHash("Deploy 42 is stuck in review.");
    const at = (days: number) => [{ postedAt: NOW.getTime() - days * 24 * H, textHash: h }];
    expect(rule(checkProactive(req({ text: "*Deploy 42*  is stuck in REVIEW." }), ctx({ config: loose, history: at(2) })))).toBe("unchanged");
    expect(rule(checkProactive(req(), ctx({ config: loose, history: at(8) })))).toBe("ok");
  });

  test("unchanged: a reworded post resting on the same evidence posts nothing (seen with a live model)", () => {
    const loose = configFrom("## Proactive\n- Enabled: yes\n- Max per person per day: 9\n- Cooldown: 0 hours\n");
    const history = [{ postedAt: NOW.getTime() - 26 * H, textHash: textHash("Deploy 42 is stuck."), evidenceHash: textHash("investigations/deploy-42") }];
    const reworded = req({ text: "Still no movement on deploy 42; it needs a look.", evidence: "investigations/deploy-42" });
    expect(rule(checkProactive(reworded, ctx({ config: loose, history })))).toBe("unchanged");
    expect(rule(checkProactive({ ...reworded, evidence: "investigations/other" }, ctx({ config: loose, history })))).toBe("ok");
    expect(rule(checkProactive({ ...reworded, evidence: undefined }, ctx({ config: loose, history })))).toBe("ok");
  });

  test("textHash ignores Slack markup, case and spacing", () => {
    expect(textHash("See <#C0TEAMCHAN|team-channel> and <@U0ALICE>")).toBe(textHash("see  team-channel and U0ALICE"));
    expect(textHash("a")).not.toBe(textHash("b"));
  });
});

describe("proactive post ledger", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM proactive_posts");
  });

  test("record, recent by recipient, find by message", async () => {
    const base = { agentId: "A1", audience: "manager" as const, recipient: MGR, topic: "deploys", textHash: "h", evidenceHash: "e", channelId: "D0DM", teamId: "T0TEAM" };
    const id = await Posts.recordPost({ ...base, messageTs: "1.1", postedAt: NOW.getTime() });
    await Posts.recordPost({ ...base, messageTs: "1.2", postedAt: NOW.getTime() - 10 * 24 * H });
    await Posts.recordPost({ ...base, recipient: "U0OTHER", messageTs: "1.3", postedAt: NOW.getTime() });
    const recent = await Posts.recentFor("A1", MGR, NOW.getTime() - 7 * 24 * H);
    expect(recent.map((p) => p.messageTs)).toEqual(["1.1"]);
    expect(await Posts.findByMessage("D0DM", "1.1")).toMatchObject({ id, topic: "deploys", recipient: MGR });
    expect(await Posts.findByMessage("D0DM", "9.9")).toBeNull();
  });
});
