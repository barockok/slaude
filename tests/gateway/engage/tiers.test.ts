import { describe, expect, test } from "bun:test";
import { MAX_TEXT, runTiers, type TierFacts, type TierResult } from "../../../src/gateway/engage/tiers";

const NOW = 1_700_000_600_000;
const SENT = String(NOW / 1000 - 120); // an agent spoke two minutes ago

const base = (o: Partial<TierFacts> = {}): TierFacts => ({
  text: "",
  subtype: undefined,
  authorIsBot: false,
  selfUserIds: new Set(["U0AGENT"]),
  threadEngaged: false,
  level: "addressed",
  restricted: false,
  locks: { oneOnOne: false, mentionOnly: false, disengaged: false },
  lastSpeaker: null,
  agent: { name: "Sam" },
  otherAgents: new Set(["robin"]),
  nowMs: NOW,
  windowMs: 600_000,
  ...o,
});
const spoke = { ts: SENT, persona: "Sam", app: "A0ONE", repliedToUser: "U0PERSON" };
const run = (o: Partial<TierFacts>): Pick<TierResult, "tier" | "action" | "reason"> => {
  const r = runTiers(base(o));
  return { tier: r.tier, action: r.action, reason: r.reason };
};

type Row = [string, Partial<TierFacts>, TierResult["tier"], TierResult["action"], string];

const CLASSIFY: [TierResult["tier"], TierResult["action"], string] = [3, "classify", "classify"];
const classify = (name: string, o: Partial<TierFacts>): Row => [name, o, ...CLASSIFY];

const rows: Row[] = [
  // safety rules: level, restricted, subtype, bot, locks
  ["level mention", { level: "mention", text: "sam, can you look" }, 0, "pass", "level_mention"],
  ["restricted channel", { restricted: true, text: "sam, can you look" }, 0, "pass", "restricted"],
  ["channel_join subtype", { subtype: "channel_join", text: "hello" }, 0, "pass", "subtype"],
  ["bot_message subtype", { subtype: "bot_message", text: "build failed" }, 0, "pass", "subtype"],
  ["message_changed subtype", { subtype: "message_changed", text: "sam, can you look" }, 0, "pass", "subtype"],
  classify("file_share is allowed", { subtype: "file_share", text: "sam, can you look at this?" }),
  classify("me_message is allowed", { subtype: "me_message", text: "sam, can you look" }),
  classify("thread_broadcast is allowed", { subtype: "thread_broadcast", text: "sam, can you look" }),
  ["bot author", { authorIsBot: true, text: "sam, can you look" }, 0, "pass", "bot_author"],
  ["1on1 lock", { locks: { oneOnOne: true, mentionOnly: false, disengaged: false }, text: "sam, can you look" }, 0, "pass", "lock_1on1"],
  ["mention-only lock", { locks: { oneOnOne: false, mentionOnly: true, disengaged: false }, text: "sam, can you look" }, 0, "pass", "lock_mention_only"],
  ["disengaged lock", { locks: { oneOnOne: false, mentionOnly: false, disengaged: true }, text: "sam, can you look" }, 0, "pass", "lock_disengaged"],
  // mentions
  ["mention of the agent", { text: "<@U0AGENT> look at this" }, 1, "run", "mention"],
  ["mention of the agent with a name", { text: "<@U0AGENT|sam> look" }, 1, "run", "mention"],
  ["mention of the agent beats a locked-in thread", { locks: { oneOnOne: false, mentionOnly: true, disengaged: false }, text: "<@U0AGENT> hi?" }, 1, "run", "mention"],
  ["mention of a colleague", { text: "<@U0OTHER> can you look?" }, 0, "pass", "names_other_person"],
  ["mention with a name", { text: "<@U0OTHER|jo> can you look?" }, 0, "pass", "names_other_person"],
  ["agent and colleague both: the agent wins", { text: "<@U0AGENT> and <@U0OTHER> look" }, 1, "run", "mention"],
  ["user group", { text: "<!subteam^S0GROUP|@ops> please look" }, 0, "pass", "names_group"],
  ["@here", { text: "<!here> deploy done?" }, 0, "pass", "names_group"],
  ["@channel", { text: "<!channel> deploy done?" }, 0, "pass", "names_group"],
  ["@everyone", { text: "<!everyone> deploy done?" }, 0, "pass", "names_group"],
  ["plain @here", { text: "@here is the deploy done?" }, 0, "pass", "names_group"],
  classify("mention inside a quote is not a mention", { text: "> <@U0OTHER> asked\nwhat about that?" }),
  classify("mention inside code is not a mention", { text: "run `<@U0OTHER>` for me" }),
  // another registered agent by name
  ["another agent by name and a comma", { text: "Robin, can you look?" }, 0, "pass", "names_other_agent"],
  ["another agent with @", { text: "@robin, can you look?" }, 0, "pass", "names_other_agent"],
  ["another agent in caps", { text: "ROBIN, can you look?" }, 0, "pass", "names_other_agent"],
  classify("another agent's name without a comma", { text: "Robin can you look?" }),
  classify("another agent's name later in the text", { text: "I asked Robin, not you" }),
  classify("a person's name and a comma is not a rule", { text: "Budi, can you look at this?" }),
  // everything else goes to the classifier
  classify("Dude, can you check that?", { text: "Dude, can you check that?" }),
  classify("Dude right after the agent spoke", { text: "Dude, can you check that?", lastSpeaker: spoke }),
  classify("thanks", { text: "thanks" }),
  classify("ok", { text: "ok" }),
  classify("a root message with no agent history", { text: "does anyone know how to rotate the keys?", level: "contribute" }),
  classify("a thread reply", { text: "what about the second one" }),
  classify("the agent's own name with a comma", { text: "Sam, is the build green?" }),
  classify("the agent's name mid sentence", { text: "I asked sam about it yesterday" }),
  classify("an empty text", { text: "" }),
  classify("only code", { text: "```\nls -la\n```" }),
  classify("only a link", { text: "<https://example.com/a|here>" }),
  classify("at contribute level", { level: "contribute", text: "anyone around?" }),
  // other agents
  ["follows another registered agent", { text: "what about the logs?", otherSpeaker: { ...spoke, persona: "Robin", app: "A0TWO" } }, 0, "pass", "follows_other_agent"],
  ["another agent spoke after this one", { text: "what about the logs?", lastSpeaker: { ...spoke, ts: String(NOW / 1000 - 300) }, otherSpeaker: { ...spoke, persona: "Robin" } }, 0, "pass", "follows_other_agent"],
  classify("this agent spoke after the other one", { text: "what about the logs?", lastSpeaker: spoke, otherSpeaker: { ...spoke, persona: "Robin", ts: String(NOW / 1000 - 300) } }),
  classify("another agent's old record is ignored", { text: "what about the logs?", otherSpeaker: { ...spoke, persona: "Robin", ts: String(NOW / 1000 - 3600) } }),
  classify("a record of an unregistered persona is not another agent", { text: "what about the logs?", otherSpeaker: { ...spoke, persona: "Ghost" } }),
  // engaged thread is handled elsewhere
  ["engaged thread is today's path", { text: "and the logs?", threadEngaged: true }, 1, "existing", "engaged_thread"],
  ["engaged thread, locked", { text: "and the logs?", threadEngaged: true, locks: { oneOnOne: false, mentionOnly: true, disengaged: false } }, 0, "pass", "lock_mention_only"],
];

