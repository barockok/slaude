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
import { launchBrowser } from "./browser";
import { FluxClient } from "./flux";
import { Mal } from "./mal";
import { resolveNavigator } from "./navigators";
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
      maxTokens: envNum("SLAUDE_VOICE_MAL_MAX_TOKENS"),
    })
  : null;
const speaker = new Speaker(apiKey, process.env.SLAUDE_VOICE_TTS_MODEL);
const pendingDelegates = new Map<number, { question: string; timer: Timer }>();
const DELEGATE_PATIENCE_MS = envNum("SLAUDE_VOICE_DELEGATE_PATIENCE_MS") ?? 45_000;

function envNum(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined ? v : undefined;
}
let delegateSeq = 0;

await ensurePulse();
out({ ev: "status", state: "launching" });

const navigator = resolveNavigator(url);
const ctx = await launchBrowser();
out({ ev: "status", state: "joining" });
const page = await navigator.join(ctx, { url, displayName });
out({ ev: "status", state: "in-call" });

// Higher EOT threshold: field test showed think-aloud pauses ("can you,
// like, ...") fragmenting one request into 4 turns, each triggering MAL.
const flux = new FluxClient({
  apiKey,
  eotThreshold: envNum("SLAUDE_VOICE_EOT_THRESHOLD") ?? 0.85,
});
flux.on("turn", (t) => {
  if (t.event === "Update") return;
  out({ ev: "turn", event: t.event, turn: t.turn_index, transcript: t.transcript });

  if (t.event === "StartOfTurn" && speaker.speaking) speaker.cancel(); // barge-in

  if (t.event === "EndOfTurn" && mal && t.transcript.trim()) {
    void mal
      .onTurn(t.transcript)
      .then(async (d) => {
        if (d.delegate) {
          // Field lesson: fragmented turns produced a fresh filler per
          // fragment while a delegate was already out. One filler, then
          // hold — and if the big brain is slow, apologize exactly once
          // instead of leaving dead air.
          const hadPending = pendingDelegates.size > 0;
          const id = ++delegateSeq;
          const timer = setTimeout(() => {
            if (!pendingDelegates.has(id)) return;
            void speaker
              .speak(
                "Still working on that one — it's taking longer than usual. If it drags on, I'll drop the answer in the Slack thread.",
              )
              .then((spoken) => spoken && out({ ev: "said", text: "(delegate-patience apology)" }));
          }, DELEGATE_PATIENCE_MS);
          pendingDelegates.set(id, { question: d.delegate, timer });
          out({ ev: "delegate", id, question: d.delegate });
          if (d.say && !hadPending) {
            await speaker.speak(d.say);
            out({ ev: "said", text: d.say });
          }
        } else if (d.say) {
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
      const pending = cmd.id !== undefined ? pendingDelegates.get(cmd.id) : undefined;
      if (pending && cmd.id !== undefined) {
        clearTimeout(pending.timer);
        mal?.noteBrainAnswer(pending.question, cmd.text);
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
  await navigator.leave(page);
  await ctx.close().catch(() => {});
  out({ ev: "status", state: "closed" });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
