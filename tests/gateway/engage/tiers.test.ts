import { describe, expect, test } from "bun:test";
import { MAX_TEXT, isAckOnly, runTiers, type TierFacts, type TierResult } from "../../../src/gateway/engage/tiers";

const NOW = 1_700_000_600_000;
const SENT = String(NOW / 1000 - 120); // the agent spoke two minutes ago

const base = (o: Partial<TierFacts> = {}): TierFacts => ({
  text: "",
  subtype: undefined,
  authorIsBot: false,
  authorId: "U0PERSON",
  selfUserIds: new Set(["U0AGENT"]),
  hasFiles: false,
  isThreadReply: false,
  isRoot: true,
  threadEngaged: false,
  level: "addressed",
  restricted: false,
  locks: { oneOnOne: false, mentionOnly: false, disengaged: false },
  lastSpeaker: null,
  agent: { name: "Sam", aliases: ["samwise"], app: "A0ONE" },
  otherAgents: new Set(["robin"]),
  sameNamedHuman: () => false,
  nowMs: NOW,
  windowMs: 600_000,
  humansAlternated: false,
  ...o,
});
const followed = { ts: SENT, persona: "Sam", app: "A0ONE", repliedToUser: "U0PERSON" };
const run = (o: Partial<TierFacts>): Pick<TierResult, "tier" | "action" | "reason"> => {
  const r = runTiers(base(o));
  return { tier: r.tier, action: r.action, reason: r.reason };
};

type Row = [string, Partial<TierFacts>, TierResult["tier"], TierResult["action"], string];

