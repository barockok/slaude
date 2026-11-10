import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { __setProactiveSoulSource, channelSessionOn, channelSessionWakes, parseProactive, proactiveChannels, proactiveFor, proactiveRead, wakeEligibility } from "../../src/soul/proactive";

const soul = `## Channel <#C111>
### Session
- Mode: channel
### Proactive
- Enabled: yes
- Max per day: 2
- Cooldown: 4 hours
- Highest: ask

## Channel <#C222>
### Proactive
- Enabled: yes

## Channel <#C333>
### Session
- Mode: nonsense
`;

afterEach(() => __setProactiveSoulSource(null));

describe("channel session mode", () => {
  test("parses Mode only under ### Session", () => {
    const c = parseProactive(soul);
    expect(c.sessions).toEqual({ C111: "channel" });
    expect(c.invalidSessions).toEqual(["C333"]);
  });
  test("a channel-mode channel leaves the agent-level wake and stays readable", () => {
    __setProactiveSoulSource(() => soul);
    expect(channelSessionOn("a", "C111")).toBe(true);
    expect(channelSessionOn("a", "C222")).toBe(false);
    expect(proactiveChannels("a")).toEqual(["C222"]);
    expect(channelSessionWakes("a")).toEqual(["C111"]);
    expect(proactiveRead("a")).toContain("C111");
  });
  test("per-channel limits do not apply in channel mode", () => {
    __setProactiveSoulSource(() => soul);
    const r = proactiveFor("a", "C111");
    expect(r.enabled).toBe(true);
    expect(r.highest).toBe("act");
    expect(r.cooldownHours).toBe(0);
    expect(r.maxPerPersonPerDay).toBe(Number.MAX_SAFE_INTEGER);
  });
  test("a channel session wakes whatever its Highest says; a classic channel still does not", () => {
    __setProactiveSoulSource(() => "## Channel <#C555>\n### Session\n- Mode: channel\n### Proactive\n- Enabled: yes\n- Highest: ask\n");
    expect(wakeEligibility("a", "U1")).toEqual({ ok: true });
    __setProactiveSoulSource(() => "## Channel <#C666>\n### Proactive\n- Enabled: yes\n- Highest: ask\n");
    expect(wakeEligibility("a", "U1")).toEqual({ ok: false, reason: "no-act-destination" });
  });
  test("Mode outside ### Session is ignored", () => {
    const c = parseProactive("## Channel <#C444>\n### Proactive\n- Mode: channel\n### Mandate\n- Mode: channel\n");
    expect(c.sessions).toEqual({});
    expect(c.invalidSessions).toEqual([]);
  });
  test("an invalid Mode is warned about once, and stays on today's behavior", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      __setProactiveSoulSource(() => soul);
      expect(channelSessionOn("a", "C333")).toBe(false);
      expect(channelSessionOn("a", "C333")).toBe(false);
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("persona=a");
      expect(lines[0]).toContain("C333");
    } finally {
      warn.mockRestore();
    }
  });
});
