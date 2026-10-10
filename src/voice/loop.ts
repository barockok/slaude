/**
 * The voice loop (voice mode spec §5): provider ⇄ conductor ⇄ browser audio pipe,
 * plus the parent's inbox (say/context/stop). Runs in the `slaude voice-loop`
 * child; dependencies are injected so tests run it in-process with fakes.
 */
import { Conductor, VOICE_TOOLS } from "./conductor";
import type { AudioLinkLike } from "./audio-link";
import type { ChildMsg, EndReason, ParentMsg, VoiceInit } from "./ipc";
import type { VoiceProvider } from "./provider/types";
import { resample } from "./resample";

export interface LoopDeps {
  init: VoiceInit;
  makeProvider(): VoiceProvider;
  audio: AudioLinkLike;
  inbox: AsyncIterable<ParentMsg>;
  emit(m: ChildMsg): void;
  now?: () => number;
  tickMs?: number;
  reconnectDelayMs?: number;
}

const MAX_RECONNECTS = 3;
/** Upper bound on closing the provider and audio link at the end of a call. */
const CLOSE_WAIT_MS = 2_500;

export async function runVoiceLoop(d: LoopDeps): Promise<EndReason> {
  const now = d.now ?? Date.now;
  let resolveEnd!: (r: EndReason) => void;
  const ended = new Promise<EndReason>((r) => (resolveEnd = r));
  let finished = false;
  const end = (r: EndReason) => {
    if (finished) return;
    finished = true;
    resolveEnd(r);
  };

  let provider = d.makeProvider();
  let reconnecting = false;
  // Pending while a reconnect runs: say/context wait for the new provider
  // instead of going to the closed one.
  let providerReady: Promise<void> = Promise.resolve();
  let markReady = () => {};
  // Providers whose connect() has resolved. Error events from a provider still
  // handshaking are ignored: the connect() rejection is the failed attempt.
  const connected = new WeakSet<VoiceProvider>();
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const conductor = new Conductor(
    {
      provider,
      audio: d.audio,
      emit: d.emit,
      end,
      reconnect: () => void reconnect("planned"),
    },
    { outputRate: d.init.audio.sampleRate, staleSeq: d.init.staleSeq, maxMs: d.init.maxMinutes * 60_000, startedAt: now() },
  );

  const attach = (p: VoiceProvider) => {
    p.on("audio", (pcm, item) => conductor.onAudio(resample(pcm, p.caps.outputRate, d.init.audio.sampleRate), item));
    p.on("transcript", (t) => conductor.onTranscript(t));
    p.on("speechStarted", () => {
      conductor.onSpeechStarted().catch((e) => d.emit({ type: "log", level: "warn", message: `speech flush failed: ${errMsg(e)}` }));
    });
    p.on("speechStopped", () => conductor.onSpeechStopped());
    p.on("responseDone", () => conductor.onResponseDone());
    p.on("toolCall", (c) => conductor.onToolCall(c, now()));
    p.on("error", (e) => {
      if (!connected.has(p)) return;
      if (e.fatal) end("provider_failed");
      else d.emit({ type: "log", level: "warn", message: `provider: ${e.message}` });
    });
    p.on("closed", () => {
      if (p === provider && !finished) void reconnect("dropped");
    });
  };

  const connect = async (p: VoiceProvider, seed?: string) => {
    await p.connect({ instructions: d.init.instructions, tools: VOICE_TOOLS, voice: d.init.voice, seed });
    connected.add(p);
  };

  async function reconnect(why: "planned" | "dropped"): Promise<void> {
    if (reconnecting || finished) return;
    reconnecting = true;
    providerReady = new Promise<void>((r) => (markReady = r));
    const old = provider;
    await old.close().catch(() => {});
    for (let attempt = 1; attempt <= MAX_RECONNECTS && !finished; attempt++) {
      const p = d.makeProvider();
      provider = p;
      attach(p);
      try {
        await connect(p, conductor.recentTranscript(20));
        conductor.setProvider(p);
        conductor.onReconnected(now());
        d.emit({ type: "log", level: "info", message: `provider reconnected (${why}, attempt ${attempt})` });
        reconnecting = false;
        markReady();
        return;
      } catch {
        await p.close().catch(() => {});
        if (attempt < MAX_RECONNECTS) await Bun.sleep((d.reconnectDelayMs ?? 500) * attempt);
      }
    }
    reconnecting = false;
    markReady();
    end("provider_lost");
  }

  attach(provider);
  try {
    await connect(provider);
  } catch (e) {
    d.emit({ type: "log", level: "error", message: `provider connect failed: ${errMsg(e)}` });
    d.emit({ type: "ended", reason: "provider_failed" });
    await provider.close().catch(() => {});
    await d.audio.close().catch(() => {});
    return "provider_failed";
  }

  try {
    await d.audio.start({
      onAudio: (pcm) => {
        if (reconnecting) return;
        provider.sendAudio(resample(pcm, d.init.audio.sampleRate, provider.caps.inputRate));
      },
      onEnded: (reason) => end(reason as EndReason),
    });
  } catch (e) {
    d.emit({ type: "log", level: "error", message: `audio start failed: ${errMsg(e)}` });
    end("audio_lost");
  }
  if (!finished) d.emit({ type: "started", callId: d.init.callId, sampleRate: d.init.audio.sampleRate });

  const ticker = setInterval(() => conductor.tick(now()), d.tickMs ?? 250);
  const inboxFailed = (e: unknown) => {
    d.emit({ type: "log", level: "error", message: `inbox failed: ${errMsg(e)}` });
    end("loop_crashed");
  };
  // say/context run in order on their own chain so a slow say (a flush's
  // clear round trip) never holds up reading a stop. During a reconnect the
  // chain waits for the new provider, then replays in order.
  let steer: Promise<void> = Promise.resolve();
  const onSteer = (fn: () => void | Promise<void>) => {
    steer = steer
      .then(async () => {
        while (reconnecting && !finished) await Promise.race([providerReady, ended]);
        if (!finished) await fn();
      })
      .catch(inboxFailed);
  };
  void (async () => {
    for await (const m of d.inbox) {
      if (finished) break;
      if (m.type === "say") onSteer(() => conductor.say(m));
      else if (m.type === "context") onSteer(() => conductor.context(m.text));
      else if (m.type === "stop") end(m.reason);
    }
    end("parent_gone");
  })().catch(inboxFailed);

  const reason = await ended;
  clearInterval(ticker);
  // Close both at once and bound the wait: a hung audio close must not leave
  // the provider socket open or the parent without its `ended`.
  await Promise.race([
    Promise.all([provider.close().catch(() => {}), d.audio.close().catch(() => {})]),
    Bun.sleep(CLOSE_WAIT_MS),
  ]);
  d.emit({ type: "ended", reason });
  return reason;
}
