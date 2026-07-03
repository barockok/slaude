// PulseAudio plumbing for the voice bridge.
//
// Two null-sinks:
//   call_out — the browser's speaker. Its .monitor is what the call sounds like.
//   bot_mic  — TTS writes here. Its .monitor is the browser's microphone.
//
// The browser process is pointed at them via PULSE_SINK / PULSE_SOURCE env.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SAMPLE_RATE } from "./pcm";

export const CALL_SINK = "call_out";
export const MIC_SINK = "bot_mic";
// Chrome won't enumerate .monitor sources as microphones — it needs a real
// source, so we remap bot_mic.monitor into one (see ensurePulse).
export const MIC_SOURCE = "virtmic";
export const CALL_MONITOR = `${CALL_SINK}.monitor`;

async function pactl(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["pactl", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`pactl ${args.join(" ")} failed: ${err.trim()}`);
  }
  return out;
}

/** Idempotently ensure both null-sinks exist. Starts pulseaudio if needed. */
export async function ensurePulse(): Promise<void> {
  try {
    await pactl("info");
  } catch {
    Bun.spawnSync(["pulseaudio", "--start", "--exit-idle-time=-1"]);
    await pactl("info");
  }
  const sinks = await pactl("list", "short", "sinks");
  for (const name of [CALL_SINK, MIC_SINK]) {
    if (!sinks.includes(`\t${name}\t`)) {
      await pactl(
        "load-module",
        "module-null-sink",
        `sink_name=${name}`,
        `sink_properties=device.description=${name}`,
      );
    }
  }
  const sources = await pactl("list", "short", "sources");
  if (!sources.includes(`\t${MIC_SOURCE}\t`)) {
    await pactl(
      "load-module",
      "module-remap-source",
      `master=${MIC_SINK}.monitor`,
      `source_name=${MIC_SOURCE}`,
      `source_properties=device.description=${MIC_SOURCE}`,
    );
  }
}

/**
 * Capture what the call sounds like: raw s16le mono 16k PCM from
 * call_out.monitor, suitable for streaming straight into Flux.
 */
export function captureCall(): ChildProcessWithoutNullStreams {
  return spawn("parec", [
    `--device=${CALL_MONITOR}`,
    "--format=s16le",
    `--rate=${SAMPLE_RATE}`,
    "--channels=1",
    "--raw",
    `--latency-msec=80`,
  ]);
}
