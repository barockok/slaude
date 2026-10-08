/**
 * stdio JSON-lines protocol between the process holding the Claude session
 * (parent) and the voice loop (child) — voice mode spec §4. Secrets never ride
 * this pipe: the provider key and workbench stream token go in the child's env.
 */
import { z } from "zod";
import type { VoiceProviderId } from "./config";

export const ENV_API_KEY = "SLAUDE_VOICE_LOOP_API_KEY";
export const ENV_STREAM_TOKEN = "SLAUDE_VOICE_LOOP_STREAM_TOKEN";

const BASE_REASONS = [
  "stopped", "ended_by_voice", "max_duration", "provider_lost", "provider_failed", "audio_lost",
  "auth_lost", "session_rebooted", "node_drain", "loop_crashed", "parent_gone",
] as const;
export type EndReason = (typeof BASE_REASONS)[number] | `workbench:${string}`;
const endReason = z.string().refine(
  (s) => (BASE_REASONS as readonly string[]).includes(s) || /^workbench:[a-z_]+$/.test(s),
) as unknown as z.ZodType<EndReason>;

export interface AudioEndpoints {
  streamUrl: string;
  clearUrl: string;
  headers: Record<string, string>;
  sampleRate: number;
}
export interface VoiceInit {
  callId: string;
  audio: AudioEndpoints;
  workbenchUrl: string;
  instructions: string;
  provider: VoiceProviderId;
  model: string;
  voice?: string;
  maxMinutes: number;
  staleSeq: number;
}
export type SayMsg = { type: "say"; text: string; when: "next_gap" | "now"; replyTo?: string; asOf: number };
export type ParentMsg =
  | { type: "init"; init: VoiceInit }
  | SayMsg
  | { type: "context"; text: string }
  | { type: "stop"; reason: EndReason };
export type ChildMsg =
  | { type: "started"; callId: string; sampleRate: number }
  | { type: "transcript"; seq: number; role: "user" | "assistant"; text: string }
  | { type: "delegate"; id: string; task: string; asOf: number }
  | { type: "ended"; reason: EndReason }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

const audioEndpoints = z.object({
  streamUrl: z.string().min(1),
  clearUrl: z.string().min(1),
  headers: z.record(z.string()),
  sampleRate: z.union([z.literal(16000), z.literal(24000), z.literal(48000)]),
});
const parentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    init: z.object({
      callId: z.string().min(1),
      audio: audioEndpoints,
      workbenchUrl: z.string().url(),
      instructions: z.string(),
      provider: z.enum(["openai", "gemini"]),
      model: z.string().min(1),
      voice: z.string().optional(),
      maxMinutes: z.number().int().positive(),
      staleSeq: z.number().int().positive(),
    }),
  }),
  z.object({ type: z.literal("say"), text: z.string(), when: z.enum(["next_gap", "now"]), replyTo: z.string().optional(), asOf: z.number().int() }),
  z.object({ type: z.literal("context"), text: z.string() }),
  z.object({ type: z.literal("stop"), reason: endReason }),
]);
const childSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), callId: z.string(), sampleRate: z.number().int() }),
  z.object({ type: z.literal("transcript"), seq: z.number().int(), role: z.enum(["user", "assistant"]), text: z.string() }),
  z.object({ type: z.literal("delegate"), id: z.string(), task: z.string(), asOf: z.number().int() }),
  z.object({ type: z.literal("ended"), reason: endReason }),
  z.object({ type: z.literal("log"), level: z.enum(["info", "warn", "error"]), message: z.string() }),
]);

export function encodeMsg(m: ParentMsg | ChildMsg): string {
  return JSON.stringify(m) + "\n";
}

function parseWith<T>(schema: z.ZodType<T>, line: string): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
}
export const parseParentMsg = (line: string) => parseWith(parentSchema as unknown as z.ZodType<ParentMsg>, line);
export const parseChildMsg = (line: string) => parseWith(childSchema as unknown as z.ZodType<ChildMsg>, line);

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  const tail = (buf + dec.decode()).trim();
  if (tail) yield tail;
}

/**
 * Format a transcript line for the voice loop with role-specific prefixes.
 * Used by conductor and call tasks to format transcript output.
 * @param role "user" or "assistant"
 * @param text the transcript text
 * @returns formatted line with prefix
 */
export function transcriptLine(role: "user" | "assistant", text: string): string {
  return `${role === "user" ? "participant" : "voice"}: ${text}`;
}