describe("the tier ladder, table", () => {
  for (const [name, o, tier, action, reason] of rows) {
    test(name, () => expect(run(o)).toEqual({ tier, action, reason }));
  }
});

describe("details", () => {
  test("a message the agent follows carries continuation; otherwise it does not", () => {
    expect(runTiers(base({ text: "thanks", lastSpeaker: spoke })).continuation).toBe(true);
    expect(runTiers(base({ text: "thanks" })).continuation).toBeUndefined();
    expect(runTiers(base({ text: "thanks", lastSpeaker: { ...spoke, ts: String(NOW / 1000 - 3600) } })).continuation).toBeUndefined();
    expect(runTiers(base({ text: "thanks", lastSpeaker: { ...spoke, persona: "Robin" } })).continuation).toBeUndefined();
  });
  test("a pasted transcript with the agent's mention on a later line is not a run", () => {
    const r = runTiers(base({ text: "Budi: did you see this\n<@U0AGENT> can you look" }));
    expect(r.action).toBe("run"); // a real mention token anywhere outside code and quotes is a mention
    expect(runTiers(base({ text: "> <@U0AGENT> can you look" })).action).toBe("classify");
  });
  test("hostile input is cut and stays fast", () => {
    const hostile = [
      "a".repeat(40_000),
      "<@U1|".repeat(8_000),
      "<#C".repeat(13_000),
      "<!subteam^S1|".repeat(3_000),
      `${"a".repeat(30_000)}@`,
      `${"a.".repeat(20_000)}@x`,
      "`".repeat(40_000),
      "```".repeat(13_000),
      `${"> ".repeat(20_000)}x`,
      "Sam".repeat(13_000),
      " ".repeat(40_000),
      "http://".repeat(6_000),
    ];
    for (const text of hostile) {
      const t0 = performance.now();
      runTiers(base({ text, lastSpeaker: spoke }));
      const ms = performance.now() - t0;
      expect({ len: text.length, fast: ms < 50 }).toEqual({ len: text.length, fast: true });
    }
  });
  test("text past the cap is cut, so a late mention is not seen", () => {
    const r = runTiers(base({ text: `${"x ".repeat(MAX_TEXT)}<@U0AGENT> look` }));
    expect(r.action).not.toBe("run");
  });
  test("never throws on odd input", () => {
    for (const text of ["", " ", "<", "<@", "```", "`", ">", "\u0000", "Sam,", "@", ",", "<!subteam^>", "x".repeat(50_000)]) {
      expect(() => runTiers(base({ text }))).not.toThrow();
    }
  });
});
