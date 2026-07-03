import { afterEach, describe, expect, test } from "bun:test";
import { Mal, parseDecision } from "../src/voice/mal";

describe("parseDecision", () => {
  test("plain text is spoken directly", () => {
    expect(parseDecision("Yeah, I can hear you fine.")).toEqual({
      say: "Yeah, I can hear you fine.",
      delegate: null,
    });
  });

  test("<skip/> stays silent", () => {
    expect(parseDecision("<skip/>")).toEqual({ say: null, delegate: null });
    expect(parseDecision("<skip>")).toEqual({ say: null, delegate: null });
  });

  test("delegate with filler on the next line", () => {
    const d = parseDecision(
      "<delegate>How much disk space is left?</delegate>\nSure, let me check that for you.",
    );
    expect(d.delegate).toBe("How much disk space is left?");
    expect(d.say).toBe("Sure, let me check that for you.");
  });

  test("delegate without filler gets a default", () => {
    const d = parseDecision("<delegate>What did we decide yesterday?</delegate>");
    expect(d.delegate).toBe("What did we decide yesterday?");
    expect(d.say).toBe("Give me a few seconds to check.");
  });

  test("multiline delegate question survives", () => {
    const d = parseDecision("<delegate>line one\nline two</delegate>\nOn it.");
    expect(d.delegate).toBe("line one\nline two");
    expect(d.say).toBe("On it.");
  });
});

describe("Mal loop", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubMal(reply: string) {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: reply }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const mal = new Mal({
      apiKey: "k",
      baseUrl: "https://example.invalid",
      model: "m",
      agentName: "Trevor",
    });
    return { mal, bodies };
  }

  test("sends system prompt and rolling history; thinking blocks ignored", async () => {
    const { mal, bodies } = stubMal("Hello there.");
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Hello there." },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const d = await mal.onTurn("Hey Trevor");
    expect(d).toEqual({ say: "Hello there.", delegate: null });
    const body = bodies.at(-1);
    expect(body.system).toContain("Trevor");
    // The fresh user turn is the last message in the request; the assistant
    // reply is only folded into history after the response arrives.
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "Hey Trevor" });
  });

  test("history window trims to 30 messages", async () => {
    const { mal, bodies } = stubMal("ok");
    for (let i = 0; i < 25; i++) await mal.onTurn(`turn ${i}`);
    // 24 completed turns push 48 messages; the 25th user turn makes 49,
    // trimmed to the 30 most recent before the request goes out.
    const last = bodies.at(-1);
    expect(last.messages.length).toBeLessThanOrEqual(30);
    expect(last.messages.at(-1).content).toBe("turn 24");
  });

  test("big-brain answers fold into context", async () => {
    const { mal, bodies } = stubMal("ok");
    mal.noteBrainAnswer("disk space?", "22 percent used");
    await mal.onTurn("thanks");
    const contents = bodies.at(-1).messages.map((m: any) => m.content).join("\n");
    expect(contents).toContain("22 percent used");
  });

  test("non-200 throws with body excerpt", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream sad", { status: 500 })) as unknown as typeof fetch;
    const mal = new Mal({
      apiKey: "k",
      baseUrl: "https://example.invalid",
      model: "m",
      agentName: "T",
    });
    await expect(mal.onTurn("hi")).rejects.toThrow("mal 500");
  });
});
