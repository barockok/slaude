// Baseline cluster round trip: fake Slack -> gateway -> node (real claude CLI) -> mock LLM -> back.
// Needs the e2e cluster (e2e/up.sh). Not discovered by root `bun test`; run it by name:
//   bun test ./e2e/ha/echo.e2e.ts --timeout 300000   (the leading ./ is required)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { until } from "../fake-slack/util";
import { portForward } from "../harness/kube";
import { setupSuite, type Suite } from "./driver";
import { journalRowsFor, lastSeq, personaReplies, unknownMethods, type MockJournalRow } from "./suite-logic";

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
    const since = lastSeq((await suite.fake.calls()).calls);
    const sentAt = Date.now();
    // The gateway posts through its primary (oldest) registered app, which is not necessarily
    // the receiving app (see the todo below), so the author must be ANY bot the fake knows.
    const bots = (await suite.fake.apps()).apps.map((a) => a.botUserId);

    const sent = await suite.fake.send({
      app: suite.app.apiAppId,
      channel,
      user: suite.manager,
      text: `[[mock:echo]] ${marker}`,
      target: suite.gatewayUrl,
      retryDelaysMs: [],
      ackTimeoutMs: 10_000,
    });
    expect(sent.deliveries.map((d) => d.finalStatus)).toEqual([200]);

    const reply = await until(
      async () => personaReplies((await suite.fake.messages(channel)).messages, bots, persona)[0],
      { timeoutMs: 150_000, intervalMs: 500, what: `the [${persona}] echo reply in ${channel}` },
    );
    expect(bots).toContain(reply.user);
    expect(reply.text).toContain(`[${persona}]`);
    expect(reply.text).toContain(marker);
    expect(reply.text).not.toContain("[[mock:");

    // Give a duplicate turn or a second post time to land before judging "exactly one".
    await Bun.sleep(5_000);
    const replies = personaReplies((await suite.fake.messages(channel)).messages, bots, persona);
    expect(replies).toHaveLength(1);

    // Only this case's calls: everything after the mark taken before sending.
    const calls = (await suite.fake.calls({ since })).calls;
    expect(unknownMethods(calls)).toEqual([]);

    // The other end: the mock answered this turn's echo with the persona from the system prompt,
    // and the CLI offered the surface reply tool the reply went out through.
    const rows = journalRowsFor(await journal(), "echo", sentAt);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.action === "proxy" && r.persona === persona && r.offersReply)).toBe(true);
  },
  240_000,
);

// Plan 3, multi-persona: the reply must be authored by the RECEIVING app's bot user
// (suite.app.botUserId). Today the gateway posts through its primary (oldest) registered app in
// HTTP mode, so with more than one app the reply can carry another app's identity.
test.todo("multi-persona: the reply is authored by the receiving app's bot user", () => {});
