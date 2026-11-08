/**
 * A minimal fake of the Anthropic Messages API (streaming), enough for the
 * real Claude Code CLI to run one tool loop: the first request answers with a
 * single tool_use, any request that already carries a tool_result answers with
 * a final text. Used by the SDK behaviour pins (tests/spike), never by
 * production code.
 */
export interface FakeApi {
  url: string;
  /** Requests seen on /v1/messages. */
  requests: number;
  /** The text of every tool_result the CLI sent back (in order). */
  toolResults: string[];
  stop(): void;
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : "")).join("");
  return "";
}

export function startFakeApi(tool: { name: string; input: Record<string, unknown> }): FakeApi {
  const state: FakeApi = { url: "", requests: 0, toolResults: [], stop: () => {} };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (!u.pathname.endsWith("/v1/messages")) return Response.json({ input_tokens: 10 });
      state.requests++;
      const body = (await req.json()) as { messages: Array<{ role: string; content: unknown }>; model?: string };
      const results: string[] = [];
      for (const m of body.messages) {
        if (m.role !== "user" || !Array.isArray(m.content)) continue;
        for (const b of m.content as Array<Record<string, unknown>>) if (b.type === "tool_result") results.push(resultText(b.content));
      }
      const model = body.model ?? "claude-test";
      const start: [string, unknown] = ["message_start", { type: "message_start", message: { id: `msg_${state.requests}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
      let events: Array<[string, unknown]>;
      if (results.length === 0) {
        events = [
          start,
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_spike_1", name: tool.name, input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
          ["message_stop", { type: "message_stop" }],
        ];
      } else {
        state.toolResults.push(...results.slice(state.toolResults.length));
        events = [
          start,
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "spike done" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
          ["message_stop", { type: "message_stop" }],
        ];
      }
      return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}
