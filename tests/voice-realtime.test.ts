import { describe, expect, test, mock } from "bun:test";
import { RealtimeClient, REALTIME_SAMPLE_RATE } from "../src/voice/realtime";
import type { ToolCall } from "../src/voice/realtime";

describe("REALTIME_SAMPLE_RATE", () => {
  test("is 24000", () => expect(REALTIME_SAMPLE_RATE).toBe(24000));
});

describe("RealtimeClient event handling", () => {
  function makeClient() {
    const client = new RealtimeClient({
      apiKey: "test-key",
      model: "gpt-4o-realtime-preview",
      voice: "shimmer",
      instructions: "You are Trevor.",
      tools: [
        {
          name: "ask_big_brain",
          description: "Delegate to main session",
          parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
        },
      ],
    });
    const dispatch = (msg: Record<string, unknown>) =>
      (client as unknown as { handle: (m: Record<string, unknown>) => void }).handle(msg);
    return { client, dispatch };
  }

  test("barge-in event emitted on speech_started", () => {
    const { client, dispatch } = makeClient();
    const handler = mock(() => {});
    client.on("barge-in", handler);
    dispatch({ type: "input_audio_buffer.speech_started" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("audio event emits decoded buffer on audio.delta", () => {
    const { client, dispatch } = makeClient();
    const chunks: Buffer[] = [];
    client.on("audio", (buf: Buffer) => chunks.push(buf));
    const raw = Buffer.from("hello");
    dispatch({ type: "response.audio.delta", delta: raw.toString("base64") });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(raw);
  });

  test("tool-call emitted after output_item.added + args.done", () => {
    const { client, dispatch } = makeClient();
    const calls: ToolCall[] = [];
    client.on("tool-call", (tc: ToolCall) => calls.push(tc));

    dispatch({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "c1", name: "ask_big_brain" },
    });
    dispatch({ type: "response.function_call_arguments.delta", call_id: "c1", delta: '{"question":' });
    dispatch({ type: "response.function_call_arguments.delta", call_id: "c1", delta: '"disk space?"}' });
    dispatch({ type: "response.function_call_arguments.done", call_id: "c1", arguments: '{"question":"disk space?"}' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("ask_big_brain");
    expect(calls[0]!.callId).toBe("c1");
    expect((calls[0]!.args as { question: string }).question).toBe("disk space?");
  });

  test("tool-call not emitted without prior output_item.added", () => {
    const { client, dispatch } = makeClient();
    const calls: ToolCall[] = [];
    client.on("tool-call", (tc: ToolCall) => calls.push(tc));
    dispatch({ type: "response.function_call_arguments.done", call_id: "unknown", arguments: "{}" });
    expect(calls).toHaveLength(0);
  });

  test("error event on error message", () => {
    const { client, dispatch } = makeClient();
    const errors: Error[] = [];
    client.on("error", (e: Error) => errors.push(e));
    dispatch({ type: "error", error: { message: "bad request" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("bad request");
  });

  test("unknown event types are silently ignored", () => {
    const { client, dispatch } = makeClient();
    // should not throw
    expect(() => dispatch({ type: "session.created", session: {} })).not.toThrow();
    expect(() => dispatch({ type: "response.done" })).not.toThrow();
  });
});
