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
  test.each([
    ["valid first", "## Channel <#C777>\n### Session\n- Mode: channel\n- Mode: off\n"],
    ["invalid first", "## Channel <#C777>\n### Session\n- Mode: off\n- Mode: channel\n"],
    ["valid heading first", "## Channel <#C777>\n### Session\n- Mode: channel\n\n## Channel <#C777>\n### Session\n- Mode: off\n"],
    ["invalid heading first", "## Channel <#C777>\n### Session\n- Mode: off\n\n## Channel <#C777>\n### Session\n- Mode: channel\n"],
  ])("a contradictory Mode reads as off: %s", (_name, text) => {
    const c = parseProactive(text);
    expect(c.sessions).toEqual({});
    expect(c.invalidSessions).toEqual(["C777"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      __setProactiveSoulSource(() => text);
      expect(channelSessionOn("a", "C777")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
  test("a channel with several invalid Modes appears once and warns once", () => {
    const text = "## Channel <#C777>\n### Session\n- Mode: off\n- Mode: nonsense\n";
    expect(parseProactive(text).invalidSessions).toEqual(["C777"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      __setProactiveSoulSource(() => text);
      channelSessionOn("a", "C777");
      expect(warn.mock.calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
  test("a Mode after another ### heading is not channel mode", () => {
    const c = parseProactive("## Channel <#C444>\n### Session\n### Other\n- Mode: channel\n");
    expect(c.sessions).toEqual({});
    expect(c.invalidSessions).toEqual([]);
  });
  test("Enabled under ### Session is ignored", () => {
    const c = parseProactive("## Channel <#C444>\n### Session\n- Enabled: yes\n");
    expect(c.channels).toEqual({});
  });
  test("a proactiveFor result carries neither session field", () => {
    __setProactiveSoulSource(() => soul);
    for (const r of [proactiveFor("a"), proactiveFor("a", "C111"), proactiveFor("a", "C222")]) {
      expect(r).not.toHaveProperty("sessions");
      expect(r).not.toHaveProperty("invalidSessions");
    }
  });
  test("channelSessionWakes leaves out Enabled: no and sorts", () => {
    const block = (id: string, enabled: string) => `## Channel <#${id}>\n### Session\n- Mode: channel\n### Proactive\n- Enabled: ${enabled}\n\n`;
    __setProactiveSoulSource(() => block("C999", "yes") + block("C888", "no") + block("C777", "yes"));
    expect(channelSessionWakes("a")).toEqual(["C777", "C999"]);
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
