import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readPageRecord } from "../../src/knowledge/memory-pages";
import { agentSourceId } from "../../src/knowledge/scope";
import { backgroundAgentId } from "../../src/background/skill-check";
import * as OneOnOne from "../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import type { SlackContext } from "../../src/gateway/slack/mcp-tools";
import { NOT_OWN_TURN_REFUSAL, ONE_ON_ONE_REFUSAL, proactiveRule } from "../../src/proactive/rule-tool";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { fakeBrain } from "../memory/fake-brain";

const NOW = new Date("2026-10-27T10:00:00Z");
// Global ceiling `ask`; C0TEAM's own ceiling `act`; C0PUB inherits `ask`.
const SOUL = ["## Proactive", "- Highest: ask", "", "## Channel <#C0TEAM>", "### Proactive", "- Highest: act", ""].join("\n");

let brain: ReturnType<typeof fakeBrain>;
let source: string;
const deps = () => ({ call: brain.call, now: () => NOW });
/** A person's own Slack turn: origin slack, the one sender is the speaker. */
const ctx = (over: Partial<SlackContext> = {}): SlackContext => {
  const userId = "userId" in over ? over.userId : "U0PERSON";
  return {
    client: {} as any, channel: "C0TEAM", threadTs: "100.0", inboundTs: "100.0", userId, teamId: "T1", origin: "slack",
    turnSenders: () => (userId ? [{ userId, teamId: "T1", origin: "slack" }] : null),
    ...over,
  };
};
const page = (slug: string) => {
  const c = brain.contentOf(source, slug);
  return c === undefined ? null : readPageRecord({ content: c });
};
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const approving = (by: string, seen: unknown[] = []) =>
  async (req: unknown) => { seen.push(req); return { approved: true, by }; };

beforeAll(async () => {
  writeSoulFixture(WORLD);
  __setProactiveSoulSource(() => SOUL);
  source = agentSourceId(await backgroundAgentId("default"));
});
afterAll(() => __setProactiveSoulSource(null));
beforeEach(async () => {
  brain = fakeBrain();
  await OneOnOne._wipeForTests();
});