const rows: Row[] = [
  // tier 0: level, restricted, subtype, bot, locks
  ["level mention", { level: "mention", text: "sam, can you look" }, 0, "pass", "level_mention"],
  ["restricted channel", { restricted: true, text: "sam, can you look" }, 0, "pass", "restricted"],
  ["channel_join subtype", { subtype: "channel_join", text: "hello" }, 0, "pass", "subtype"],
  ["bot_message subtype", { subtype: "bot_message", text: "build failed" }, 0, "pass", "subtype"],
  ["message_changed subtype", { subtype: "message_changed", text: "sam, can you look" }, 0, "pass", "subtype"],
  ["file_share is allowed", { subtype: "file_share", hasFiles: true, text: "sam, can you look at this?" }, 1, "run", "name_comma"],
  ["me_message is allowed", { subtype: "me_message", text: "sam, can you look" }, 1, "run", "name_comma"],
  ["thread_broadcast is allowed", { subtype: "thread_broadcast", text: "sam, can you look" }, 1, "run", "name_comma"],
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
  ["mention inside a quote is not a mention", { text: "> <@U0OTHER> asked\nsam, can you answer that?" }, 1, "run", "name_comma"],
  ["mention inside code is not a mention", { text: "run `<@U0OTHER>` for sam" }, 3, "classify", "name_mid"],
  // vocative to another person
  ["vocative to a person", { text: "Budi, can you look at this?" }, 0, "pass", "vocative_other"],
  ["vocative with @", { text: "@budi, can you look?" }, 0, "pass", "vocative_other"],
  ["vocative to another agent", { text: "Robin, can you look?" }, 0, "pass", "names_other_agent"],
  ["a sentence opener with a comma is not a vocative", { text: "However, can you look at the logs?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["lowercase opener is not a vocative", { text: "hmm, what about the logs?" }, 0, "pass", "no_band"],
  ["vocative to the agent runs", { text: "Sam, can you look?" }, 1, "run", "name_comma"],
  // ack
  ["ack ok", { text: "ok" }, 0, "pass", "ack"],
  ["ack thanks that worked", { text: "thanks, that worked" }, 0, "pass", "ack"],
  ["ack plus one", { text: "+1" }, 0, "pass", "ack"],
  ["ack lgtm", { text: "LGTM!" }, 0, "pass", "ack"],
  ["ack emoji only", { text: ":thumbsup: :tada:" }, 0, "pass", "ack"],
  ["ack unicode emoji only", { text: "\u{1F44D}" }, 0, "pass", "ack"],
  ["ack with only a link left", { text: "thanks <https://example.com/a|here>" }, 0, "pass", "ack"],
  ["empty after stripping code", { text: "```\nls -la\n```" }, 0, "pass", "ack"],
  ["empty after stripping a quote", { text: "> something said before" }, 0, "pass", "ack"],
  ["empty with a file is not ack", { text: "", hasFiles: true, lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["ack prefix with a request is not ack, but is not a tier 2 run either", { text: "ok, can you also check the logs?", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["ack of the agent's follower", { text: "thanks", lastSpeaker: followed }, 0, "pass", "ack"],
  // other agents
  ["follows another registered agent", { text: "what about the logs?", otherSpeaker: { ...followed, persona: "Robin", app: "A0TWO" } }, 0, "pass", "follows_other_agent"],
  ["another agent spoke after this one", { text: "what about the logs?", lastSpeaker: { ...followed, ts: String(NOW / 1000 - 300) }, otherSpeaker: { ...followed, persona: "Robin" } }, 0, "pass", "follows_other_agent"],
  ["this agent spoke after the other one", { text: "what about the logs?", lastSpeaker: followed, otherSpeaker: { ...followed, persona: "Robin", ts: String(NOW / 1000 - 300) } }, 2, "run", "follows_agent"],
  ["another agent's old record is ignored", { text: "what about the logs?", otherSpeaker: { ...followed, persona: "Robin", ts: String(NOW / 1000 - 3600) } }, 0, "pass", "no_band"],
  ["a record of an unregistered persona is not another agent", { text: "what about the logs?", otherSpeaker: { ...followed, persona: "Ghost" } }, 0, "pass", "no_band"],
  // tier 1
  ["engaged thread is today's path", { text: "and the logs?", threadEngaged: true }, 1, "existing", "engaged_thread"],
  ["name with a comma and a question", { text: "Sam, is the build green?" }, 1, "run", "name_comma"],
  ["alias with a comma and an imperative", { text: "Samwise, check the logs" }, 1, "run", "name_comma"],
  ["name with @ and a comma", { text: "@sam, please look" }, 1, "run", "name_comma"],
  ["name in caps, folded", { text: "SAM, can you look" }, 1, "run", "name_comma"],
  ["full-width name, NFKC", { text: "Ｓａｍ, can you look" }, 1, "run", "name_comma"],
  ["name comma without request shape", { text: "Sam, nice work on the release" }, 3, "classify", "name_no_request_shape"],
  ["same-named human at the start", { text: "Sam, can you look", sameNamedHuman: (n) => n === "sam" }, 3, "classify", "same_named_human"],
  ["colon form is tier 3", { text: "Sam: can you look" }, 3, "classify", "name_colon"],
  ["pasted transcript, colon", { text: "Sam: hello there\nBudi: hi" }, 3, "classify", "name_colon"],
  ["name mid sentence", { text: "I asked sam about it yesterday" }, 3, "classify", "name_mid"],
  ["alias mid sentence", { text: "did samwise finish that?" }, 3, "classify", "name_mid"],
  // name matching hardening
  ["sam is not same", { text: "is this the same issue as before" }, 0, "pass", "no_band"],
  ["alias as a substring", { text: "samwiser people agree" }, 0, "pass", "no_band"],
  ["name inside a quote", { text: "> sam, can you look\nnot me" }, 0, "pass", "no_band"],
  ["name inside a fenced block", { text: "```\nsam, can you look\n```\nwhat do you think?" }, 0, "pass", "no_band"],
  ["name inside inline code", { text: "see `sam` in the config" }, 0, "pass", "no_band"],
  ["name inside a link label", { text: "see <https://example.com/sam|the page>" }, 0, "pass", "no_band"],
  ["name inside a bare url", { text: "see https://example.com/sam/readme" }, 0, "pass", "no_band"],
  ["name inside an email", { text: "write to sam@example.com" }, 0, "pass", "no_band"],
  // tier 2
  ["follows the agent's answer", { text: "can you also check staging?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["follows with a question mark only", { text: "staging too?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["follows with a file", { text: "here is the log", hasFiles: true, subtype: "file_share", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["a different author failed the author test", { text: "can you check staging?", authorId: "U0THIRD", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["the same author failed the shape test", { text: "interesting, i did not know that", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["outside the window", { text: "can you check staging?", lastSpeaker: { ...followed, ts: String(NOW / 1000 - 3600) } }, 0, "pass", "no_band"],
  ["two humans alternating", { text: "can you check staging?", lastSpeaker: followed, humansAlternated: true }, 2, "pass", "humans_alternating"],
  ["alternating, but the name is used", { text: "Sam, can you check staging?", lastSpeaker: followed, humansAlternated: true }, 1, "run", "name_comma"],
  ["agent did not reply to anyone", { text: "can you check staging?", lastSpeaker: { ...followed, repliedToUser: null } }, 3, "classify", "follower_failed_test"],
  // tier 2 is a request, not a remark
  ["thanks, you rock", { text: "thanks, you rock", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["ok you were right", { text: "ok you were right", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Thanks! you are great", { text: "Thanks! you are great", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Test passed on staging.", { text: "Test passed on staging.", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Will do it tomorrow", { text: "Will do it tomorrow", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["please add the flag", { text: "please add the flag", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["an imperative", { text: "add the flag to staging too", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["can you check staging?", { text: "can you check staging?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["can you check staging without a mark", { text: "Could you check staging", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["a remark about you is not a request", { text: "you were right about the cache", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  // sentence openers are not names
  ["Yeah, can you check staging too?", { text: "Yeah, can you check staging too?", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Perfect, can you also add X?", { text: "Perfect, can you also add X?", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Awesome, what about prod?", { text: "Awesome, what about prod?", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Honestly, can you check staging?", { text: "Honestly, can you check staging?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["Sure, what about prod?", { text: "Sure, what about prod?", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Great, anything on prod?", { text: "Great, anything on prod?", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Okay, how about prod?", { text: "Okay, how about prod?", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Right, how about prod?", { text: "Right, how about prod?", lastSpeaker: followed }, 3, "classify", "follower_failed_test"],
  ["Well, how about prod?", { text: "Well, how about prod?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["Actually, how about prod?", { text: "Actually, how about prod?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["Also, how about prod?", { text: "Also, how about prod?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["Hmm, how about prod?", { text: "Hmm, how about prod?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  ["So, how about prod?", { text: "So, how about prod?", lastSpeaker: followed }, 2, "run", "follows_agent"],
  // the agent's display name
  ["the display name runs like an alias", { text: "Quill, can you look?", agent: { name: "default", aliases: [], displayNames: ["quill"] } }, 1, "run", "name_comma"],
  ["the display name is not a vocative to someone else", { text: "Quill, can you look?", agent: { name: "ana", aliases: [], displayNames: ["Quill"] } }, 1, "run", "name_comma"],
  ["no display name and no alias: a capitalised word is a vocative", { text: "Quill, can you look?", agent: { name: "default", aliases: [] } }, 0, "pass", "vocative_other"],
  // tier 3 contribute band
  ["root question at contribute", { level: "contribute", text: "does anyone know how to rotate the keys?", rootBand: { minLength: 20, debounceMs: 60_000 } }, 3, "classify", "root_question"],
  ["root question too short", { level: "contribute", text: "anyone know?", rootBand: { minLength: 20, debounceMs: 60_000 } }, 0, "pass", "no_band"],
  ["root question at addressed is a pass", { level: "addressed", text: "does anyone know how to rotate the keys?", rootBand: { minLength: 20, debounceMs: 60_000 } }, 0, "pass", "no_band"],
  ["a reply in a human thread is never a root candidate", { level: "contribute", isRoot: false, isThreadReply: true, text: "does anyone know how to rotate the keys?", rootBand: { minLength: 20, debounceMs: 60_000 } }, 0, "pass", "no_band"],
  ["a root statement is not a question", { level: "contribute", text: "the deploy finished without any trouble today", rootBand: { minLength: 20, debounceMs: 60_000 } }, 0, "pass", "no_band"],
  ["no root band input, no candidate", { level: "contribute", text: "does anyone know how to rotate the keys?" }, 0, "pass", "no_band"],
];

describe("the tier ladder, table", () => {
  for (const [name, o, tier, action, reason] of rows) {
    test(name, () => expect(run(o)).toEqual({ tier, action, reason }));
  }
});

describe("details", () => {
  test("the root band carries the debounce through", () => {
    const r = runTiers(base({ level: "contribute", text: "does anyone know how to rotate the keys?", rootBand: { minLength: 20, debounceMs: 45_000 } }));
    expect(r.debounceMs).toBe(45_000);
  });
  test("a pasted transcript with the name on a later line is never a tier 1 run", () => {
    const r = runTiers(base({ text: "Budi: did you see this\nSam, can you look" }));
    expect(r.action).not.toBe("run");
  });
  test("attachments are never matched (only text is a fact)", () => {
    expect(run({ text: "", hasFiles: false })).toEqual({ tier: 0, action: "pass", reason: "ack" });
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
      runTiers(base({ text, lastSpeaker: followed }));
      const ms = performance.now() - t0;
      expect({ len: text.length, fast: ms < 50 }).toEqual({ len: text.length, fast: true });
    }
  });
  test("text past the cap is cut, so a late mention is not seen", () => {
    const r = runTiers(base({ text: `${"x ".repeat(MAX_TEXT)}<@U0AGENT> look` }));
    expect(r.action).not.toBe("run");
  });
  test("a human reply in a thread the agent opened is a tier 3 candidate, only with the root known to be the agent's", () => {
    const reply = { isRoot: false, isThreadReply: true, text: "what about the second one" };
    expect(run({ ...reply, rootIsAgent: true })).toEqual({ tier: 3, action: "classify", reason: "agent_thread_reply" });
    expect(run({ ...reply })).toEqual({ tier: 0, action: "pass", reason: "no_band" });
    expect(run({ ...reply, rootIsAgent: false })).toEqual({ tier: 0, action: "pass", reason: "no_band" });
    // a bot author, another person named, an ack, and a thread of colleagues alternating never reach it
    expect(run({ ...reply, rootIsAgent: true, authorIsBot: true }).action).toBe("pass");
    expect(run({ ...reply, rootIsAgent: true, text: "<@U0OTHER> what about it" }).action).toBe("pass");
    expect(run({ ...reply, rootIsAgent: true, text: "thanks" }).action).toBe("pass");
    expect(run({ ...reply, rootIsAgent: true, level: "mention" }).action).toBe("pass");
    expect(run({ ...reply, rootIsAgent: true, restricted: true }).action).toBe("pass");
    // a root message is not a reply
    expect(run({ rootIsAgent: true, isRoot: true, isThreadReply: false, text: "what about the second one" }).action).toBe("pass");
  });
  test("never throws on odd input", () => {
    for (const text of ["", " ", "<", "<@", "```", "`", ">", "\u0000", "Sam,", "@", ",", "<!subteam^>", "x".repeat(50_000)]) {
      expect(() => runTiers(base({ text }))).not.toThrow();
    }
  });
  test("ack detection", () => {
    for (const t of ["ok", "Okay!", "thank you so much", "thanks, that worked", "got it, thanks", "+1", "lgtm", ":white_check_mark:", "sounds good, will do"]) expect({ t, a: isAckOnly(t) }).toEqual({ t, a: true });
    for (const t of ["ok can you check", "thanks but it still fails", "what is that", "no, use the other one instead"]) expect({ t, a: isAckOnly(t) }).toEqual({ t, a: false });
  });
});
