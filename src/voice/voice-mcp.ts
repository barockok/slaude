// Voice MCP server — platform-agnostic tools for managing a live call via the bridge.
//
// Exposed as mcp__slaude_voice__* tools to the session. The session can:
//   voice_join(url)        — start a call
//   voice_answer(id, text) — answer a delegate question (fed to Realtime loop)
//   voice_leave()          — hang up
//   voice_status()         — check if a call is active
//
// Delegate flow:
//   bridge emits ev:delegate → VoiceSurface emits "delegate" event
//   → we call onDelegate(id, question) which injects the question into the session
//   → session answers via voice_answer(id, text)
//   → bridge calls rt.submitToolResult → Realtime generates speech

import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { VoiceSurface } from "./surface";
import type { Surface } from "../gateway/core/surface";

export const VOICE_MCP_NAME = "slaude_voice";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export interface VoiceMcpContext {
  /** Platform surface used to post delegate notifications. */
  surface: Surface;
  /** Called when a delegate arrives — inject the question into the active session. */
  onDelegate: (id: number, question: string) => void;
}

export function createVoiceMcp(ctx: VoiceMcpContext): McpSdkServerConfigWithInstance {
  // One VoiceSurface per MCP server instance (= per session).
  const vs = new VoiceSurface();

  vs.on("status", ({ state }: { state: string }) => {
    void ctx.surface.reply({ text: `_[voice: ${state}]_` });
  });

  vs.on("delegate", ({ id, question }: { id: number; question: string }) => {
    void ctx.surface.reply({ text: `_[voice delegate #${id}]_ "${question}"` });
    ctx.onDelegate(id, question);
  });

  vs.on("error", ({ message }: { message: string }) => {
    void ctx.surface.reply({ text: `_[voice error: ${message}]_` });
  });

  vs.on("closed", () => {
    void ctx.surface.reply({ text: "_[voice: call ended]_" });
  });

  return createSdkMcpServer({
    name: VOICE_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "voice_join",
        "Join a video/voice call URL as an audio participant. The bridge opens the call in a headless browser, hears participants via Deepgram Flux, and speaks via the Realtime API. Hard questions from the call are delegated back to this session — answer them with voice_answer.",
        {
          url: z.string().describe("Full meeting URL (Jitsi, Google Meet, etc.)"),
          name: z.string().optional().describe("Display name to join with. Defaults to the agent's persona name."),
        },
        async (args) => {
          if (vs.active) return err("already in a call — use voice_leave first");
          try {
            vs.join(args.url, args.name);
            return ok(`joining ${args.url} — status updates will appear in the thread`);
          } catch (e) {
            return err(`voice_join failed: ${String(e)}`);
          }
        },
      ),

      tool(
        "voice_answer",
        "Send a text answer back to an active call delegate. The bridge submits this as a function result to the Realtime API, which synthesizes spoken audio. Call this after receiving a voice delegate question.",
        {
          id: z.number().describe("Delegate ID from the voice-delegate message"),
          text: z.string().describe("Answer text to speak in the call"),
        },
        async (args) => {
          if (!vs.active) return err("no active call");
          vs.answer(args.id, args.text);
          return ok(`answered delegate #${args.id}`);
        },
      ),

      tool(
        "voice_leave",
        "Hang up the current call and shut down the bridge.",
        {},
        async () => {
          if (!vs.active) return ok("no active call");
          vs.leave();
          return ok("leaving call…");
        },
      ),

      tool(
        "voice_status",
        "Check whether a call is currently active and which URL is being bridged.",
        {},
        async () => ok(JSON.stringify({ active: vs.active, url: vs.url })),
      ),
    ],
  });
}