describe("proactive_rule", () => {
  test("lowering by a DM recipient applies at once", async () => {
    const r = await proactiveRule(
      ctx({ channel: "D0DM00001", threadTs: "200.0", requestApproval: async () => { throw new Error("no card for a lowering"); } }),
      { kind: "Newsletter emails", scope: "here", level: "ignore", quote: "don't bother me with those" },
      deps(),
    );
    expect(r.isError).toBeUndefined();
    const p = page("rules/proactive/newsletter-emails-u0person")!;
    expect(p.meta.level).toBe("ignore");
    expect(p.meta.scope).toBe("U0PERSON");
    expect(p.meta.quote).toBe("don't bother me with those");
    expect(p.meta.thread).toBe("D0DM00001/200.0");
  });

  test("raising by a non-approver opens an approval and writes on approve", async () => {
    const seen: unknown[] = [];
    const r = await proactiveRule(
      ctx({ requestApproval: approving("U0APP", seen) }),
      { kind: "invoice emails", scope: "here", level: "act", how: "reply with the template", quote: "just answer these" },
      deps(),
    );
    expect(r.isError).toBeUndefined();
    expect(seen).toEqual([{ summary: "Let me handle invoice emails at act in <#C0TEAM>: reply with the template", category: "proactive-rule" }]);
    const p = page("rules/proactive/invoice-emails-c0team")!;
    expect(p.meta.level).toBe("act");
    expect(p.meta.how).toBe("reply with the template");
    expect(p.meta.taught_by).toBe("U0PERSON");
  });

  test("a denied raise writes nothing", async () => {
    const r = await proactiveRule(
      ctx({ requestApproval: async () => ({ approved: false, by: "U0APP" }) }),
      { kind: "invoice emails", scope: "here", level: "ask", quote: "ask me first" },
      deps(),
    );
    expect(r.isError).toBe(true);
    expect(page("rules/proactive/invoice-emails-c0team")).toBeNull();
  });

  test("an approval clicked by someone who cannot approve the scope writes nothing", async () => {
    const r = await proactiveRule(
      ctx({ requestApproval: approving("U0PERSON") }),
      { kind: "invoice emails", scope: "here", level: "ask", quote: "ask me first" },
      deps(),
    );
    expect(r.isError).toBe(true);
    expect(page("rules/proactive/invoice-emails-c0team")).toBeNull();
  });

  test("an approver raising within the ceiling applies without a card", async () => {
    const r = await proactiveRule(
      ctx({ userId: "U0APP" }),
      { kind: "invoice emails", scope: "here", level: "ask", quote: "ask me first" },
      deps(),
    );
    expect(r.isError).toBeUndefined();
    expect(page("rules/proactive/invoice-emails-c0team")!.meta.level).toBe("ask");
  });

  test("raising past Highest is refused and names the ceiling", async () => {
    let asked = false;
    const r = await proactiveRule(
      ctx({ channel: "C0PUB", userId: WORLD.manager, requestApproval: async () => { asked = true; return { approved: true, by: WORLD.manager }; } }),
      { kind: "invoice emails", scope: "here", level: "act", how: "reply", quote: "just answer" },
      deps(),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("ask");
    expect(text(r)).toContain("act");
    expect(asked).toBe(false);
    expect(page("rules/proactive/invoice-emails-c0pub")).toBeNull();
  });

  test("global from a non-manager is refused without a card, naming the manager", async () => {
    let asked = false;
    const r = await proactiveRule(
      ctx({ channel: "D0DM00001", threadTs: "200.0", requestApproval: async () => { asked = true; return { approved: true, by: WORLD.manager }; } }),
      { kind: "invoice emails", scope: "global", level: "ask", quote: "ask me before you answer those" },
      deps(),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`refused: ask <@${WORLD.manager}> or <@${WORLD.backup}> to set this; only they can approve it here`);
    expect(asked).toBe(false);
    expect(page("rules/proactive/invoice-emails-global")).toBeNull();
  });

  test("raising a DM rule by its recipient is refused without a card, naming the manager", async () => {
    let asked = false;
    const r = await proactiveRule(
      ctx({ channel: "D0DM00001", threadTs: "200.0", requestApproval: async () => { asked = true; return { approved: true, by: WORLD.manager }; } }),
      { kind: "invoice emails", scope: "here", level: "ask", quote: "ask me" },
      deps(),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`<@${WORLD.manager}>`);
    expect(asked).toBe(false);
    expect(page("rules/proactive/invoice-emails-u0person")).toBeNull();
  });

  test("the manager widening to global from a DM writes a page with provenance and no quote", async () => {
    const r = await proactiveRule(
      ctx({ userId: WORLD.manager, channel: "D0DM00001", threadTs: "200.0" }),
      { kind: "invoice emails", scope: "global", level: "ask", quote: "ask me before you answer those" },
      deps(),
    );
    expect(r.isError).toBeUndefined();
    const p = page("rules/proactive/invoice-emails-global")!;
    expect(p.meta.scope).toBe("global");
    expect(p.meta.quote).toBeUndefined();
    expect(p.meta.taught_by).toBe(WORLD.manager);
    expect(p.meta.taught_at).toBe(NOW.toISOString());
    expect(p.meta.thread).toBe("D0DM00001/200.0");
  });

  test("a cron turn carrying the manager's id is refused", async () => {
    const r = await proactiveRule(
      ctx({ userId: WORLD.manager, origin: "cron", turnSenders: () => [{ userId: WORLD.manager, teamId: "T1", origin: "cron" }] }),
      { kind: "invoice emails", scope: "global", level: "ignore", quote: "stop" },
      deps(),
    );
    expect(text(r)).toBe(NOT_OWN_TURN_REFUSAL);
    expect([...brain.contents.keys()]).toEqual([]);
  });

  test("a heartbeat turn (route userId = the agent) is refused", async () => {
    const agentId = await backgroundAgentId("default");
    for (const over of [
      { userId: agentId, origin: "cron" as const, turnSenders: () => null },
      // Even if it read as slack with the agent as its one sender.
      { userId: agentId, turnSenders: () => [{ userId: agentId, teamId: "T1", origin: "slack" }] },
    ]) {
      const r = await proactiveRule(ctx(over), { kind: "invoice emails", scope: "here", level: "ignore", quote: "stop" }, deps());
      expect(text(r)).toBe(NOT_OWN_TURN_REFUSAL);
    }
    expect([...brain.contents.keys()]).toEqual([]);
  });

  test("a panel turn or a turn with merged or unknown senders is refused", async () => {
    const two = () => [{ userId: "U0PERSON", teamId: "T1", origin: "slack" }, { userId: "U0OTHER", teamId: "T1", origin: "slack" }];
    for (const over of [
      { origin: "panel" as const },
      { turnSenders: two },
      { turnSenders: () => null },
      { turnSenders: undefined },
      { turnSenders: () => [{ userId: "U0OTHER", teamId: "T1", origin: "slack" }] },
      { turnSenders: () => [{ userId: "U0PERSON", teamId: "T2", origin: "slack" }] },
    ]) {
      const r = await proactiveRule(ctx(over), { kind: "invoice emails", scope: "here", level: "ignore", quote: "stop" }, deps());
      expect(text(r)).toBe(NOT_OWN_TURN_REFUSAL);
    }
    expect([...brain.contents.keys()]).toEqual([]);
  });

  test("lowering a global rule by a channel approver still needs the manager", async () => {
    const r = await proactiveRule(
      ctx({ userId: "U0APP" }),
      { kind: "invoice emails", scope: "global", level: "ignore", quote: "stop" },
      deps(),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`<@${WORLD.manager}>`);
    expect(page("rules/proactive/invoice-emails-global")).toBeNull();
  });

  test("the manager widens to global at once", async () => {
    const r = await proactiveRule(
      ctx({ userId: WORLD.backup }),
      { kind: "invoice emails", scope: "global", level: "ask", quote: "ask" },
      deps(),
    );
    expect(r.isError).toBeUndefined();
    expect(page("rules/proactive/invoice-emails-global")!.meta.level).toBe("ask");
  });

  test("raising with no approval path is refused, naming who can approve", async () => {
    const r = await proactiveRule(ctx(), { kind: "invoice emails", scope: "here", level: "ask", quote: "ask me" }, deps());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`<@${WORLD.manager}>`);
    expect(text(r)).toContain("<@U0APP>");
    expect(page("rules/proactive/invoice-emails-c0team")).toBeNull();
  });

  test("act needs how", async () => {
    const r = await proactiveRule(ctx({ userId: WORLD.manager }), { kind: "invoice emails", scope: "here", level: "act", quote: "handle it" }, deps());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("how");
  });

  test("a kind with no letters or digits is refused", async () => {
    const r = await proactiveRule(ctx({ userId: WORLD.manager }), { kind: "!!!", scope: "here", level: "ignore", quote: "no" }, deps());
    expect(r.isError).toBe(true);
    expect([...brain.contents.keys()]).toEqual([]);
  });

  test("refused in a /1on1", async () => {
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: "100.0", lockedUser: WORLD.manager, createdBy: WORLD.manager });
    const r = await proactiveRule(ctx({ userId: WORLD.manager }), { kind: "invoice emails", scope: "here", level: "ignore", quote: "no" }, deps());
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(ONE_ON_ONE_REFUSAL);
    expect(ONE_ON_ONE_REFUSAL).toBe("refused: teach this outside the /1on1, so it can apply to others");
    const anon = await proactiveRule(ctx({ userId: undefined, threadTs: "300.0" }), { kind: "invoice emails", scope: "here", level: "ignore", quote: "no" }, deps());
    expect(text(anon)).toBe(ONE_ON_ONE_REFUSAL);
    expect([...brain.contents.keys()]).toEqual([]);
  });

  test("taughtBy comes from ctx, not args", async () => {
    const args = { kind: "invoice emails", scope: "here", level: "ignore", quote: "no", taughtBy: "U0EVIL", taught_by: "U0EVIL" } as any;
    await proactiveRule(ctx(), args, deps());
    const p = page("rules/proactive/invoice-emails-c0team")!;
    expect(p.meta.taught_by).toBe("U0PERSON");
    expect(p.meta.subject).toBe("U0PERSON");
  });

  test("a new rule replaces the earlier one of the same slug and revives a superseded tag", async () => {
    const slug = "rules/proactive/invoice-emails-c0team";
    await proactiveRule(ctx({ userId: "U0APP" }), { kind: "invoice emails", scope: "here", level: "ask", quote: "ask" }, deps());
    await brain.call("add_tag", { slug, tag: "superseded" }, { clientId: "x", sourceId: source, allowedSources: [source] });
    const r = await proactiveRule(ctx(), { kind: "Invoice  emails", scope: "here", level: "ignore", quote: "never mind" }, deps());
    expect(r.isError).toBeUndefined();
    expect(page(slug)!.meta.level).toBe("ignore");
    expect(brain.tagsOf(source, slug)).toEqual([]);
  });
});
