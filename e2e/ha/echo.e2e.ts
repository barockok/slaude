// Baseline cluster round trip: fake Slack -> gateway -> node (real claude CLI) -> mock LLM -> back.
// Needs the e2e cluster (e2e/up.sh). Not discovered by root `bun test`; run it by name:
//   bun test ./e2e/ha/echo.e2e.ts --timeout 300000   (the leading ./ is required)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { until } from "../fake-slack/util";
import { portForward } from "../harness/kube";
import { setupSuite, type Suite } from "./driver";
import { caseJournalRows, lastJournalSeq, lastSeq, personaReplies, unknownMethods, type MockJournalRow } from "./suite-logic";

let suite: Suite;
let mock: { localPort: number; stop(): void } | undefined;

beforeAll(async () => {
  suite = await setupSuite();
  mock = await portForward("svc/mock-llm", 8080);
}, 600_000);

afterAll(async () => {
  mock?.stop();
  await suite?.teardown();
});

const journal = async (): Promise<MockJournalRow[]> => {
  const res = await fetch(`http://127.0.0.1:${mock!.localPort}/__mock/journal`);
  if (!res.ok) throw new Error(`mock journal: ${res.status}`);
  return (await res.json()) as MockJournalRow[];
};

test(
  "a DM tagged echo gets one persona-labelled reply through gateway, node, mock LLM and back",
  async () => {
    const persona = suite.app.personaId;
    const channel = await suite.newChannel();
    const marker = `round trip ${channel} ${Date.now()}`;
    // Marks taken from the fake and the mock themselves (no clocks): only what this case adds counts.
    const since = lastSeq((await suite.fake.calls()).calls);
    const journalMark = lastJournalSeq(await journal());
    // The gateway posts through its primary (oldest) registered app, which is not necessarily
    // the receiving app (see the todo below), so the author must be one of the bots REGISTERED
    // in the fake: a bounded set, not any user.
    const bots = (await suite.fake.apps()).apps.map((a) => a.botUserId);
    expect(bots).toContain(suite.app.botUserId);

    const sent = await suite.fake.send({
      app: suite.app.apiAppId,
      channel,
      user: suite.manager,
      // `case=<channel>` is ignored by the scenario and recorded in the mock journal's tagParams.
      text: `[[mock:echo case=${channel}]] ${marker}`,
      target: suite.gatewayUrl,
      retryDelaysMs: [],
      ackTimeoutMs: 10_000,
    });
    expect(sent.deliveries.map((d) => d.finalStatus)).toEqual([200]);

    const reply = await until(
      async () => personaReplies((await suite.fake.messages(channel)).messages, bots, persona)[0],
      { timeoutMs: 150_000, intervalMs: 500, what: `the [${persona}] echo reply in ${channel}` },
    );
    expect(reply.text).toContain(`[${persona}]`);
    expect(reply.text).toContain(marker);
    expect(reply.text).not.toContain("[[mock:");

    // Give a duplicate turn or a second post time to land, then judge the WHOLE channel: it is
    // unique to this case, so it must hold exactly the human message and the one labelled reply.
    await Bun.sleep(5_000);
    const messages = (await suite.fake.messages(channel)).messages;
    expect(messages.map((m) => m.user)).toEqual([suite.manager, reply.user]);
    expect(messages[0]!.ts).toBe(sent.message.ts);
    expect(messages[1]).toEqual(reply);
    expect(bots).toContain(messages[1]!.user);

    // Only this case's calls: everything after the mark taken before sending.
    const calls = (await suite.fake.calls({ since })).calls;
    expect(unknownMethods(calls)).toEqual([]);

    // The other end: exactly this turn's two model requests, in order. First the user turn (one
    // message, offering the surface reply tool), then the request after the reply tool's result
    // (user, assistant tool_use, user tool_result). Both carry the persona from the system prompt.
    const rows = caseJournalRows(await journal(), journalMark, "echo", channel);
    expect(rows.map((r) => [r.messages, r.action, r.persona])).toEqual([
      [1, "proxy", persona],
      [3, "proxy", persona],
    ]);
    expect(rows[0]!.offersReply).toBe(true);
  },
  240_000,
);

// Follow-up multi-persona scenarios: the reply must be authored by the RECEIVING app's bot user
// (suite.app.botUserId). Today the gateway posts through its primary (oldest) registered app in
// HTTP mode, so with more than one app the reply can carry another app's identity.
test.todo("multi-persona: the reply is authored by the receiving app's bot user", () => {});
