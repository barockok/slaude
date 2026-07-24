// Voice bridge — GPT-4o Realtime: join a call, hear it, converse, delegate.
//
// Usage:
//   xvfb-run -a bun src/voice/bridge.ts <call-url> [--name "Trevor"]
//
// Env: OPENAI_API_KEY (required)
//      SLAUDE_VOICE_MODEL  (default: gpt-4o-realtime-preview)
//      SLAUDE_VOICE_VOICE  (default: shimmer)
//
// stdout (one JSON object per line):
//   {"ev":"status","state":"launching|joining|in-call|closed"}
//   {"ev":"transcript","role":"user|assistant","text":"..."}
//   {"ev":"delegate","id":1,"question":"..."}  big brain requested
//   {"ev":"error","message":"..."}
// stdin (one JSON object per line):
//   {"cmd":"say","text":"...","id":1}   answer a delegate
//   {"cmd":"leave"}                     hang up and exit

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { captureCall, ensurePulse, MIC_SINK } from "./audio";
import { launchBrowser } from "./browser";
import { resolveNavigator } from "./navigators";
import { RealtimeClient, REALTIME_SAMPLE_RATE } from "./realtime";
import type { ToolCall } from "./realtime";

function out(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const url = process.argv[2];
const nameIdx = process.argv.indexOf("--name");
const displayName = nameIdx > 0 ? process.argv[nameIdx + 1]! : "Trevor";

if (!url) {
  out({ ev: "error", message: "usage: bridge.ts <call-url> [--name X]" });
  process.exit(2);
}
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  out({ ev: "error", message: "OPENAI_API_KEY not set" });
  process.exit(2);
}

// --- PCM speaker (Realtime audio → bot_mic sink) ---
let paplay: ChildProcessWithoutNullStreams | null = null;

function startPlayback(): ChildProcessWithoutNullStreams {
  const proc = spawn("paplay", [
    `--device=${MIC_SINK}`,
    "--format=s16le",
    `--rate=${REALTIME_SAMPLE_RATE}`,
    "--channels=1",
    "--raw",
  ]) as ChildProcessWithoutNullStreams;
  proc.on("exit", () => { if (paplay === proc) paplay = null; });
  proc.stderr.on("data", () => {});
  return proc;
}

function speakPcm(pcm: Buffer): void {
  if (!paplay) paplay = startPlayback();
  paplay.stdin.write(pcm);
}

function cancelPlayback(): void {
  paplay?.kill("SIGKILL");
  paplay = null;
}

// --- Delegate tracking ---
let delegateSeq = 0;
const pendingDelegates = new Map<number, (answer: string) => void>();

function waitForAnswer(id: number): Promise<string> {
  return new Promise((resolve) => pendingDelegates.set(id, resolve));
}

// --- Boot ---
await ensurePulse();
out({ ev: "status", state: "launching" });

const navigator = resolveNavigator(url);
const ctx = await launchBrowser();
out({ ev: "status", state: "joining" });
const page = await navigator.join(ctx, { url, displayName });
out({ ev: "status", state: "in-call" });

const rt = new RealtimeClient({
  apiKey,
  model: process.env.SLAUDE_VOICE_MODEL,
  voice: process.env.SLAUDE_VOICE_VOICE,
  instructions: `You are ${displayName}, an AI teammate present in a live voice call. You are the conversational layer; a far more capable "big brain" session with tools, files, and full memory backs you up. Use ask_big_brain for anything beyond small talk, greetings, or simple acknowledgements. Keep answers short and in a natural spoken register — no markdown, no lists.`,
  tools: [
    {
      name: "ask_big_brain",
      description:
        "Delegate to the main Claude session which has tools, files, memory, and can take actions. Use whenever the request needs data, computation, documents, or any action on a computer.",
      parameters: {
        type: "object",
        properties: { question: { type: "string", description: "Self-contained question or request" } },
        required: ["question"],
      },
    },
  ],
});

rt.on("audio", speakPcm);

rt.on("barge-in", () => {
  rt.cancel();
  cancelPlayback();
});

rt.on("tool-call", async (tc: ToolCall) => {
  if (tc.name === "ask_big_brain") {
    const question = String((tc.args as { question?: unknown }).question ?? "");
    const id = ++delegateSeq;
    out({ ev: "delegate", id, question });
    const answer = await waitForAnswer(id);
    rt.submitToolResult(tc.callId, answer);
  }
});

rt.on("error", (e: Error) => out({ ev: "error", message: `realtime: ${e.message}` }));
rt.on("close", (code: number) => out({ ev: "status", state: "closed", code }));
rt.connect();

// Capture call audio (24kHz to match Realtime's expected input)
const cap = captureCall(REALTIME_SAMPLE_RATE);
cap.stdout.on("data", (pcm: Buffer) => rt.sendAudio(pcm));
cap.stderr.on("data", () => {});

// Stdin: big-brain session sends delegate answers and leave command
(async () => {
  for await (const line of console) {
    let cmd: { cmd: string; text?: string; id?: number };
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.cmd === "say" && cmd.text && cmd.id !== undefined) {
      const resolve = pendingDelegates.get(cmd.id);
      if (resolve) {
        pendingDelegates.delete(cmd.id);
        resolve(cmd.text);
      }
    } else if (cmd.cmd === "leave") {
      await shutdown();
    }
  }
})();

async function shutdown(): Promise<void> {
  cancelPlayback();
  cap.kill();
  rt.close();
  await navigator.leave(page);
  await ctx.close().catch(() => {});
  out({ ev: "status", state: "closed" });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
