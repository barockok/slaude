// MAL — Minimal Agentic Loop. The reflex layer of the voice bridge.
//
// A small fast model (any Anthropic-compatible /v1/messages endpoint; we
// run whatever MAL_MODEL/MAL_BASE_URL point at) that keeps the conversation
// natural. Per human turn it either answers directly (small talk, things
// already said in the call) or emits <delegate>question</delegate> to pull
// in the big brain, speaking a short filler so the silence never dangles.
//
// Protocol with the model is plain text, not tool-use: maximum provider
// compatibility, minimum latency.

export interface MalConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  agentName: string;
}

export interface MalDecision {
  say: string | null; // speak immediately (answer OR filler)
  delegate: string | null; // question for the big brain, null = handled
}

const SYSTEM = (name: string) => `You are ${name}, an AI teammate present in a live voice call. You hear a transcript of what participants say. You are the fast reflex layer; a slower, far more capable "big brain" session (with tools, files, and full memory) backs you up.

For every turn addressed to you, reply with EXACTLY one of:
1. A short spoken answer — for greetings, small talk, acknowledgements, or anything answerable from the conversation so far. 1-2 sentences, casual spoken register, no markdown, no lists, no emoji.
2. <delegate>concise self-contained question</delegate> followed on the next line by a short natural filler to say aloud (e.g. "Good question, give me a few seconds."). Use this whenever the request needs tools, code, real data, documents, memory beyond this call, or any action on a computer.

If the turn is not addressed to you and needs no reaction, reply with exactly <skip/>.
Never invent facts or pretend to have run something — that is what delegation is for.`;

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export class Mal {
  #cfg: MalConfig;
  #history: Msg[] = [];

  constructor(cfg: MalConfig) {
    this.#cfg = cfg;
  }

  /** Big-brain answer arrived: remember it so follow-ups have context. */
  noteBrainAnswer(question: string, answer: string): void {
    this.#history.push({
      role: "assistant",
      content: `[big brain answered "${question}"]: ${answer}`,
    });
  }

  /** Something was spoken in the call by us outside the loop. */
  noteSpoken(text: string): void {
    this.#history.push({ role: "assistant", content: text });
  }

  async onTurn(transcript: string): Promise<MalDecision> {
    this.#history.push({ role: "user", content: transcript });
    // Rolling window: keep the last 30 messages.
    if (this.#history.length > 30) this.#history.splice(0, this.#history.length - 30);

    const res = await fetch(`${this.#cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.#cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.#cfg.model,
        max_tokens: 300,
        system: SYSTEM(this.#cfg.agentName),
        messages: this.#history,
      }),
    });
    if (!res.ok) throw new Error(`mal ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      content: { type: string; text?: string }[];
    };
    const text = body.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("")
      .trim();
    this.#history.push({ role: "assistant", content: text });
    return parseDecision(text);
  }
}

export function parseDecision(text: string): MalDecision {
  if (/^<skip\s*\/?>$/i.test(text)) return { say: null, delegate: null };
  const m = text.match(/<delegate>([\s\S]*?)<\/delegate>\s*([\s\S]*)/i);
  if (m) {
    const filler = m[2]?.trim() || "Give me a few seconds to check.";
    return { say: filler, delegate: m[1]!.trim() };
  }
  return { say: text, delegate: null };
}
