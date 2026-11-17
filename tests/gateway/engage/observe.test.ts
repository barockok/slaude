import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../../src/persona/agent-def";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import type { Persona } from "../../../src/persona/types";
import { __setLastSpeakerStoreForTests, memoryLastSpeakerStore, type LastSpeakerStore } from "../../../src/gateway/engage/last-speaker";
import { observeEngage, type ObserveInput } from "../../../src/gateway/engage/observe";
import { clearAgentRecord } from "../../../src/gateway/engage/record";

const CH = "C0SHARED";
const yaml = (name: string, user: string) => `
name: ${name}
slackUserId: ${user}
soul: You are ${name}.
access:
  channels:
    trusted: [${CH}]
channels:
  ${CH}: { engage: { level: addressed } }
`;
function persona(name: string, user: string): Persona {
  const { spec } = parseAgentYaml(name, yaml(name, user));
  const { soulData, ...definition } = spec.definition;
  return { name, slackUserId: user, soulMd: spec.soul, config: { slackUserId: user, name }, outClient: null, model: null, runsOn: null, provider: null, kbSources: null, background: null, mcp: null, soulJson: soulData, definition } as Persona;
}
function registry(...ps: Persona[]): PersonaRegistry {
  return {
    lookupByUserId: (id) => ps.find((p) => p.slackUserId === id) ?? null,
    lookupByName: (n) => ps.find((p) => p.name === n) ?? null,
    list: () => ps,
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, definition: null }),
  } as PersonaRegistry;
}

let store: LastSpeakerStore & { takes: number; peeks: number };
const nowTs = (o = 0) => `${Math.floor(Date.now() / 1000) + o}.000100`;
const THREAD = nowTs(-30);

beforeEach(() => {
  const inner = memoryLastSpeakerStore();
  store = { takes: 0, peeks: 0, put: inner.put, clear: inner.clear, take: async (p) => (store.takes++, inner.take(p)), peek: async (p) => (store.peeks++, inner.peek(p)) };
  __setLastSpeakerStoreForTests(store);
  setPersonaRegistry(registry(persona("ana", "UANA1"), persona("robin", "UROBIN")));
});
afterEach(() => {
  __setLastSpeakerStoreForTests(null);
  __resetPersonaRegistry();
});

const event = (o: Record<string, unknown> = {}) => ({ type: "message", channel: CH, user: "U0PERSON", ts: nowTs(1), thread_ts: THREAD, text: "can you check staging too?", ...o });
const input = (personaId: string, e: Record<string, unknown> = {}): ObserveInput => ({ event: event(e), personaId, botId: "UBOT", locks: { oneOnOne: false, mentionOnly: false, disengaged: false }, threadEngaged: false, site: "drop" });
const speak = (persona: string, ts: string, to: string | null = "U0PERSON") => store.put({ channel: CH, thread: THREAD, persona }, { ts, persona, app: "", repliedToUser: to });

describe("two personas in one channel", () => {
  for (const order of [["ana", "robin"], ["robin", "ana"]] as const) {
    test(`each copy reads its own record, whichever copy goes first (${order.join(" then ")})`, async () => {
      await speak("ana", nowTs(-20));
      const results: Record<string, string> = {};
      // robin spoke later than ana, to the same person.
      await speak("robin", nowTs(-10));
      for (const who of order) {
        const r = await observeEngage(input(who));
        results[who] = `${r?.tier}:${r?.action}:${r?.reason}`;
      }
      // ana's copy sees robin spoke last (another agent): pass. robin's copy follows its own answer.
      expect(results.robin).toBe("2:run:follows_agent");
      expect(results.ana).toBe("0:pass:follows_other_agent");
    });
  }

  test("a copy does not consume the other persona's record", async () => {
    await speak("robin", nowTs(-10));
    await observeEngage(input("ana"));
    expect(await store.take({ channel: CH, thread: THREAD, persona: "robin" })).not.toBeNull();
  });

  test("when ana spoke last, ana's copy runs and robin's copy passes", async () => {
    await speak("robin", nowTs(-20));
    await speak("ana", nowTs(-5));
    expect((await observeEngage(input("ana")))?.reason).toBe("follows_agent");
    expect((await observeEngage(input("robin")))?.reason).toBe("follows_other_agent");
  });
});

describe("what consumes the record", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a bot author", { user: "U0CIBOT", bot_id: "B0CI" }],
    ["a channel_join", { subtype: "channel_join" }],
    ["a message_changed", { subtype: "message_changed" }],
    ["an ack", { text: "thanks, that worked" }],
    ["a note to a colleague", { text: "Budi, can you look at it?" }],
    ["a user group", { text: "<!subteam^S0GROUP> please look" }],
    ["@here", { text: "<!here> deploy done?" }],
  ];
  for (const [name, e] of cases) {
    test(`${name} does not read or clear it`, async () => {
      await speak("ana", nowTs(-5));
      await observeEngage(input("ana", e));
      expect(store.takes).toBe(0);
      expect(store.peeks).toBe(0);
      expect(await store.take({ channel: CH, thread: THREAD, persona: "ana" })).not.toBeNull();
    });
  }
  test("a conversational human message reads and clears it", async () => {
    await speak("ana", nowTs(-5));
    expect((await observeEngage(input("ana")))?.reason).toBe("follows_agent");
    expect(store.takes).toBe(1);
    expect(await store.take({ channel: CH, thread: THREAD, persona: "ana" })).toBeNull();
  });
  test("a locked thread does not consume it", async () => {
    await speak("ana", nowTs(-5));
    await observeEngage({ ...input("ana"), locks: { oneOnOne: true, mentionOnly: false, disengaged: false } });
    expect(store.takes).toBe(0);
  });
});

describe("clearAgentRecord", () => {
  test("drops the record when the channel opted in", async () => {
    await speak("ana", nowTs(-5));
    clearAgentRecord({ channel: CH, thread: THREAD, persona: "ana" });
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.take({ channel: CH, thread: THREAD, persona: "ana" })).toBeNull();
  });
  test("does nothing at level mention", async () => {
    await speak("ana", nowTs(-5));
    clearAgentRecord({ channel: "C0QUIET", thread: THREAD, persona: "ana" });
    expect(await store.take({ channel: CH, thread: THREAD, persona: "ana" })).not.toBeNull();
  });
});
