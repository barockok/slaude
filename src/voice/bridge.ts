// Voice bridge — duplex: join a call, hear it (Flux), converse (MAL + Aura),
// delegate hard questions up to the big-brain session via stdio JSONL.
//
// Usage:
//   xvfb-run -a bun src/voice/bridge.ts <call-url> [--name "Trevor"]
//
// Env: DEEPGRAM_API_KEY (required)
//      MAL_API_KEY, MAL_BASE_URL, MAL_MODEL (optional — listen-only without)
//
// stdout (one JSON object per line):
//   {"ev":"status","state":"launching|joining|in-call|closed|flux-closed"}
//   {"ev":"turn","event":"EndOfTurn","turn":3,"transcript":"..."}
//   {"ev":"said","text":"..."}                 what we spoke in the call
//   {"ev":"delegate","id":1,"question":"..."}  big brain requested
//   {"ev":"error","message":"..."}
// stdin (one JSON object per line):
//   {"cmd":"say","text":"...","id":1}   speak; id ties back to a delegate
//   {"cmd":"leave"}                     hang up and exit

import { captureCall, ensurePulse } from "./audio";
import { FluxClient } from "./flux";
import { joinMeet, launchBrowser, leaveMeet } from "./meet";
import { joinJitsi, leaveJitsi } from "./jitsi";
import { Mal } from "./mal";
import { Speaker } from "./tts";

function out(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj));
}

const url = process.argv[2];
const nameIdx = process.argv.indexOf("--name");
const displayName = nameIdx > 0 ? process.argv[nameIdx + 1]! : "Trevor";

if (!url) {
  out({ ev: "error", message: "usage: bridge.ts <call-url> [--name X]" });
  process.exit(2);
}
const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) {
  out({ ev: "error", message: "DEEPGRAM_API_KEY not set" });
  process.exit(2);
}

const mal = process.env.MAL_API_KEY
  ? new Mal({
      apiKey: process.env.MAL_API_KEY,
      baseUrl: process.env.MAL_BASE_URL ?? "https://api.anthropic.com",
      model: process.env.MAL_MODEL ?? "claude-haiku-4-5",
      agentName: displayName,
    })
  : null;
const speaker = new Speaker(apiKey);
const pendingDelegates = new Map<number, string>();
let delegateSeq = 0;

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
  if (t.event === "Update") return;
  out({ ev: "turn", event: t.event, turn: t.turn_index, transcript: t.transcript });

  if (t.event === "StartOfTurn" && speaker.speaking) speaker.cancel(); // barge-in

  if (t.event === "EndOfTurn" && mal && t.transcript.trim()) {
    void mal
      .onTurn(t.transcript)
      .then(async (d) => {
        if (d.delegate) {
          const id = ++delegateSeq;
          pendingDelegates.set(id, d.delegate);
          out({ ev: "delegate", id, question: d.delegate });
        }
        if (d.say) {
          await speaker.speak(d.say);
          out({ ev: "said", text: d.say });
        }
      })
      .catch((e) => out({ ev: "error", message: `mal: ${String(e)}` }));
  }
});
flux.on("error", (e) => out({ ev: "error", message: `flux: ${String(e)}` }));
flux.on("close", (code: number) => out({ ev: "status", state: "flux-closed", code }));
flux.connect();

const cap = captureCall();
cap.stdout.on("data", (pcm: Buffer) => flux.write(pcm));
cap.stderr.on("data", () => {});

// Command channel: the big-brain session drives us through stdin.
(async () => {
  for await (const line of console) {
    let cmd: { cmd: string; text?: string; id?: number };
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.cmd === "say" && cmd.text) {
      const q = cmd.id !== undefined ? pendingDelegates.get(cmd.id) : undefined;
      if (q && cmd.id !== undefined) {
        mal?.noteBrainAnswer(q, cmd.text);
        pendingDelegates.delete(cmd.id);
      } else {
        mal?.noteSpoken(cmd.text);
      }
      await speaker.speak(cmd.text);
      out({ ev: "said", text: cmd.text });
    } else if (cmd.cmd === "leave") {
      await shutdown();
    }
  }
})();

async function shutdown(): Promise<void> {
  speaker.cancel();
  cap.kill();
  flux.close();
  await (isJitsi ? leaveJitsi(page) : leaveMeet(page));
  await ctx.close().catch(() => {});
  out({ ev: "status", state: "closed" });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
