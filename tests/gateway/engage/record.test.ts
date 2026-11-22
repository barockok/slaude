import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../../src/persona/agent-def";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import type { Persona } from "../../../src/persona/types";
import { __setConversationLogForTests, logKey, memoryConversationLog, type ConversationLog } from "../../../src/gateway/engage/conversation-log";
import { __setLastSpeakerStoreForTests, memoryLastSpeakerStore } from "../../../src/gateway/engage/last-speaker";
import { noteAgentMessage, noteConversation } from "../../../src/gateway/engage/record";

const CH = "C0SHARED";
const yaml = (name: string, user: string, level: string) => `
name: ${name}
slackUserId: ${user}
soul: You are ${name}.
access:
  channels:
    trusted: [${CH}]
channels:
  ${CH}: { engage: { level: ${level}, mode: on } }
`;
function persona(name: string, user: string, level: string): Persona {
  const { spec } = parseAgentYaml(name, yaml(name, user, level));
  const { soulData, ...definition } = spec.definition;
  return { name, slackUserId: user, soulMd: spec.soul, config: { slackUserId: user, name }, outClient: null, model: null, runsOn: null, provider: null, kbSources: null, background: null, mcp: null, soulJson: soulData, definition } as Persona;
}
const registry = (...ps: Persona[]): PersonaRegistry => ({
  lookupByUserId: (id) => ps.find((p) => p.slackUserId === id) ?? null, lookupByName: (n) => ps.find((p) => p.name === n) ?? null, list: () => ps,
  isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null, defaultPersona: () => ({ model: null, mcp: null, definition: null }),
} as PersonaRegistry);

let log: ConversationLog;
beforeEach(() => {
  log = memoryConversationLog();
  __setConversationLogForTests(log);
  __setLastSpeakerStoreForTests(memoryLastSpeakerStore());
  setPersonaRegistry(registry(persona("ana", "UANA1", "contribute"), persona("quiet", "UQUIET1", "mention")));
});
afterEach(() => {
  __setConversationLogForTests(null);
  __setLastSpeakerStoreForTests(null);
  __resetPersonaRegistry();
});
const top = () => log.recent(logKey("slack", CH), 10);
const thread = (t: string) => log.recent(logKey("slack", CH, t), 10);

describe("noteAgentMessage feeds the conversation log", () => {
  test("a top-level post is logged in the channel and as the head of its own thread", async () => {
    noteAgentMessage({ channel: CH, thread: null, ts: "1700000000.000100", persona: "ana", text: "here is the answer" });
    await Bun.sleep(5);
    expect(await top()).toEqual([{ ref: "1700000000.000100", author: "", isBot: true, text: "here is the answer", agent: "ana" }]);
    expect((await thread("1700000000.000100")).map((x) => x.text)).toEqual(["here is the answer"]);
  });
  test("a post in a thread is logged in that thread only, with its threadRef", async () => {
    noteAgentMessage({ channel: CH, thread: "1700000000.000001", ts: "1700000000.000200", persona: "ana", text: "in thread" });
    await Bun.sleep(5);
    expect(await top()).toEqual([]);
    expect(await thread("1700000000.000001")).toEqual([{ ref: "1700000000.000200", author: "", isBot: true, text: "in thread", threadRef: "1700000000.000001", agent: "ana" }]);
  });
  test("the outbound call and its echo make one entry", async () => {
    noteAgentMessage({ channel: CH, thread: "1700000000.000001", ts: "1700000000.000200", persona: "ana", text: "in thread" });
    noteAgentMessage({ channel: CH, thread: "1700000000.000001", ts: "1700000000.000200", persona: "ana", text: "in thread", author: "UANA1", fromEcho: true });
    await Bun.sleep(5);
    expect(await thread("1700000000.000001")).toHaveLength(1);
  });
  test("the default persona is logged as \"default\"", async () => {
    noteAgentMessage({ channel: CH, thread: null, ts: "1700000000.000100", persona: null, viewer: "ana", text: "hi" });
    await Bun.sleep(5);
    expect((await top())[0]!.agent).toBe("default");
  });
  test("nothing is written at level mention, or for an empty text, or a ts that is not a message", async () => {
    noteAgentMessage({ channel: CH, thread: null, ts: "1700000000.000100", persona: "quiet", text: "hello" });
    noteAgentMessage({ channel: CH, thread: null, ts: "1700000000.000101", persona: "ana", text: "   " });
    noteAgentMessage({ channel: CH, thread: null, ts: "not-a-ts", persona: "ana", text: "x" });
    await Bun.sleep(5);
    expect(await top()).toEqual([]);
  });
  test("an echo is judged by the persona whose copy hears it: another agent's post is kept for a persona that is listening", async () => {
    // "quiet" posted it (its own level is mention) and the copy that heard the echo is ana's (level contribute).
    noteAgentMessage({ channel: CH, thread: null, ts: "1700000000.000100", persona: "quiet", viewer: "ana", text: "from quiet", author: "UQUIET1", fromEcho: true });
    await Bun.sleep(5);
    expect((await top()).map((x) => [x.agent, x.author])).toEqual([["quiet", "UQUIET1"]]);
  });
  test("a log that fails never fails the post", () => {
    __setConversationLogForTests({ append: () => { throw new Error("boom"); }, recent: async () => [] });
    expect(() => noteAgentMessage({ channel: CH, thread: null, ts: "1700000000.000100", persona: "ana", text: "x" })).not.toThrow();
  });
});

describe("noteConversation feeds what people and bots said", () => {
  test("a person's top-level message and a thread reply", async () => {
    noteConversation({ channel: CH, thread: null, ts: "1700000000.000100", text: "anyone know?", author: "U0PERSON", isBot: false, viewer: "ana" });
    noteConversation({ channel: CH, thread: "1700000000.000100", ts: "1700000000.000150", text: "no idea", author: "U0OTHER", isBot: false, viewer: "ana" });
    await Bun.sleep(5);
    expect((await top()).map((x) => x.text)).toEqual(["anyone know?"]);
    expect((await thread("1700000000.000100")).map((x) => [x.text, x.threadRef])).toEqual([["anyone know?", undefined], ["no idea", "1700000000.000100"]]);
  });
  test("a bot is logged with isBot; the same message twice is one entry (message and app_mention)", async () => {
    const n = { channel: CH, thread: null, ts: "1700000000.000100", text: "build done", author: "B0CI", isBot: true, viewer: "ana" };
    noteConversation(n);
    noteConversation(n);
    await Bun.sleep(5);
    expect(await top()).toEqual([{ ref: "1700000000.000100", author: "B0CI", isBot: true, text: "build done" }]);
  });
  test("level mention writes nothing; a subtype that is not conversation is skipped", async () => {
    noteConversation({ channel: CH, thread: null, ts: "1700000000.000100", text: "hello", author: "U0PERSON", isBot: false, viewer: "quiet" });
    noteConversation({ channel: CH, thread: null, ts: "1700000000.000101", text: "joined", author: "U0PERSON", isBot: false, viewer: "ana", subtype: "channel_join" });
    await Bun.sleep(5);
    expect(await top()).toEqual([]);
  });
});
