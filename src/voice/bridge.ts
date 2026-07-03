// Voice bridge — milestone 1: join a Google Meet, hear the call, stream
// Flux turn events as JSONL on stdout. The Claude session (or MAL, later)
// consumes that stream.
//
// Usage:
//   xvfb-run -a bun src/voice/bridge.ts <meet-url> [--name "Trevor"]
//
// Env: DEEPGRAM_API_KEY (required)
//
// stdout protocol (one JSON object per line):
//   {"ev":"status","state":"launching|joining|in-call|closed"}
//   {"ev":"turn","event":"EndOfTurn","turn":3,"transcript":"..."}
//   {"ev":"error","message":"..."}

import { captureCall, ensurePulse } from "./audio";
import { FluxClient } from "./flux";
import { joinMeet, launchBrowser, leaveMeet } from "./meet";
import { joinJitsi, leaveJitsi } from "./jitsi";

function out(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj));
}

const url = process.argv[2];
const nameIdx = process.argv.indexOf("--name");
const displayName = nameIdx > 0 ? process.argv[nameIdx + 1]! : "Trevor";

if (!url) {
  out({ ev: "error", message: "usage: bridge.ts <meet-url> [--name X]" });
  process.exit(2);
}
const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) {
  out({ ev: "error", message: "DEEPGRAM_API_KEY not set" });
  process.exit(2);
}

await ensurePulse();
out({ ev: "status", state: "launching" });

const isJitsi = /jit\.si|8x8\.vc/.test(new URL(url).hostname);
const ctx = await launchBrowser();
out({ ev: "status", state: "joining" });
const page = isJitsi
  ? await joinJitsi(ctx, { url, displayName })
  : await joinMeet(ctx, { url, displayName });
out({ ev: "status", state: "in-call" });

const flux = new FluxClient({ apiKey });
flux.on("turn", (t) => {
  // Update events are per-word noise; surface the turn-boundary ones.
  if (t.event === "Update") return;
  out({ ev: "turn", event: t.event, turn: t.turn_index, transcript: t.transcript });
});
flux.on("error", (e) => out({ ev: "error", message: `flux: ${String(e)}` }));
flux.on("close", (code: number) => out({ ev: "status", state: "flux-closed", code }));
flux.connect();

const cap = captureCall();
cap.stdout.on("data", (pcm: Buffer) => flux.write(pcm));
cap.stderr.on("data", () => {});

async function shutdown(): Promise<void> {
  cap.kill();
  flux.close();
  await (isJitsi ? leaveJitsi(page) : leaveMeet(page));
  await ctx.close().catch(() => {});
  out({ ev: "status", state: "closed" });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
