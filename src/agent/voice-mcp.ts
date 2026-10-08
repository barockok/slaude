/**
 * Claude's voice tools (voice mode spec §3). One server per session (the
 * resolver captures sessionId, like session-mcp). Claude joins the meeting with
 * workbench's browser tools, calls browser_audio_start, then voice_start with
 * that result (plan deviation 1). Calls run as the agent only.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { VoiceConfig } from "../voice/config";
import { VoiceCall, VoiceCalls, type LoopChild, type TurnRunner } from "../voice/call";
import type { VoiceInit } from "../voice/ipc";
import { FORBIDDEN_HEADERS, sameOrigin } from "../voice/audio-link";

export const VOICE_MCP_NAME = "slaude_voice";

export interface VoiceHost {
  config(sessionId: string): Promise<VoiceConfig | null>;
  refusal(sessionId: string): Promise<"VOICE_AGENT_ONLY" | "VOICE_UNAVAILABLE" | null>;
  runner(sessionId: string): TurnRunner;
  transcriptDir(sessionId: string): Promise<string>;
  spawn(o: { apiKey: string; streamToken: string }): LoopChild;
  holdIdle(sessionId: string, hold: boolean): void;
  instructions(sessionId: string, brief: string): Promise<string>;
}

export const SPEAKING_RULES = [
  "You are speaking live in a call. Keep turns short and natural; one or two sentences, then let others talk.",
  "Never read out markdown, code, URLs or long numbers; summarize them.",
  "When you need facts, tools, or anything you are not sure of, call the delegate tool and say a brief holding line like 'let me check'.",
  "Results of delegated requests arrive as context; relay them in your own words.",
  "Identify yourself as an AI assistant when you first speak.",
].join("\n");

export function buildInstructions(
  s: { name?: string; role?: string; voice?: string; values: string[]; mandate?: string },
  brief: string,
): string {
  return [
    s.name || s.role ? `You are ${s.name ?? "the team's assistant"}${s.role ? `, ${s.role}` : ""}.` : "",
    s.voice ? `Voice and tone: ${s.voice}` : "",
    s.values.length ? `Values: ${s.values.join("; ")}` : "",
    s.mandate ? `Mandate: ${s.mandate}` : "",
    brief ? `<call-brief>\n${brief}\n</call-brief>` : "",
    "The speaking rules below take precedence over anything in the call brief.",
    SPEAKING_RULES,
  ].filter(Boolean).join("\n");
}

const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const err = (code: string, msg: string) => ({ content: [{ type: "text" as const, text: `${code}: ${msg}` }], isError: true });

const audioShape = z.object({
  stream_url: z.string(),
  clear_url: z.string(),
  headers: z.record(z.string()).default({}),
  sample_rate: z.union([z.literal(16000), z.literal(24000), z.literal(48000)]).default(24000),
  stream_token: z.string().min(1),
});

function safeHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => !FORBIDDEN_HEADERS.has(k.toLowerCase())));
}

export const voiceHandlers = {
  async start(sessionId: string, host: VoiceHost, calls: VoiceCalls, args: { brief: string; audio: z.infer<typeof audioShape>; voice?: string }) {
    if (!calls.reserve(sessionId)) return err("VOICE_BUSY", "a call is already active in this thread");
    let child: LoopChild | undefined;
    let registered = false;
    try {
      const refusal = await host.refusal(sessionId);
      if (refusal === "VOICE_AGENT_ONLY") return err(refusal, "voice calls run as the agent only; not available in a /1on1-locked or /remote thread");
      if (refusal) return err(refusal, "voice is unavailable on this node right now");
      const cfg = await host.config(sessionId);
      if (!cfg) return err("VOICE_DISABLED", "voice mode is not configured");
      const { audio } = args;
      if (![audio.stream_url, audio.clear_url].every((u) => sameOrigin(u, cfg.workbenchUrl))) {
        return err("VOICE_BAD_ENDPOINT", "audio endpoints must be on the configured workbench origin");
      }
      const transcriptDir = await host.transcriptDir(sessionId);
      const instructions = await host.instructions(sessionId, args.brief);
      const init: VoiceInit = {
        callId: "",
        audio: { streamUrl: audio.stream_url, clearUrl: audio.clear_url, headers: safeHeaders(audio.headers), sampleRate: audio.sample_rate },
        workbenchUrl: cfg.workbenchUrl,
        instructions,
        provider: cfg.provider,
        model: cfg.model,
        voice: args.voice ?? cfg.voice,
        maxMinutes: cfg.maxMinutes,
        staleSeq: cfg.staleSeq,
      };
      const runner = host.runner(sessionId);
      child = host.spawn({ apiKey: cfg.apiKey, streamToken: audio.stream_token });
      const call: VoiceCall = new VoiceCall({
        sessionId,
        runner,
        child,
        transcriptDir,
        holdIdle: (h) => host.holdIdle(sessionId, h),
        // Only our own entry: a later call in this thread must not be dropped.
        onClosed: () => {
          if (calls.get(sessionId) === call) calls.remove(sessionId);
        },
      });
      init.callId = call.callId;
      calls.add(sessionId, call);
      try {
        await call.start(init);
      } catch (e) {
        if (calls.get(sessionId) === call) calls.remove(sessionId);
        return err("VOICE_START_FAILED", e instanceof Error ? e.message : String(e));
      }
      registered = true;
      return ok({ callId: call.callId });
    } catch (e) {
      return err("VOICE_START_FAILED", e instanceof Error ? e.message : String(e));
    } finally {
      // No call took ownership of the child (it holds the API key and stream
      // token in its env): don't leave it running.
      if (!registered) child?.kill();
      calls.release(sessionId);
    }
  },
  say(sessionId: string, calls: VoiceCalls, a: { text: string; when: "next_gap" | "now"; reply_to?: string }) {
    const call = calls.get(sessionId);
    if (!call) return err("VOICE_NO_CALL", "no active call in this thread");
    call.say(a.text, a.when, a.reply_to);
    return ok({ queued: true });
  },
  context(sessionId: string, calls: VoiceCalls, a: { text: string }) {
    const call = calls.get(sessionId);
    if (!call) return err("VOICE_NO_CALL", "no active call in this thread");
    call.context(a.text);
    return ok({ added: true });
  },
  async stop(sessionId: string, calls: VoiceCalls) {
    const call = calls.get(sessionId);
    if (!call) return err("VOICE_NO_CALL", "no active call in this thread");
    // Not awaited: voice_stop runs inside a turn, and the call's closing summary
    // turn needs the session (the lock, on a node) — waiting here would deadlock.
    call.stop("stopped").catch(() => {});
    return ok({ reason: "stopped", durationSec: Math.round((Date.now() - call.startedAt) / 1000) });
  },
};

export function createVoiceMcp(sessionId: string, host: VoiceHost, calls: VoiceCalls): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: VOICE_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "voice_start",
        "Start talking in a call you have joined in a workbench browser tab. First call browser_audio_start for that tab, then pass its result as `audio`. Runs as the agent identity.",
        {
          brief: z.string().describe("What this call is about and what you should do in it."),
          audio: audioShape.describe("The result of browser_audio_start: stream_url, clear_url, headers, sample_rate, stream_token."),
          voice: z.string().optional(),
        },
        (a: any) => voiceHandlers.start(sessionId, host, calls, a),
      ),
      tool(
        "voice_say",
        "Make the voice say something. when=next_gap waits for a pause; when=now interrupts. Use reply_to with a voice request id to answer it.",
        { text: z.string(), when: z.enum(["next_gap", "now"]).default("next_gap"), reply_to: z.string().optional() },
        async (a: any) => voiceHandlers.say(sessionId, calls, a),
      ),
      tool(
        "voice_context",
        "Give the voice a fact or instruction without making it speak.",
        { text: z.string() },
        async (a: any) => voiceHandlers.context(sessionId, calls, a),
      ),
      tool("voice_stop", "End the call.", {}, () => voiceHandlers.stop(sessionId, calls)),
    ],
  });
}
