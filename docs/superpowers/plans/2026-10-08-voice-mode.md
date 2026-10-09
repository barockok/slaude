# Voice Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the thread's Claude session join a browser-tab call (via workbench) and talk in it through a realtime voice model running in a slim subprocess, delegating thinking back to the session and taking steering from it.

**Architecture:** A plain-Bun child process (`slaude voice-loop`) bridges workbench's PCM audio streams to a realtime voice provider through a normalized adapter. A `Conductor` (pure state machine) glues provider events, audio flushing, steering and delegation. The parent (the process holding the warm Claude session: a node, or mono) owns a `VoiceCall` that buffers the transcript, runs delegated turns on the warm session through a `TurnRunner`, and exposes `voice_start/say/context/stop` to Claude through an in-process MCP server.

**Tech Stack:** Bun + TypeScript, `bun test`, zod, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`, `tool`), Bun `WebSocket` client, `fetch` with streaming request bodies, `Bun.serve` for fakes.

**Spec:** `docs/superpowers/specs/2026-10-08-voice-mode-design.md`

## Deviations from the spec (decided after spec approval)

1. **Workbench auth.** Workbench (separate repo, done by the owner, not in this plan) adds a `stream_token` to `browser_audio_start`'s result: a capability that authorizes only that tab's three audio routes for that audio session. Claude calls `browser_audio_start` itself (it already has workbench's MCP tools in mono and on nodes) and passes the result into `voice_start`. The VL has no MCP client. At the end, the summary prompt tells Claude to call `browser_audio_stop` and leave the meeting. (Replaces spec §5.5's "VL calls browser_audio_start through an MCP client".)
2. **Voice config from env, not persona.** v1 reads `SLAUDE_VOICE_*` env. Mono reads its own env. In the gateway topology the gateway reads its env and ships a `voice` block inside the runtime bundle to nodes; nodes never read a voice key from their own env. The persona `voice` block with `vault://` references is a follow-up plan. (Replaces spec §9's persona block.)
3. **Quiet thread = surface suppression.** Final text is posted by Claude's `reply` tool, not by events. During voice-origin turns, `reply / edit / react / unreact / upload / typing` are no-ops (mono: wrapped surface; node: the tool shim), and the mono stop guard does not force a reply. No `origin` field on events.
4. **Transcript file is written by the parent**, from the `transcript` IPC messages, into the session's `working_dir`. The `ended` IPC message has no `transcriptPath`.
5. **"In call" status** is Claude's own reply in the `voice_start` turn. No status-line machinery.

## Global Constraints

- Feature flag: `SLAUDE_VOICE_ENABLED` default `false`; when off, voice tools are not registered.
- `SLAUDE_VOICE_MAX_MINUTES` default `120`. `SLAUDE_VOICE_STALE_SEQ` default `6`.
- `SLAUDE_VOICE_MODEL` is provider-qualified, default `openai/gpt-realtime`. Providers: `openai`, `gemini`.
- Calls run as the agent identity only: `voice_start` is refused in a `/1on1`-locked or `/remote` thread (`VOICE_AGENT_ONLY`).
- Secrets (provider API key, workbench `stream_token`) reach the child through its environment only, never argv, never the stdio pipe.
- Audio is never logged. Transcript text never goes to application logs or the `log` IPC message.
- Delegate "still working" nudge at 60 s; cap warning 2 minutes before the cap; transcript idle flush 30 s.
- Provider reconnect: up to 3 attempts with backoff. Workbench SSE reconnect: up to 3 attempts.
- Public repo: no internal names, channels, hosts. Placeholders only (`example.com`, `#team-channel`).
- No AI co-author trailers on commits.
- Tests live under `tests/` (not colocated). Run with `bun test <path>`.
- Ships as `vX.Y.Z-rc.N` (touches the agent loop).

## Review Focus

1. **Human talks over the agent while a long answer is still queued in workbench.** Expect the agent to stop within ~one frame and the model's memory to be truncated to what was heard, not the full answer. (Task 8 test "flush truncates to played audio and resets the uplink clock".)
2. **Claude steers "now" about something said several turns ago.** Expect it to wait for a gap instead of cutting someone off. (Task 8 test "stale now steer downgrades to next_gap".)
3. **A Slack message arrives in the thread while a delegated voice turn is running on a node.** Expect no interleaving on the warm session: the voice turn finishes first or the voice runner retries until the lock frees. (Task 13 test "node runner retries while the lock is held".)
4. **Claude, during a voice turn, calls `reply` (habit) or the mono stop guard fires.** Expect nothing posted to Slack during the call. (Task 11 tests "voice turn suppresses reply" and "stop guard skips voice turns".)
5. **The session idles out or reboots mid-call** (config fingerprint change, persona reload). Expect the call to end with `session_rebooted`, not a silent orphan child. (Task 10 test "sessionExit fires on teardown" and Task 12 test "session exit ends the call".)

---

## File structure

| file | responsibility |
|---|---|
| `src/voice/config.ts` | `VoiceConfig` type, `parseVoiceModel`, `voiceConfigFromEnv`, `voiceBundleFromEnv`, `voiceConfigFromBundle` |
| `src/voice/ipc.ts` | parent↔child message types, zod parsers, JSON-lines encode/decode |
| `src/voice/resample.ts` | linear s16le mono resampler |
| `src/voice/provider/types.ts` | `VoiceProvider`, `VoiceProviderCaps`, `ProviderEvents`, `ToolSpec`, `TypedEmitter` |
| `src/voice/provider/openai-realtime.ts` | OpenAI Realtime WebSocket adapter |
| `src/voice/provider/gemini-live.ts` | Gemini Live WebSocket adapter |
| `src/voice/provider/index.ts` | `createProvider(cfg)` |
| `src/voice/audio-link.ts` | workbench SSE, chunked uplink, clear |
| `src/voice/conductor.ts` | pure conversation glue |
| `src/voice/loop.ts` | `runVoiceLoop(deps)`, wires provider + audio + conductor + inbox |
| `src/voice/loop-entry.ts` | child process entry (`slaude voice-loop`) |
| `src/voice/turn-flags.ts` | process-local "voice turn running" flags |
| `src/voice/runners.ts` | `TurnRunner`, `waitTurnDone`, `monoRunner`, `nodeRunner` |
| `src/voice/spawn.ts` | `spawnVoiceLoop` → `LoopChild` |
| `src/voice/call.ts` | `VoiceCall` (parent side of one call), `VoiceCalls` registry |
| `src/agent/voice-mcp.ts` | `createVoiceMcp`, `VoiceHost`, `voiceRefusal` |
| `src/config/env.ts` | `env.voice.*` readers (modify) |
| `bin/slaude.ts` | `voice-loop` subcommand (modify) |
| `src/agent/manager.ts` | `holdIdle`, `sessionExit` emit (modify) |
| `src/gateway/core/gateway.ts` | wrapSurface voice suppression, stop guard, mono voice MCP wiring (modify) |
| `src/node/shims/index.ts` | voice suppression in surface shim (modify) |
| `src/node/worker.ts` | job tracking, voice MCP wiring, drain hook (modify) |
| `src/gateway/api/tenants.ts` | `RuntimeBundle.voice` (modify) |

---

### Task 1: Voice config and env readers

**Files:**
- Create: `src/voice/config.ts`
- Modify: `src/config/env.ts` (add a `voice` group inside `export const env = {…}`, next to the other groups)
- Test: `tests/voice/config.test.ts`

**Interfaces:**
- Produces:
  - `type VoiceProviderId = "openai" | "gemini"`
  - `interface VoiceConfig { provider: VoiceProviderId; model: string; voice?: string; apiKey: string; workbenchUrl: string; maxMinutes: number; staleSeq: number }`
  - `interface VoiceBundle { model: string; voice?: string; apiKey: string; workbenchUrl: string }` (qualified `model`, e.g. `openai/gpt-realtime`)
  - `parseVoiceModel(qualified: string): { provider: VoiceProviderId; model: string }` (throws on unknown provider or missing `/`)
  - `voiceConfigFromEnv(): VoiceConfig | null` (null when disabled or key/workbench URL missing)
  - `voiceBundleFromEnv(): VoiceBundle | null`
  - `voiceConfigFromBundle(b: VoiceBundle | null | undefined): VoiceConfig | null` (maxMinutes/staleSeq from local env)
  - `env.voice.enabled(): boolean`, `env.voice.model(): string`, `env.voice.voiceName(): string | undefined`, `env.voice.apiKey(): string | undefined`, `env.voice.workbenchUrl(): string | undefined`, `env.voice.maxMinutes(): number`, `env.voice.staleSeq(): number`

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/config.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { parseVoiceModel, voiceConfigFromEnv, voiceBundleFromEnv, voiceConfigFromBundle } from "../../src/voice/config";

const KEYS = ["SLAUDE_VOICE_ENABLED", "SLAUDE_VOICE_MODEL", "SLAUDE_VOICE_NAME", "SLAUDE_VOICE_API_KEY",
  "SLAUDE_VOICE_WORKBENCH_URL", "SLAUDE_VOICE_MAX_MINUTES", "SLAUDE_VOICE_STALE_SEQ"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe("parseVoiceModel", () => {
  it("splits provider and model", () => {
    expect(parseVoiceModel("openai/gpt-realtime")).toEqual({ provider: "openai", model: "gpt-realtime" });
    expect(parseVoiceModel("gemini/gemini-live-2.5-flash")).toEqual({ provider: "gemini", model: "gemini-live-2.5-flash" });
  });
  it("rejects unknown provider and unqualified names", () => {
    expect(() => parseVoiceModel("nope/x")).toThrow(/unknown voice provider/);
    expect(() => parseVoiceModel("gpt-realtime")).toThrow(/provider-qualified/);
  });
});

describe("voiceConfigFromEnv", () => {
  it("is null when disabled", () => {
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    expect(voiceConfigFromEnv()).toBeNull();
  });
  it("is null when enabled without key or workbench url", () => {
    process.env.SLAUDE_VOICE_ENABLED = "true";
    expect(voiceConfigFromEnv()).toBeNull();
  });
  it("builds the config with defaults", () => {
    process.env.SLAUDE_VOICE_ENABLED = "true";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    expect(voiceConfigFromEnv()).toEqual({
      provider: "openai", model: "gpt-realtime", voice: undefined, apiKey: "k",
      workbenchUrl: "https://wb.example.com", maxMinutes: 120, staleSeq: 6,
    });
  });
  it("round-trips through the bundle shape", () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_NAME = "marin";
    process.env.SLAUDE_VOICE_MAX_MINUTES = "30";
    const b = voiceBundleFromEnv();
    expect(b).toEqual({ model: "openai/gpt-realtime", voice: "marin", apiKey: "k", workbenchUrl: "https://wb.example.com" });
    expect(voiceConfigFromBundle(b)!.maxMinutes).toBe(30);
    expect(voiceConfigFromBundle(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/voice/config.test.ts`
Expected: FAIL — cannot resolve `../../src/voice/config`.

- [ ] **Step 3: Add env readers**

In `src/config/env.ts`, inside `export const env = {`, add (uses the file's existing `opt` and `positiveInt` helpers):

```ts
  voice: {
    enabled: (): boolean => {
      const raw = opt("SLAUDE_VOICE_ENABLED", "0").toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    },
    model: (): string => opt("SLAUDE_VOICE_MODEL", "openai/gpt-realtime"),
    voiceName: (): string | undefined => opt("SLAUDE_VOICE_NAME", "") || undefined,
    apiKey: (): string | undefined => opt("SLAUDE_VOICE_API_KEY", "") || undefined,
    workbenchUrl: (): string | undefined => opt("SLAUDE_VOICE_WORKBENCH_URL", "") || undefined,
    maxMinutes: (): number => positiveInt("SLAUDE_VOICE_MAX_MINUTES", 120),
    staleSeq: (): number => positiveInt("SLAUDE_VOICE_STALE_SEQ", 6),
  },
```

- [ ] **Step 4: Write `src/voice/config.ts`**

```ts
/**
 * Voice provider configuration (voice mode spec §9, plan deviation 2). v1 reads
 * SLAUDE_VOICE_* env: mono from its own env; in the gateway topology the
 * gateway reads env and ships a VoiceBundle in the runtime bundle, so a node
 * never holds a voice key in its own environment.
 */
import { env } from "../config/env";

export type VoiceProviderId = "openai" | "gemini";
const PROVIDERS: readonly VoiceProviderId[] = ["openai", "gemini"];

export interface VoiceConfig {
  provider: VoiceProviderId;
  model: string;
  voice?: string;
  apiKey: string;
  workbenchUrl: string;
  maxMinutes: number;
  staleSeq: number;
}

/** What the gateway ships to a node. `model` stays provider-qualified. */
export interface VoiceBundle {
  model: string;
  voice?: string;
  apiKey: string;
  workbenchUrl: string;
}

export function parseVoiceModel(qualified: string): { provider: VoiceProviderId; model: string } {
  const i = qualified.indexOf("/");
  if (i <= 0 || i === qualified.length - 1) {
    throw new Error(`voice model must be provider-qualified, e.g. openai/gpt-realtime (got '${qualified}')`);
  }
  const provider = qualified.slice(0, i) as VoiceProviderId;
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown voice provider '${provider}'`);
  return { provider, model: qualified.slice(i + 1) };
}

export function voiceBundleFromEnv(): VoiceBundle | null {
  if (!env.voice.enabled()) return null;
  const apiKey = env.voice.apiKey();
  const workbenchUrl = env.voice.workbenchUrl();
  if (!apiKey || !workbenchUrl) return null;
  const model = env.voice.model();
  parseVoiceModel(model); // fail loudly on a bad model at the source
  return { model, voice: env.voice.voiceName(), apiKey, workbenchUrl };
}

export function voiceConfigFromBundle(b: VoiceBundle | null | undefined): VoiceConfig | null {
  if (!b) return null;
  const { provider, model } = parseVoiceModel(b.model);
  return {
    provider, model, voice: b.voice, apiKey: b.apiKey, workbenchUrl: b.workbenchUrl,
    maxMinutes: env.voice.maxMinutes(), staleSeq: env.voice.staleSeq(),
  };
}

export function voiceConfigFromEnv(): VoiceConfig | null {
  return voiceConfigFromBundle(voiceBundleFromEnv());
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/voice/config.test.ts`
Expected: PASS (4 + 2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/voice/config.ts src/config/env.ts tests/voice/config.test.ts
git commit -m "feat(voice): voice provider config from SLAUDE_VOICE_* env"
```

---

### Task 2: IPC protocol

**Files:**
- Create: `src/voice/ipc.ts`
- Test: `tests/voice/ipc.test.ts`

**Interfaces:**
- Consumes: `VoiceProviderId` from Task 1.
- Produces:
  - `type EndReason = "stopped" | "ended_by_voice" | "max_duration" | "provider_lost" | "provider_failed" | "audio_lost" | "auth_lost" | "session_rebooted" | "node_drain" | "loop_crashed" | "parent_gone" | \`workbench:${string}\``
  - `interface AudioEndpoints { streamUrl: string; clearUrl: string; headers: Record<string, string>; sampleRate: number }`
  - `interface VoiceInit { callId: string; audio: AudioEndpoints; workbenchUrl: string; instructions: string; provider: VoiceProviderId; model: string; voice?: string; maxMinutes: number; staleSeq: number }`
  - `type SayMsg = { type: "say"; text: string; when: "next_gap" | "now"; replyTo?: string; asOf: number }`
  - `type ParentMsg = { type: "init"; init: VoiceInit } | SayMsg | { type: "context"; text: string } | { type: "stop"; reason: EndReason }`
  - `type ChildMsg = { type: "started"; callId: string; sampleRate: number } | { type: "transcript"; seq: number; role: "user" | "assistant"; text: string } | { type: "delegate"; id: string; task: string; asOf: number } | { type: "ended"; reason: EndReason } | { type: "log"; level: "info" | "warn" | "error"; message: string }`
  - `encodeMsg(m: ParentMsg | ChildMsg): string` (one JSON line ending in `\n`)
  - `readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string>`
  - `parseParentMsg(line: string): ParentMsg | null`, `parseChildMsg(line: string): ChildMsg | null`
  - Env var names: `export const ENV_API_KEY = "SLAUDE_VOICE_LOOP_API_KEY"`, `export const ENV_STREAM_TOKEN = "SLAUDE_VOICE_LOOP_STREAM_TOKEN"`

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/ipc.test.ts
import { describe, it, expect } from "bun:test";
import { encodeMsg, readLines, parseParentMsg, parseChildMsg } from "../../src/voice/ipc";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); } });
}

describe("ipc", () => {
  it("encodes one JSON line per message", () => {
    expect(encodeMsg({ type: "context", text: "hi" })).toBe('{"type":"context","text":"hi"}\n');
  });
  it("reassembles lines split across chunks", async () => {
    const out: string[] = [];
    for await (const l of readLines(streamOf(['{"a":', '1}\n{"b"', ':2}\n', '{"c":3}']))) out.push(l);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
  it("parses valid parent messages and rejects junk", () => {
    expect(parseParentMsg('{"type":"say","text":"x","when":"now","asOf":3}')).toEqual({ type: "say", text: "x", when: "now", asOf: 3 });
    expect(parseParentMsg('{"type":"say","text":"x","when":"later","asOf":3}')).toBeNull();
    expect(parseParentMsg("not json")).toBeNull();
  });
  it("parses child messages including workbench end reasons", () => {
    expect(parseChildMsg('{"type":"ended","reason":"workbench:tab_closed"}')).toEqual({ type: "ended", reason: "workbench:tab_closed" });
    expect(parseChildMsg('{"type":"ended","reason":"bogus"}')).toBeNull();
    expect(parseChildMsg('{"type":"delegate","id":"1","task":"t","asOf":0}')).toEqual({ type: "delegate", id: "1", task: "t", asOf: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/voice/ipc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/voice/ipc.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/voice/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/voice/ipc.ts tests/voice/ipc.test.ts
git commit -m "feat(voice): stdio JSON-lines protocol between session and voice loop"
```

---

### Task 3: Resampler

**Files:**
- Create: `src/voice/resample.ts`
- Test: `tests/voice/resample.test.ts`

**Interfaces:**
- Produces: `resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array` (returns input unchanged when rates are equal)

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/resample.test.ts
import { describe, it, expect } from "bun:test";
import { resample } from "../../src/voice/resample";

function tone(freq: number, rate: number, ms: number): Int16Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(12000 * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}
// Zero-crossing frequency estimate: crossings/2 per second.
function dominant(pcm: Int16Array, rate: number): number {
  let c = 0;
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1]! < 0) !== (pcm[i]! < 0)) c++;
  return (c / 2) / (pcm.length / rate);
}

describe("resample", () => {
  it("is identity for equal rates", () => {
    const x = tone(440, 24000, 100);
    expect(resample(x, 24000, 24000)).toBe(x);
  });
  it("keeps length proportional and frequency stable 24k→16k", () => {
    const x = tone(440, 24000, 500);
    const y = resample(x, 24000, 16000);
    expect(y.length).toBe(Math.round(x.length * 16000 / 24000));
    expect(Math.abs(dominant(y, 16000) - 440)).toBeLessThan(10);
  });
  it("upsamples 16k→24k", () => {
    const y = resample(tone(300, 16000, 500), 16000, 24000);
    expect(Math.abs(dominant(y, 24000) - 300)).toBeLessThan(10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/voice/resample.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
/** Linear-interpolation resampler for s16le mono PCM (voice mode spec §5.2).
 *  Speech-band quality is enough for realtime models; no DSP dependency. */
export function resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return pcm;
  const outLen = Math.round((pcm.length * toRate) / fromRate);
  const out = new Int16Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = pcm[j] ?? 0;
    const b = pcm[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/voice/resample.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/voice/resample.ts tests/voice/resample.test.ts
git commit -m "feat(voice): linear PCM resampler"
```

---

### Task 4: Provider interface and fake provider

**Files:**
- Create: `src/voice/provider/types.ts`
- Create: `tests/voice/fakes.ts` (shared fakes for later tasks)
- Test: `tests/voice/provider-types.test.ts`

**Interfaces:**
- Produces (in `src/voice/provider/types.ts`):
  - `interface VoiceProviderCaps { inputRate: 16000 | 24000; outputRate: 16000 | 24000; truncate: boolean; maxSessionSec?: number }`
  - `interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }`
  - `interface ProviderEvents { audio: (pcm: Int16Array, itemId: string) => void; transcript: (t: { role: "user" | "assistant"; text: string; itemId: string }) => void; speechStarted: () => void; speechStopped: () => void; responseDone: () => void; toolCall: (c: { callId: string; name: string; args: unknown }) => void; error: (e: { fatal: boolean; message: string }) => void; closed: () => void }`
  - `class TypedEmitter<E>` with `on<K extends keyof E>(k: K, cb: E[K]): void` and `protected fire<K extends keyof E>(k: K, ...args: Parameters<E[K]>): void`
  - `interface ProviderConnect { instructions: string; tools: ToolSpec[]; voice?: string; seed?: string }`
  - `interface VoiceProvider { readonly caps: VoiceProviderCaps; connect(init: ProviderConnect): Promise<void>; sendAudio(pcm: Int16Array): void; addContext(text: string): void; respond(): void; cancel(): void; truncate(itemId: string, ms: number): void; toolResult(callId: string, output: unknown): void; close(): Promise<void>; on<K extends keyof ProviderEvents>(k: K, cb: ProviderEvents[K]): void }`
- Produces (in `tests/voice/fakes.ts`): `class FakeProvider` (records calls in `calls: Array<[string, ...unknown[]]>`, exposes `emitEvent(k, ...args)`, `connects: ProviderConnect[]`, configurable `caps`), `class FakeAudio` (records `written: Int16Array[]`, `clears: number`, `clearResult: { playedMs: number; clearedMs: number }`, `start(h)` stores handlers in `handlers`, `closed: boolean`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/provider-types.test.ts
import { describe, it, expect } from "bun:test";
import { TypedEmitter } from "../../src/voice/provider/types";

type E = { ping: (n: number) => void };
class X extends TypedEmitter<E> { go(n: number) { this.fire("ping", n); } }

describe("TypedEmitter", () => {
  it("delivers to every listener in order", () => {
    const x = new X();
    const got: number[] = [];
    x.on("ping", (n) => got.push(n));
    x.on("ping", (n) => got.push(n * 10));
    x.go(2);
    expect(got).toEqual([2, 20]);
  });
  it("a throwing listener does not stop the others", () => {
    const x = new X();
    const got: number[] = [];
    x.on("ping", () => { throw new Error("boom"); });
    x.on("ping", (n) => got.push(n));
    x.go(1);
    expect(got).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/voice/provider-types.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/voice/provider/types.ts`**

```ts
/**
 * Provider-agnostic realtime voice interface (voice mode spec §5.1). Adapters
 * translate one vendor wire protocol into these events and methods; nothing
 * outside src/voice/provider/ knows a vendor event name.
 */
export interface VoiceProviderCaps {
  inputRate: 16000 | 24000;
  outputRate: 16000 | 24000;
  truncate: boolean;
  maxSessionSec?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderEvents {
  audio: (pcm: Int16Array, itemId: string) => void;
  transcript: (t: { role: "user" | "assistant"; text: string; itemId: string }) => void;
  speechStarted: () => void;
  speechStopped: () => void;
  responseDone: () => void;
  toolCall: (c: { callId: string; name: string; args: unknown }) => void;
  error: (e: { fatal: boolean; message: string }) => void;
  closed: () => void;
}

export interface ProviderConnect {
  instructions: string;
  tools: ToolSpec[];
  voice?: string;
  /** Prior conversation to restore after a reconnect (plain text). */
  seed?: string;
}

export interface VoiceProvider {
  readonly caps: VoiceProviderCaps;
  connect(init: ProviderConnect): Promise<void>;
  sendAudio(pcm: Int16Array): void;
  addContext(text: string): void;
  respond(): void;
  cancel(): void;
  truncate(itemId: string, ms: number): void;
  toolResult(callId: string, output: unknown): void;
  close(): Promise<void>;
  on<K extends keyof ProviderEvents>(k: K, cb: ProviderEvents[K]): void;
}

export class TypedEmitter<E> {
  #subs = new Map<keyof E, Array<(...a: any[]) => void>>();
  on<K extends keyof E>(k: K, cb: E[K]): void {
    const list = this.#subs.get(k) ?? [];
    list.push(cb as unknown as (...a: any[]) => void);
    this.#subs.set(k, list);
  }
  protected fire<K extends keyof E>(k: K, ...args: E[K] extends (...a: infer A) => any ? A : never): void {
    for (const cb of this.#subs.get(k) ?? []) {
      try {
        cb(...args);
      } catch (e) {
        console.error(`[voice] listener for ${String(k)} threw:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

/** PCM s16le helpers shared by adapters and the audio link. */
export function pcmToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}
export function base64ToPcm(b64: string): Int16Array {
  const bytes = Uint8Array.from(Buffer.from(b64, "base64")); // copy → aligned buffer
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
}
```

- [ ] **Step 4: Write `tests/voice/fakes.ts`**

```ts
// tests/voice/fakes.ts — shared fakes for voice tests.
import { TypedEmitter, type ProviderConnect, type ProviderEvents, type VoiceProvider, type VoiceProviderCaps } from "../../src/voice/provider/types";

export class FakeProvider extends TypedEmitter<ProviderEvents> implements VoiceProvider {
  caps: VoiceProviderCaps = { inputRate: 24000, outputRate: 24000, truncate: true };
  calls: Array<[string, ...unknown[]]> = [];
  connects: ProviderConnect[] = [];
  connectError: Error | null = null;
  async connect(init: ProviderConnect) {
    this.connects.push(init);
    if (this.connectError) throw this.connectError;
  }
  sendAudio(pcm: Int16Array) { this.calls.push(["sendAudio", pcm.length]); }
  addContext(text: string) { this.calls.push(["addContext", text]); }
  respond() { this.calls.push(["respond"]); }
  cancel() { this.calls.push(["cancel"]); }
  truncate(itemId: string, ms: number) { this.calls.push(["truncate", itemId, ms]); }
  toolResult(callId: string, output: unknown) { this.calls.push(["toolResult", callId, output]); }
  async close() { this.calls.push(["close"]); }
  emitEvent<K extends keyof ProviderEvents>(k: K, ...args: Parameters<ProviderEvents[K]>) {
    this.fire(k, ...(args as any));
  }
  named(name: string) { return this.calls.filter((c) => c[0] === name); }
}

export interface AudioHandlers { onAudio(pcm: Int16Array): void; onEnded(reason: string): void }
export class FakeAudio {
  written: Int16Array[] = [];
  clears = 0;
  clearResult = { playedMs: 0, clearedMs: 0 };
  handlers: AudioHandlers | null = null;
  closed = false;
  async start(h: AudioHandlers) { this.handlers = h; }
  write(pcm: Int16Array) { this.written.push(pcm); }
  async clear() { this.clears++; return this.clearResult; }
  async close() { this.closed = true; }
}

/** n samples of silence. */
export const pcm = (n: number) => new Int16Array(n);
```

- [ ] **Step 5: Run to verify it passes** — `bun test tests/voice/provider-types.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/voice/provider/types.ts tests/voice/fakes.ts tests/voice/provider-types.test.ts
git commit -m "feat(voice): provider-agnostic realtime voice interface"
```

---

### Task 5: OpenAI Realtime adapter

**Files:**
- Create: `src/voice/provider/openai-realtime.ts`
- Test: `tests/voice/openai-realtime.test.ts`

**Interfaces:**
- Consumes: `TypedEmitter`, `VoiceProvider`, `ProviderEvents`, `ProviderConnect`, `pcmToBase64`, `base64ToPcm` (Task 4).
- Produces: `class OpenAIRealtime implements VoiceProvider` with constructor `new OpenAIRealtime({ apiKey: string; model: string; url?: string; transcribeModel?: string })`. `caps = { inputRate: 24000, outputRate: 24000, truncate: true, maxSessionSec: 3600 }`.

- [ ] **Step 1: Pin the wire protocol against current docs**

Open the OpenAI Realtime API reference (WebSocket, GA) and confirm these names. If any differ, use the documented name in both the adapter and the test fixture below; do not change the slaude-side interface.
- client: `session.update`, `input_audio_buffer.append`, `conversation.item.create`, `response.create`, `response.cancel`, `conversation.item.truncate`
- server: `session.updated`, `response.output_audio.delta` (`delta`, `item_id`), `response.output_audio_transcript.done` (`transcript`, `item_id`), `conversation.item.input_audio_transcription.completed` (`transcript`, `item_id`), `input_audio_buffer.speech_started`, `input_audio_buffer.speech_stopped`, `response.function_call_arguments.done` (`call_id`, `name`, `arguments`), `response.done`, `error` (`error.message`, `error.type`)

- [ ] **Step 2: Write the failing test (fake WS server)**

```ts
// tests/voice/openai-realtime.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { OpenAIRealtime } from "../../src/voice/provider/openai-realtime";
import { pcmToBase64 } from "../../src/voice/provider/types";

type Srv = { url: string; frames: any[]; send(obj: unknown): void; headers: Headers | null; stop(): void; closeClient(): void };
function fakeServer(onFrame?: (f: any, s: Srv) => void): Srv {
  let sock: any = null;
  const s: Srv = {
    url: "", frames: [], headers: null,
    send: (o) => sock?.send(JSON.stringify(o)),
    stop: () => server.stop(true),
    closeClient: () => sock?.close(1011, "bye"),
  };
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { s.headers = req.headers; return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { sock = ws; },
      message(_ws, m) { const f = JSON.parse(String(m)); s.frames.push(f); onFrame?.(f, s); },
    },
  });
  s.url = `ws://localhost:${server.port}/v1/realtime`;
  return s;
}
const until = async (c: () => boolean, ms = 2000) => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(5); } };

let srv: Srv | null = null;
afterEach(() => srv?.stop());

describe("OpenAIRealtime", () => {
  it("connects with bearer auth and sends session.update with tools and audio format", async () => {
    srv = fakeServer((f, s) => { if (f.type === "session.update") s.send({ type: "session.updated" }); });
    const p = new OpenAIRealtime({ apiKey: "sk-test", model: "gpt-realtime", url: srv.url });
    await p.connect({ instructions: "be brief", tools: [{ name: "delegate", description: "d", parameters: { type: "object" } }], voice: "marin" });
    expect(srv.headers!.get("authorization")).toBe("Bearer sk-test");
    const su = srv.frames.find((f) => f.type === "session.update");
    expect(su.session.instructions).toBe("be brief");
    expect(su.session.tools[0]).toMatchObject({ type: "function", name: "delegate" });
    expect(su.session.audio.output.voice).toBe("marin");
    expect(su.session.audio.input.turn_detection).toMatchObject({ type: "server_vad", interrupt_response: true });
    await p.close();
  });

  it("maps client methods to frames", async () => {
    srv = fakeServer((f, s) => { if (f.type === "session.update") s.send({ type: "session.updated" }); });
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [] });
    p.sendAudio(new Int16Array([1, 2]));
    p.addContext("fact");
    p.respond();
    p.cancel();
    p.truncate("item_1", 1234);
    p.toolResult("call_1", { id: "1", status: "working" });
    await until(() => srv!.frames.length >= 8);
    const types = srv.frames.map((f) => f.type);
    expect(types).toEqual(["session.update", "input_audio_buffer.append", "conversation.item.create", "response.create",
      "response.cancel", "conversation.item.truncate", "conversation.item.create", "response.create"]);
    expect(srv.frames[1].audio).toBe(pcmToBase64(new Int16Array([1, 2])));
    expect(srv.frames[2].item).toMatchObject({ type: "message", role: "system" });
    expect(srv.frames[5]).toMatchObject({ item_id: "item_1", content_index: 0, audio_end_ms: 1234 });
    expect(srv.frames[6].item).toMatchObject({ type: "function_call_output", call_id: "call_1", output: '{"id":"1","status":"working"}' });
    await p.close();
  });

  it("maps server events to slaude events", async () => {
    srv = fakeServer((f, s) => { if (f.type === "session.update") s.send({ type: "session.updated" }); });
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    const got: any[] = [];
    p.on("audio", (pcm, item) => got.push(["audio", pcm.length, item]));
    p.on("transcript", (t) => got.push(["transcript", t.role, t.text]));
    p.on("speechStarted", () => got.push(["speechStarted"]));
    p.on("speechStopped", () => got.push(["speechStopped"]));
    p.on("toolCall", (c) => got.push(["toolCall", c.callId, c.name, c.args]));
    p.on("responseDone", () => got.push(["responseDone"]));
    p.on("error", (e) => got.push(["error", e.fatal]));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "response.output_audio.delta", item_id: "i1", delta: pcmToBase64(new Int16Array(4)) });
    srv.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "hello" });
    srv.send({ type: "response.output_audio_transcript.done", item_id: "i1", transcript: "hi there" });
    srv.send({ type: "input_audio_buffer.speech_started" });
    srv.send({ type: "input_audio_buffer.speech_stopped" });
    srv.send({ type: "response.function_call_arguments.done", call_id: "c1", name: "delegate", arguments: '{"task":"x"}' });
    srv.send({ type: "response.done" });
    srv.send({ type: "error", error: { type: "invalid_request_error", message: "bad" } });
    await until(() => got.length >= 8);
    expect(got).toEqual([
      ["audio", 4, "i1"], ["transcript", "user", "hello"], ["transcript", "assistant", "hi there"],
      ["speechStarted"], ["speechStopped"], ["toolCall", "c1", "delegate", { task: "x" }], ["responseDone"], ["error", false],
    ]);
    await p.close();
  });

  it("treats auth errors as fatal and an unexpected close as non-fatal + closed", async () => {
    srv = fakeServer((f, s) => { if (f.type === "session.update") s.send({ type: "session.updated" }); });
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    const got: any[] = [];
    p.on("error", (e) => got.push(["error", e.fatal]));
    p.on("closed", () => got.push(["closed"]));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "error", error: { type: "authentication_error", message: "no" } });
    srv.closeClient();
    await until(() => got.length >= 3);
    expect(got).toEqual([["error", true], ["error", false], ["closed"]]);
  });

  it("sends the seed as a system item after session.update", async () => {
    srv = fakeServer((f, s) => { if (f.type === "session.update") s.send({ type: "session.updated" }); });
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [], seed: "earlier: user asked X" });
    await until(() => srv!.frames.length >= 2);
    expect(srv.frames[1].item.content[0].text).toContain("earlier: user asked X");
    await p.close();
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `bun test tests/voice/openai-realtime.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/voice/provider/openai-realtime.ts`**

```ts
/**
 * OpenAI Realtime over WebSocket (server-to-server). Event names are pinned
 * here and in tests/voice/openai-realtime.test.ts only. Server VAD with
 * interrupt_response: the provider decides and cancels interruptions itself;
 * flushing audio already handed to workbench is the Conductor's job (spec §5.4).
 */
import {
  TypedEmitter, base64ToPcm, pcmToBase64,
  type ProviderConnect, type ProviderEvents, type VoiceProvider, type VoiceProviderCaps,
} from "./types";

const FATAL_ERROR_TYPES = new Set(["authentication_error", "permission_error", "insufficient_quota", "invalid_api_key"]);

export class OpenAIRealtime extends TypedEmitter<ProviderEvents> implements VoiceProvider {
  readonly caps: VoiceProviderCaps = { inputRate: 24000, outputRate: 24000, truncate: true, maxSessionSec: 3600 };
  #ws: WebSocket | null = null;
  #closing = false;
  constructor(private o: { apiKey: string; model: string; url?: string; transcribeModel?: string }) {
    super();
  }

  async connect(init: ProviderConnect): Promise<void> {
    const url = `${this.o.url ?? "wss://api.openai.com/v1/realtime"}?model=${encodeURIComponent(this.o.model)}`;
    // Bun's WebSocket accepts request headers as a second-argument option.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.o.apiKey}` } } as any);
    this.#ws = ws;
    this.#closing = false;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("realtime connect timeout")), 10_000);
      ws.onopen = () => {
        this.#send({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: init.instructions,
            tools: init.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: this.o.transcribeModel ?? "gpt-4o-mini-transcribe" },
                turn_detection: { type: "server_vad", interrupt_response: true, create_response: true },
              },
              output: { format: { type: "audio/pcm", rate: 24000 }, ...(init.voice ? { voice: init.voice } : {}) },
            },
          },
        });
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === "session.updated") {
          clearTimeout(t);
          if (init.seed) this.addContext(`Conversation so far (restored after reconnect):\n${init.seed}`);
          resolve();
        } else if (m.type === "error" && FATAL_ERROR_TYPES.has(m.error?.type)) {
          clearTimeout(t);
          reject(new Error(m.error?.message ?? "realtime error"));
        }
        this.#onServer(m);
      };
      ws.onerror = () => { clearTimeout(t); reject(new Error("realtime websocket error")); };
      ws.onclose = () => {
        clearTimeout(t);
        if (!this.#closing) {
          this.fire("error", { fatal: false, message: "realtime connection closed" });
          this.fire("closed");
        }
      };
    });
  }

  #onServer(m: any): void {
    switch (m.type) {
      case "response.output_audio.delta":
        this.fire("audio", base64ToPcm(m.delta), m.item_id);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (m.transcript?.trim()) this.fire("transcript", { role: "user", text: m.transcript.trim(), itemId: m.item_id });
        break;
      case "response.output_audio_transcript.done":
        if (m.transcript?.trim()) this.fire("transcript", { role: "assistant", text: m.transcript.trim(), itemId: m.item_id });
        break;
      case "input_audio_buffer.speech_started":
        this.fire("speechStarted");
        break;
      case "input_audio_buffer.speech_stopped":
        this.fire("speechStopped");
        break;
      case "response.function_call_arguments.done": {
        let args: unknown = {};
        try { args = JSON.parse(m.arguments || "{}"); } catch { args = {}; }
        this.fire("toolCall", { callId: m.call_id, name: m.name, args });
        break;
      }
      case "response.done":
        this.fire("responseDone");
        break;
      case "error":
        this.fire("error", { fatal: FATAL_ERROR_TYPES.has(m.error?.type), message: String(m.error?.message ?? "error") });
        break;
    }
  }

  #send(o: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(o));
  }
  sendAudio(pcm: Int16Array): void { this.#send({ type: "input_audio_buffer.append", audio: pcmToBase64(pcm) }); }
  addContext(text: string): void {
    this.#send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
  }
  respond(): void { this.#send({ type: "response.create" }); }
  cancel(): void { this.#send({ type: "response.cancel" }); }
  truncate(itemId: string, ms: number): void {
    this.#send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(ms)) });
  }
  toolResult(callId: string, output: unknown): void {
    this.#send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    this.#send({ type: "response.create" });
  }
  async close(): Promise<void> {
    this.#closing = true;
    try { this.#ws?.close(1000, "done"); } catch {}
    this.#ws = null;
  }
}
```

- [ ] **Step 5: Run to verify it passes** — `bun test tests/voice/openai-realtime.test.ts` → PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/voice/provider/openai-realtime.ts tests/voice/openai-realtime.test.ts
git commit -m "feat(voice): OpenAI Realtime adapter"
```

---

### Task 6: Gemini Live adapter and provider factory

**Files:**
- Create: `src/voice/provider/gemini-live.ts`
- Create: `src/voice/provider/index.ts`
- Test: `tests/voice/gemini-live.test.ts`

**Interfaces:**
- Consumes: Task 4 types; `VoiceProviderId` (Task 1).
- Produces:
  - `class GeminiLive implements VoiceProvider`, constructor `new GeminiLive({ apiKey: string; model: string; url?: string })`; `caps = { inputRate: 16000, outputRate: 24000, truncate: false, maxSessionSec: 840 }`. Item ids are synthesized per model turn: `"g1"`, `"g2"`, ….
  - `createProvider(o: { provider: VoiceProviderId; model: string; apiKey: string }): VoiceProvider`

- [ ] **Step 1: Pin the wire protocol against current docs**

Open the Gemini Live API (BidiGenerateContent WebSocket) reference and confirm: endpoint `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=…`; client `setup` (model, generationConfig.responseModalities, speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, systemInstruction, tools.functionDeclarations, inputAudioTranscription, outputAudioTranscription), `realtimeInput.audio` (`data`, `mimeType: "audio/pcm;rate=16000"`), `clientContent` (`turns`, `turnComplete`), `toolResponse.functionResponses`; server `setupComplete`, `serverContent.modelTurn.parts[].inlineData.data`, `serverContent.interrupted`, `serverContent.turnComplete`, `serverContent.inputTranscription.text`, `serverContent.outputTranscription.text`, `toolCall.functionCalls[]` (`id`, `name`, `args`). Server frames may arrive as binary; decode as UTF-8 JSON. If names differ, use the documented ones in adapter and fixture.

- [ ] **Step 2: Write the failing test**

```ts
// tests/voice/gemini-live.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { GeminiLive } from "../../src/voice/provider/gemini-live";
import { createProvider } from "../../src/voice/provider";
import { OpenAIRealtime } from "../../src/voice/provider/openai-realtime";
import { pcmToBase64 } from "../../src/voice/provider/types";

function fakeServer() {
  let sock: any = null;
  const s: any = { frames: [] as any[], url: "", query: "" };
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { s.query = new URL(req.url).search; return srv.upgrade(req) ? undefined : new Response("", { status: 400 }); },
    websocket: {
      open(ws) { sock = ws; },
      message(_ws, m) {
        const f = JSON.parse(String(m)); s.frames.push(f);
        if (f.setup) sock.send(new TextEncoder().encode(JSON.stringify({ setupComplete: {} }))); // binary frame
      },
    },
  });
  s.url = `ws://localhost:${server.port}/live`;
  s.send = (o: unknown) => sock.send(JSON.stringify(o));
  s.stop = () => server.stop(true);
  return s;
}
const until = async (c: () => boolean, ms = 2000) => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(5); } };
let srv: any = null;
afterEach(() => srv?.stop());

describe("GeminiLive", () => {
  it("sends setup with key, tools, transcription and voice", async () => {
    srv = fakeServer();
    const p = new GeminiLive({ apiKey: "gk", model: "gemini-live-x", url: srv.url });
    await p.connect({ instructions: "be brief", tools: [{ name: "delegate", description: "d", parameters: { type: "object" } }], voice: "Puck" });
    expect(srv.query).toContain("key=gk");
    const setup = srv.frames[0].setup;
    expect(setup.model).toBe("models/gemini-live-x");
    expect(setup.systemInstruction.parts[0].text).toBe("be brief");
    expect(setup.tools[0].functionDeclarations[0].name).toBe("delegate");
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect(p.caps.truncate).toBe(false);
    await p.close();
  });

  it("maps methods and events; accumulates transcription chunks until turnComplete", async () => {
    srv = fakeServer();
    const p = new GeminiLive({ apiKey: "gk", model: "m", url: srv.url });
    const got: any[] = [];
    p.on("audio", (pcm, item) => got.push(["audio", pcm.length, item]));
    p.on("transcript", (t) => got.push(["transcript", t.role, t.text]));
    p.on("speechStarted", () => got.push(["speechStarted"]));
    p.on("toolCall", (c) => got.push(["toolCall", c.callId, c.name, c.args]));
    p.on("responseDone", () => got.push(["responseDone"]));
    await p.connect({ instructions: "", tools: [] });
    p.sendAudio(new Int16Array(2));
    p.addContext("fact");
    p.respond();
    p.toolResult("fc1", { ok: true });
    await until(() => srv.frames.length >= 5);
    expect(srv.frames[1].realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(srv.frames[2].clientContent).toMatchObject({ turnComplete: false });
    expect(srv.frames[3].clientContent).toMatchObject({ turnComplete: true });
    expect(srv.frames[4].toolResponse.functionResponses[0]).toMatchObject({ id: "fc1", response: { ok: true } });

    srv.send({ serverContent: { inputTranscription: { text: "hel" } } });
    srv.send({ serverContent: { inputTranscription: { text: "lo" } } });
    srv.send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcmToBase64(new Int16Array(6)) } }] }, outputTranscription: { text: "hi" } } });
    srv.send({ serverContent: { turnComplete: true } });
    srv.send({ serverContent: { interrupted: true } });
    srv.send({ toolCall: { functionCalls: [{ id: "fc2", name: "delegate", args: { task: "t" } }] } });
    await until(() => got.length >= 6);
    expect(got).toEqual([
      ["audio", 6, "g1"], ["transcript", "user", "hello"], ["transcript", "assistant", "hi"], ["responseDone"],
      ["speechStarted"], ["toolCall", "fc2", "delegate", { task: "t" }],
    ]);
    await p.close();
  });
});

describe("createProvider", () => {
  it("picks the adapter by provider id", () => {
    expect(createProvider({ provider: "openai", model: "m", apiKey: "k" })).toBeInstanceOf(OpenAIRealtime);
    expect(createProvider({ provider: "gemini", model: "m", apiKey: "k" })).toBeInstanceOf(GeminiLive);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `bun test tests/voice/gemini-live.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/voice/provider/gemini-live.ts`**

```ts
/**
 * Gemini Live (BidiGenerateContent) over WebSocket. No item truncation: the
 * server handles interruption itself (`interrupted`), so caps.truncate=false and
 * the Conductor only flushes workbench audio. Gemini has no item ids; one is
 * synthesized per model turn. Transcription arrives in chunks and is emitted
 * whole when the side's turn ends.
 */
import {
  TypedEmitter, base64ToPcm, pcmToBase64,
  type ProviderConnect, type ProviderEvents, type VoiceProvider, type VoiceProviderCaps,
} from "./types";

export class GeminiLive extends TypedEmitter<ProviderEvents> implements VoiceProvider {
  readonly caps: VoiceProviderCaps = { inputRate: 16000, outputRate: 24000, truncate: false, maxSessionSec: 840 };
  #ws: WebSocket | null = null;
  #closing = false;
  #turn = 0;
  #inTurn = false;
  #userText = "";
  #modelText = "";
  constructor(private o: { apiKey: string; model: string; url?: string }) {
    super();
  }

  async connect(init: ProviderConnect): Promise<void> {
    const base = this.o.url ??
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
    const ws = new WebSocket(`${base}?key=${encodeURIComponent(this.o.apiKey)}`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    this.#closing = false;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("live connect timeout")), 10_000);
      ws.onopen = () => {
        this.#send({
          setup: {
            model: `models/${this.o.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              ...(init.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: init.voice } } } } : {}),
            },
            systemInstruction: { parts: [{ text: init.instructions }] },
            tools: init.tools.length
              ? [{ functionDeclarations: init.tools.map((x) => ({ name: x.name, description: x.description, parameters: x.parameters })) }]
              : [],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        });
      };
      ws.onmessage = (ev) => {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        const m = JSON.parse(text);
        if (m.setupComplete) {
          clearTimeout(t);
          if (init.seed) this.addContext(`Conversation so far (restored after reconnect):\n${init.seed}`);
          resolve();
          return;
        }
        this.#onServer(m);
      };
      ws.onerror = () => { clearTimeout(t); reject(new Error("live websocket error")); };
      ws.onclose = (ev) => {
        clearTimeout(t);
        if (this.#closing) return;
        // 1008 = policy (bad key / permission): not worth retrying.
        this.fire("error", { fatal: ev.code === 1008, message: `live connection closed (${ev.code})` });
        this.fire("closed");
      };
    });
  }

  #onServer(m: any): void {
    const sc = m.serverContent;
    if (sc) {
      if (sc.inputTranscription?.text) this.#userText += sc.inputTranscription.text;
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          if (!this.#inTurn) {
            this.#inTurn = true;
            this.#turn++;
            this.#flushUser();
          }
          this.fire("audio", base64ToPcm(part.inlineData.data), `g${this.#turn}`);
        }
      }
      if (sc.outputTranscription?.text) this.#modelText += sc.outputTranscription.text;
      if (sc.interrupted) {
        this.#endModelTurn(false);
        this.fire("speechStarted");
      }
      if (sc.turnComplete) this.#endModelTurn(true);
    }
    for (const fc of m.toolCall?.functionCalls ?? []) {
      this.fire("toolCall", { callId: fc.id, name: fc.name, args: fc.args ?? {} });
    }
  }
  #flushUser(): void {
    const t = this.#userText.trim();
    this.#userText = "";
    if (t) this.fire("transcript", { role: "user", text: t, itemId: `u${this.#turn}` });
  }
  #endModelTurn(done: boolean): void {
    this.#flushUser();
    const t = this.#modelText.trim();
    this.#modelText = "";
    if (t) this.fire("transcript", { role: "assistant", text: t, itemId: `g${this.#turn}` });
    this.#inTurn = false;
    if (done) this.fire("responseDone");
  }

  #send(o: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(o));
  }
  sendAudio(pcm: Int16Array): void {
    this.#send({ realtimeInput: { audio: { data: pcmToBase64(pcm), mimeType: "audio/pcm;rate=16000" } } });
  }
  addContext(text: string): void {
    this.#send({ clientContent: { turns: [{ role: "user", parts: [{ text: `[context] ${text}` }] }], turnComplete: false } });
  }
  respond(): void {
    this.#send({ clientContent: { turns: [], turnComplete: true } });
  }
  cancel(): void {
    // Gemini has no explicit cancel; an empty completed client turn makes the
    // model yield to the next instruction.
    this.respond();
  }
  truncate(): void {
    /* caps.truncate=false — never called by the Conductor */
  }
  toolResult(callId: string, output: unknown): void {
    this.#send({ toolResponse: { functionResponses: [{ id: callId, response: output }] } });
  }
  async close(): Promise<void> {
    this.#closing = true;
    try { this.#ws?.close(1000, "done"); } catch {}
    this.#ws = null;
  }
}
```

Note on the test's expected `toolResponse.functionResponses[0]`: the implementation sends `{ id, response }`. If the docs (Step 1) require `name` too, add `name` to `toolResult` by remembering `callId → name` from `toolCall` events, and keep the test's `toMatchObject`.

- [ ] **Step 5: Implement `src/voice/provider/index.ts`**

```ts
import type { VoiceProviderId } from "../config";
import { GeminiLive } from "./gemini-live";
import { OpenAIRealtime } from "./openai-realtime";
import type { VoiceProvider } from "./types";

export function createProvider(o: { provider: VoiceProviderId; model: string; apiKey: string }): VoiceProvider {
  switch (o.provider) {
    case "openai":
      return new OpenAIRealtime({ apiKey: o.apiKey, model: o.model });
    case "gemini":
      return new GeminiLive({ apiKey: o.apiKey, model: o.model });
  }
}
```

- [ ] **Step 6: Run to verify it passes** — `bun test tests/voice/gemini-live.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/voice/provider/gemini-live.ts src/voice/provider/index.ts tests/voice/gemini-live.test.ts
git commit -m "feat(voice): Gemini Live adapter and provider factory"
```

---

### Task 7: AudioLink (workbench client)

**Files:**
- Create: `src/voice/audio-link.ts`
- Test: `tests/voice/audio-link.test.ts`

**Interfaces:**
- Consumes: `AudioEndpoints` (Task 2), `base64ToPcm` (Task 4).
- Produces:
  - `interface AudioHandlers { onAudio(pcm: Int16Array): void; onEnded(reason: string): void }`
  - `interface AudioLinkLike { start(h: AudioHandlers): Promise<void>; write(pcm: Int16Array): void; clear(): Promise<{ playedMs: number; clearedMs: number }>; close(): Promise<void> }`
  - `class AudioLink implements AudioLinkLike`, constructor `new AudioLink({ baseUrl: string; endpoints: AudioEndpoints; streamToken: string; maxSseRetries?: number; retryDelayMs?: number })`.
  - `onEnded` reasons it emits: `"workbench:<reason>"` (from the SSE `ended` event), `"audio_lost"` (retries exhausted, uplink 404, or start failure).

- [ ] **Step 1: Write the failing test (fake workbench)**

```ts
// tests/voice/audio-link.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { AudioLink } from "../../src/voice/audio-link";
import { pcmToBase64 } from "../../src/voice/provider/types";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function fakeWorkbench(opts: { getStatus?: number; postStatus?: number; dropFirstSse?: boolean } = {}) {
  const st: any = { gets: 0, auth: [] as string[], route: [] as string[], uplinkBytes: 0, clears: 0, sseCtl: null as any };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      st.auth.push(req.headers.get("authorization") ?? "");
      st.route.push(req.headers.get("x-browser-session") ?? "");
      if (url.pathname.endsWith("/audio/clear")) {
        st.clears++;
        return Response.json({ played_ms: 1500, cleared_ms: 900 });
      }
      if (req.method === "GET") {
        st.gets++;
        if (opts.getStatus) return new Response("", { status: opts.getStatus });
        const first = st.gets === 1;
        return new Response(new ReadableStream({
          start(c) {
            st.sseCtl = c;
            c.enqueue(new TextEncoder().encode(": ping\n\n"));
            c.enqueue(new TextEncoder().encode(sse("audio", { seq: 1, pcm: pcmToBase64(new Int16Array([5, 6, 7])) })));
            if (first && opts.dropFirstSse) c.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (req.method === "POST") {
        if (opts.postStatus) return new Response("", { status: opts.postStatus });
        for await (const chunk of req.body as any) st.uplinkBytes += chunk.byteLength;
        return Response.json({ played_ms: 0 });
      }
      return new Response("", { status: 404 });
    },
  });
  st.base = `http://localhost:${server.port}`;
  st.stop = () => server.stop(true);
  return st;
}
const endpoints = { streamUrl: "/api/browser/tabs/t1/audio/stream", clearUrl: "/api/browser/tabs/t1/audio/clear", headers: { "X-Browser-Session": "rk" }, sampleRate: 24000 };
const until = async (c: () => boolean, ms = 2000) => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(5); } };
let wb: any = null;
afterEach(() => wb?.stop());

describe("AudioLink", () => {
  it("streams audio frames, sends auth + routing headers, and uplinks PCM", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "stok" });
    const got: number[][] = [];
    await link.start({ onAudio: (p) => got.push([...p]), onEnded: () => {} });
    await until(() => got.length === 1);
    expect(got[0]).toEqual([5, 6, 7]);
    link.write(new Int16Array(10));
    await link.close();
    await until(() => wb.uplinkBytes === 20);
    expect(wb.auth.every((a: string) => a === "Bearer stok")).toBe(true);
    expect(wb.route.every((r: string) => r === "rk")).toBe(true);
  });

  it("maps the ended event to workbench:<reason>", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s" });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => wb.sseCtl !== null);
    wb.sseCtl.enqueue(new TextEncoder().encode(sse("ended", { reason: "tab_closed" })));
    await until(() => reason !== "");
    expect(reason).toBe("workbench:tab_closed");
    await link.close();
  });

  it("re-GETs the stream after a blip", async () => {
    wb = fakeWorkbench({ dropFirstSse: true });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s", retryDelayMs: 10 });
    let n = 0;
    await link.start({ onAudio: () => n++, onEnded: () => {} });
    await until(() => wb.gets === 2 && n === 2);
    await link.close();
  });

  it("gives up with audio_lost after the retry budget", async () => {
    wb = fakeWorkbench({ getStatus: 500 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s", retryDelayMs: 5, maxSseRetries: 3 });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason !== "");
    expect(reason).toBe("audio_lost");
    expect(wb.gets).toBe(4);
  });

  it("ends audio_lost when the uplink is refused with 404", async () => {
    wb = fakeWorkbench({ postStatus: 404 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s" });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason !== "");
    expect(reason).toBe("audio_lost");
    await link.close();
  });

  it("clear returns played and cleared ms", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s" });
    await link.start({ onAudio: () => {}, onEnded: () => {} });
    expect(await link.clear()).toEqual({ playedMs: 1500, clearedMs: 900 });
    await link.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/voice/audio-link.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/voice/audio-link.ts`**

```ts
/**
 * Workbench browser-audio client (voice mode spec §5.5; workbench
 * browser-audio-pipeline design). SSE out (call audio), one long-lived chunked
 * POST in (agent audio), `clear` for interruption. Authorized by the call's
 * stream_token (plan deviation 1). Audio content is never logged.
 */
import type { AudioEndpoints } from "./ipc";
import { base64ToPcm } from "./provider/types";

export interface AudioHandlers {
  onAudio(pcm: Int16Array): void;
  onEnded(reason: string): void;
}
export interface AudioLinkLike {
  start(h: AudioHandlers): Promise<void>;
  write(pcm: Int16Array): void;
  clear(): Promise<{ playedMs: number; clearedMs: number }>;
  close(): Promise<void>;
}

export class AudioLink implements AudioLinkLike {
  #h: AudioHandlers | null = null;
  #closed = false;
  #ended = false;
  #sseAbort = new AbortController();
  #uplinkCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
  #uplinkDone: Promise<void> = Promise.resolve();
  constructor(private o: { baseUrl: string; endpoints: AudioEndpoints; streamToken: string; maxSseRetries?: number; retryDelayMs?: number }) {}

  #url(path: string): string {
    return new URL(path, this.o.baseUrl).toString();
  }
  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.o.endpoints.headers, authorization: `Bearer ${this.o.streamToken}`, ...extra };
  }
  #end(reason: string): void {
    if (this.#ended || this.#closed) return;
    this.#ended = true;
    this.#h?.onEnded(reason);
  }

  async start(h: AudioHandlers): Promise<void> {
    this.#h = h;
    void this.#sseLoop();
    const body = new ReadableStream<Uint8Array>({ start: (c) => { this.#uplinkCtl = c; } });
    this.#uplinkDone = fetch(this.#url(this.o.endpoints.streamUrl), {
      method: "POST",
      headers: this.#headers({ "content-type": "audio/pcm" }),
      body,
      // @ts-expect-error duplex is required for streaming request bodies
      duplex: "half",
    }).then(
      (r) => { if (r.status === 404 || r.status === 401 || r.status === 403) this.#end("audio_lost"); },
      () => this.#end("audio_lost"),
    );
  }

  async #sseLoop(): Promise<void> {
    const max = this.o.maxSseRetries ?? 3;
    let failures = 0;
    while (!this.#closed && !this.#ended) {
      let gotData = false;
      try {
        const r = await fetch(this.#url(this.o.endpoints.streamUrl), {
          headers: this.#headers({ accept: "text/event-stream" }),
          signal: this.#sseAbort.signal,
        });
        if (r.ok && r.body) {
          for await (const ev of parseSse(r.body)) {
            gotData = true;
            if (ev.event === "audio") {
              const d = JSON.parse(ev.data) as { pcm: string };
              this.#h?.onAudio(base64ToPcm(d.pcm));
            } else if (ev.event === "ended") {
              const d = JSON.parse(ev.data) as { reason?: string };
              this.#end(`workbench:${d.reason ?? "stopped"}`);
              return;
            }
          }
        }
      } catch {
        if (this.#closed) return;
      }
      if (this.#closed || this.#ended) return;
      failures = gotData ? 1 : failures + 1;
      if (failures > max) {
        this.#end("audio_lost");
        return;
      }
      await Bun.sleep(this.o.retryDelayMs ?? 500);
    }
  }

  write(pcm: Int16Array): void {
    if (this.#closed || !this.#uplinkCtl) return;
    this.#uplinkCtl.enqueue(new Uint8Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)));
  }

  async clear(): Promise<{ playedMs: number; clearedMs: number }> {
    const r = await fetch(this.#url(this.o.endpoints.clearUrl), { method: "POST", headers: this.#headers() });
    if (!r.ok) return { playedMs: 0, clearedMs: 0 };
    const j = (await r.json()) as { played_ms?: number; cleared_ms?: number };
    return { playedMs: j.played_ms ?? 0, clearedMs: j.cleared_ms ?? 0 };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#uplinkCtl?.close(); } catch {}
    this.#sseAbort.abort();
    await this.#uplinkDone.catch(() => {});
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}
```

Retry-count semantics: the first GET plus `maxSseRetries` re-GETs. A stream that delivered data resets the failure counter, so long calls survive many separate blips. The "audio_lost after the retry budget" test expects 4 GETs (1 + 3).

- [ ] **Step 4: Run to verify it passes** — `bun test tests/voice/audio-link.test.ts` → PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/voice/audio-link.ts tests/voice/audio-link.test.ts
git commit -m "feat(voice): workbench audio link (SSE out, chunked uplink, clear)"
```

---

### Task 8: Conductor

**Files:**
- Create: `src/voice/conductor.ts`
- Test: `tests/voice/conductor.test.ts`

**Interfaces:**
- Consumes: `VoiceProvider` (Task 4), `ChildMsg`, `SayMsg`, `EndReason` (Task 2), `FakeProvider`, `FakeAudio` (Task 4 fakes).
- Produces:
  - `const VOICE_TOOLS: ToolSpec[]` (`delegate`, `end_call`)
  - `const STILL_WORKING_MS = 60_000`, `const CAP_WARNING_MS = 120_000`, `const RECONNECT_LEAD_MS = 60_000`
  - `interface ConductorIO { provider: Pick<VoiceProvider, "caps" | "addContext" | "respond" | "cancel" | "truncate" | "toolResult">; audio: { write(pcm: Int16Array): void; clear(): Promise<{ playedMs: number }> }; emit(m: ChildMsg): void; end(reason: EndReason): void; reconnect(): void }`
  - `interface ConductorOpts { outputRate: number; staleSeq: number; maxMs: number; startedAt: number }`
  - `class Conductor` with: `seq: number` (getter), `setProvider(p)` (after reconnect), `onAudio(pcm, itemId)`, `onSpeechStarted(): Promise<void>`, `onSpeechStopped()`, `onResponseDone()`, `onTranscript(t)`, `onToolCall(c, now)`, `say(m: SayMsg): Promise<void>`, `context(text)`, `tick(now)`, `onReconnected(now)`, `recentTranscript(n: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/conductor.test.ts
import { describe, it, expect } from "bun:test";
import { Conductor, STILL_WORKING_MS, CAP_WARNING_MS, RECONNECT_LEAD_MS } from "../../src/voice/conductor";
import { FakeProvider, FakeAudio, pcm } from "./fakes";
import type { ChildMsg, EndReason } from "../../src/voice/ipc";

function setup(over: Partial<{ truncate: boolean; maxSessionSec: number; maxMs: number; staleSeq: number }> = {}) {
  const provider = new FakeProvider();
  provider.caps = { inputRate: 24000, outputRate: 24000, truncate: over.truncate ?? true, maxSessionSec: over.maxSessionSec };
  const audio = new FakeAudio();
  const emitted: ChildMsg[] = [];
  const ended: EndReason[] = [];
  let reconnects = 0;
  const c = new Conductor(
    { provider, audio, emit: (m) => emitted.push(m), end: (r) => ended.push(r), reconnect: () => reconnects++ },
    { outputRate: 24000, staleSeq: over.staleSeq ?? 6, maxMs: over.maxMs ?? 3_600_000, startedAt: 0 },
  );
  return { c, provider, audio, emitted, ended, reconnects: () => reconnects };
}

describe("Conductor", () => {
  it("forwards model audio to the uplink and marks a response active", () => {
    const { c, audio } = setup();
    c.onAudio(pcm(2400), "i1");
    expect(audio.written.length).toBe(1);
  });

  it("flush truncates to played audio and resets the uplink clock", async () => {
    const { c, provider, audio } = setup();
    c.onAudio(pcm(24000), "i1"); // 1000 ms on the uplink clock
    c.onAudio(pcm(24000), "i2"); // i2 starts at 1000 ms
    audio.clearResult = { playedMs: 1400, clearedMs: 600 };
    await c.onSpeechStarted();
    expect(audio.clears).toBe(1);
    expect(provider.named("truncate")).toEqual([["truncate", "i2", 400]]);
    expect(provider.named("cancel")).toEqual([]); // provider cancels itself
    c.onAudio(pcm(24000), "i3"); // starts at the reset clock: 1400
    audio.clearResult = { playedMs: 1500, clearedMs: 900 };
    await c.onSpeechStarted();
    expect(provider.named("truncate").at(-1)).toEqual(["truncate", "i3", 100]);
  });

  it("flush skips truncate when the provider cannot", async () => {
    const { c, provider, audio } = setup({ truncate: false });
    c.onAudio(pcm(2400), "g1");
    await c.onSpeechStarted();
    expect(audio.clears).toBe(1);
    expect(provider.named("truncate")).toEqual([]);
  });

  it("numbers transcripts and emits them", () => {
    const { c, emitted } = setup();
    c.onTranscript({ role: "user", text: "hello", itemId: "u1" });
    c.onTranscript({ role: "assistant", text: "hi", itemId: "i1" });
    expect(emitted).toEqual([
      { type: "transcript", seq: 1, role: "user", text: "hello" },
      { type: "transcript", seq: 2, role: "assistant", text: "hi" },
    ]);
    expect(c.seq).toBe(2);
    expect(c.recentTranscript(1)).toBe("voice: hi");
  });

  it("delegate returns working at once and emits a delegate with asOf", () => {
    const { c, provider, emitted } = setup();
    c.onTranscript({ role: "user", text: "check the deploy", itemId: "u1" });
    c.onToolCall({ callId: "c1", name: "delegate", args: { task: "check the deploy" } }, 0);
    expect(provider.named("toolResult")).toEqual([["toolResult", "c1", { id: "1", status: "working" }]]);
    expect(emitted.at(-1)).toEqual({ type: "delegate", id: "1", task: "check the deploy", asOf: 1 });
  });

  it("end_call ends the call; unknown tools get an error result", () => {
    const { c, provider, ended } = setup();
    c.onToolCall({ callId: "c1", name: "end_call", args: { reason: "asked to leave" } }, 0);
    c.onToolCall({ callId: "c2", name: "nope", args: {} }, 0);
    expect(ended).toEqual(["ended_by_voice"]);
    expect(provider.named("toolResult")[1]![2]).toEqual({ error: "unknown tool nope" });
  });

  it("next_gap waits until nobody speaks and no response is active", async () => {
    const { c, provider } = setup();
    c.onAudio(pcm(10), "i1"); // response active
    await c.say({ type: "say", text: "the deploy is green", when: "next_gap", asOf: 0 });
    expect(provider.named("respond")).toEqual([]);
    c.onResponseDone();
    expect(provider.named("addContext").at(-1)![1]).toContain("the deploy is green");
    expect(provider.named("respond").length).toBe(1);
  });

  it("now preempts: cancel, flush, speak", async () => {
    const { c, provider, audio } = setup();
    c.onAudio(pcm(10), "i1");
    await c.say({ type: "say", text: "correction: it failed", when: "now", asOf: 0 });
    expect(provider.calls.map((x) => x[0])).toEqual(["cancel", "truncate", "addContext", "respond"]);
    expect(audio.clears).toBe(1);
  });

  it("stale now steer downgrades to next_gap", async () => {
    const { c, provider, audio } = setup({ staleSeq: 2 });
    for (let i = 0; i < 5; i++) c.onTranscript({ role: "user", text: `t${i}`, itemId: `u${i}` });
    c.onAudio(pcm(10), "i1"); // response active → no gap
    await c.say({ type: "say", text: "old news", when: "now", asOf: 1 }); // 5-1 > 2
    expect(provider.named("cancel")).toEqual([]);
    expect(audio.clears).toBe(0);
    c.onResponseDone();
    expect(provider.named("respond").length).toBe(1);
  });

  it("nudges once when a delegate is still working after 60s, at a gap", () => {
    const { c, provider } = setup();
    c.onToolCall({ callId: "c1", name: "delegate", args: { task: "x" } }, 0);
    c.tick(STILL_WORKING_MS - 1);
    expect(provider.named("addContext")).toEqual([]);
    c.tick(STILL_WORKING_MS);
    expect(provider.named("addContext").length).toBe(1);
    c.onResponseDone();
    c.tick(STILL_WORKING_MS * 2);
    expect(provider.named("addContext").length).toBe(1);
  });

  it("a reply_to say closes the delegate so no nudge follows", async () => {
    const { c, provider } = setup();
    c.onToolCall({ callId: "c1", name: "delegate", args: { task: "x" } }, 0);
    await c.say({ type: "say", text: "answer", when: "next_gap", replyTo: "1", asOf: 0 });
    c.onResponseDone();
    c.tick(STILL_WORKING_MS);
    expect(provider.named("addContext").length).toBe(1); // the answer only
  });

  it("warns before the cap and ends at the cap", () => {
    const { c, provider, ended } = setup({ maxMs: 600_000 });
    c.tick(600_000 - CAP_WARNING_MS);
    expect(provider.named("addContext").length).toBe(1);
    c.onResponseDone();
    c.tick(600_000 - CAP_WARNING_MS + 1);
    expect(provider.named("addContext").length).toBe(1);
    c.tick(600_000);
    expect(ended).toEqual(["max_duration"]);
  });

  it("asks for a planned reconnect before the provider session limit, only at a gap", () => {
    const s = setup({ maxSessionSec: 600 });
    s.c.onAudio(pcm(10), "i1");
    s.c.tick(600_000 - RECONNECT_LEAD_MS);
    expect(s.reconnects()).toBe(0);
    s.c.onResponseDone();
    s.c.tick(600_000 - RECONNECT_LEAD_MS + 1);
    expect(s.reconnects()).toBe(1);
    s.c.tick(600_000 - RECONNECT_LEAD_MS + 2);
    expect(s.reconnects()).toBe(1);
    s.c.onReconnected(700_000);
    s.c.tick(700_000 + 600_000 - RECONNECT_LEAD_MS);
    expect(s.reconnects()).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/voice/conductor.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/voice/conductor.ts`**

```ts
/**
 * Conversation glue between the realtime provider, workbench audio and the
 * Claude session (voice mode spec §5.4). No I/O of its own: everything goes
 * through ConductorIO, and time comes in through tick(now), so tests drive it
 * with scripted events.
 *
 * It makes no interruption decisions — the provider does. It only flushes the
 * audio it already handed to workbench (a realtime model emits faster than real
 * time) and truncates the model's item to what was actually heard.
 */
import type { ChildMsg, EndReason, SayMsg } from "./ipc";
import type { ToolSpec, VoiceProvider } from "./provider/types";

export const STILL_WORKING_MS = 60_000;
export const CAP_WARNING_MS = 120_000;
export const RECONNECT_LEAD_MS = 60_000;

export const VOICE_TOOLS: ToolSpec[] = [
  {
    name: "delegate",
    description:
      "Hand a question or task to your back-office brain (it can search knowledge, use tools, and act). " +
      "Returns immediately; the answer comes back later as context. Say a short holding line first.",
    parameters: { type: "object", properties: { task: { type: "string", description: "What to find out or do, self-contained." } }, required: ["task"] },
  },
  {
    name: "end_call",
    description: "Leave the call. Use only when asked to leave or when the conversation is clearly over.",
    parameters: { type: "object", properties: { reason: { type: "string" } } },
  },
];

export interface ConductorIO {
  provider: Pick<VoiceProvider, "caps" | "addContext" | "respond" | "cancel" | "truncate" | "toolResult">;
  audio: { write(pcm: Int16Array): void; clear(): Promise<{ playedMs: number }> };
  emit(m: ChildMsg): void;
  end(reason: EndReason): void;
  reconnect(): void;
}
export interface ConductorOpts {
  outputRate: number;
  staleSeq: number;
  maxMs: number;
  startedAt: number;
}

export class Conductor {
  #seq = 0;
  #log: string[] = [];
  #userSpeaking = false;
  #responseActive = false;
  #sentMs = 0;
  #itemStart = new Map<string, number>();
  #currentItem: string | null = null;
  #steers: string[] = [];
  #delegates = new Map<string, { askedAt: number; nudged: boolean }>();
  #nextDelegate = 1;
  #warned = false;
  #ended = false;
  #sessionStartedAt: number;
  #reconnectRequested = false;

  constructor(private io: ConductorIO, private o: ConductorOpts) {
    this.#sessionStartedAt = o.startedAt;
  }

  get seq(): number {
    return this.#seq;
  }
  setProvider(p: ConductorIO["provider"]): void {
    this.io = { ...this.io, provider: p };
  }

  onAudio(pcm: Int16Array, itemId: string): void {
    if (!this.#itemStart.has(itemId)) this.#itemStart.set(itemId, this.#sentMs);
    this.#currentItem = itemId;
    this.#responseActive = true;
    this.io.audio.write(pcm);
    this.#sentMs += (pcm.length * 1000) / this.o.outputRate;
  }

  async onSpeechStarted(): Promise<void> {
    this.#userSpeaking = true;
    await this.#flush();
  }
  onSpeechStopped(): void {
    this.#userSpeaking = false;
    this.#drain();
  }
  onResponseDone(): void {
    this.#responseActive = false;
    this.#drain();
  }

  onTranscript(t: { role: "user" | "assistant"; text: string }): void {
    this.#seq++;
    this.#log.push(`${t.role === "user" ? "participant" : "voice"}: ${t.text}`);
    if (this.#log.length > 200) this.#log.shift();
    this.io.emit({ type: "transcript", seq: this.#seq, role: t.role, text: t.text });
  }
  recentTranscript(n: number): string {
    return this.#log.slice(-n).join("\n");
  }

  onToolCall(c: { callId: string; name: string; args: unknown }, now: number): void {
    const args = (c.args ?? {}) as Record<string, unknown>;
    if (c.name === "delegate") {
      const id = String(this.#nextDelegate++);
      this.#delegates.set(id, { askedAt: now, nudged: false });
      this.io.provider.toolResult(c.callId, { id, status: "working" });
      this.io.emit({ type: "delegate", id, task: String(args.task ?? "").trim(), asOf: this.#seq });
      return;
    }
    if (c.name === "end_call") {
      this.io.provider.toolResult(c.callId, { ok: true });
      this.#finish("ended_by_voice");
      return;
    }
    this.io.provider.toolResult(c.callId, { error: `unknown tool ${c.name}` });
  }

  async say(m: SayMsg): Promise<void> {
    if (m.replyTo) this.#delegates.delete(m.replyTo);
    const stale = this.#seq - m.asOf > this.o.staleSeq;
    if (m.when === "now" && !stale) {
      this.io.provider.cancel();
      await this.#flush();
      this.#speak(m.text);
      return;
    }
    this.#steers.push(m.text);
    this.#drain();
  }

  context(text: string): void {
    this.io.provider.addContext(text);
  }

  tick(now: number): void {
    if (this.#ended) return;
    const elapsed = now - this.o.startedAt;
    if (elapsed >= this.o.maxMs) {
      this.#finish("max_duration");
      return;
    }
    if (!this.#warned && elapsed >= this.o.maxMs - CAP_WARNING_MS) {
      this.#warned = true;
      this.#steers.push("Let the participants know you have about two minutes left in this call.");
    }
    for (const [id, d] of this.#delegates) {
      if (!d.nudged && now - d.askedAt >= STILL_WORKING_MS) {
        d.nudged = true;
        this.#steers.push(`You are still working on request #${id}; say briefly that it is taking a little longer.`);
      }
    }
    const limit = this.io.provider.caps.maxSessionSec;
    if (limit && !this.#reconnectRequested && this.#gap() && now - this.#sessionStartedAt >= limit * 1000 - RECONNECT_LEAD_MS) {
      this.#reconnectRequested = true;
      this.io.reconnect();
      return;
    }
    this.#drain();
  }

  onReconnected(now: number): void {
    this.#sessionStartedAt = now;
    this.#reconnectRequested = false;
    this.#responseActive = false;
    this.#itemStart.clear();
    this.#currentItem = null;
  }

  #gap(): boolean {
    return !this.#userSpeaking && !this.#responseActive;
  }
  #drain(): void {
    if (!this.#gap()) return;
    const next = this.#steers.shift();
    if (next !== undefined) this.#speak(next);
  }
  #speak(text: string): void {
    this.io.provider.addContext(`Say this to the participants now, in your own words and voice: ${text}`);
    this.io.provider.respond();
    this.#responseActive = true;
  }
  async #flush(): Promise<void> {
    const { playedMs } = await this.io.audio.clear();
    const item = this.#currentItem;
    if (item && this.io.provider.caps.truncate) {
      const start = this.#itemStart.get(item) ?? 0;
      this.io.provider.truncate(item, Math.max(0, Math.round(playedMs - start)));
    }
    // Everything not yet played was discarded by workbench: the uplink clock
    // resumes from what actually played.
    this.#sentMs = playedMs;
    this.#currentItem = null;
  }
  #finish(reason: EndReason): void {
    if (this.#ended) return;
    this.#ended = true;
    this.io.end(reason);
  }
}
```

Check against the test "nudges once … at a gap": the delegate's `toolResult` does not mark a response active (the fake provider emits no audio), so the gap holds at `tick(STILL_WORKING_MS)` and the nudge is spoken at once.

- [ ] **Step 4: Run to verify it passes** — `bun test tests/voice/conductor.test.ts` → PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/voice/conductor.ts tests/voice/conductor.test.ts
git commit -m "feat(voice): conductor — steer queue, delegates, audio flush, cap, planned reconnect"
```

---

### Task 9: Voice loop wiring, child entry and CLI subcommand

**Files:**
- Create: `src/voice/loop.ts`
- Create: `src/voice/loop-entry.ts`
- Modify: `bin/slaude.ts` (add a `case "voice-loop"` to the `switch (sub)` and a help line)
- Test: `tests/voice/loop.test.ts`

**Interfaces:**
- Consumes: `Conductor`, `VOICE_TOOLS` (Task 8); `AudioLinkLike`, `AudioLink` (Task 7); `VoiceProvider`, `createProvider` (Tasks 4, 6); `resample` (Task 3); `VoiceInit`, `ParentMsg`, `ChildMsg`, `EndReason`, `encodeMsg`, `readLines`, `parseParentMsg`, `ENV_API_KEY`, `ENV_STREAM_TOKEN` (Task 2).
- Produces:
  - `interface LoopDeps { init: VoiceInit; makeProvider(): VoiceProvider; audio: AudioLinkLike; inbox: AsyncIterable<ParentMsg>; emit(m: ChildMsg): void; now?: () => number; tickMs?: number; reconnectDelayMs?: number }`
  - `runVoiceLoop(d: LoopDeps): Promise<EndReason>`
  - CLI: `slaude voice-loop` runs `src/voice/loop-entry.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/loop.test.ts
import { describe, it, expect } from "bun:test";
import { runVoiceLoop } from "../../src/voice/loop";
import { FakeProvider, FakeAudio, pcm } from "./fakes";
import type { ChildMsg, ParentMsg, VoiceInit } from "../../src/voice/ipc";

const init: VoiceInit = {
  callId: "call-1", audio: { streamUrl: "/s", clearUrl: "/c", headers: {}, sampleRate: 24000 },
  workbenchUrl: "https://wb.example.com", instructions: "persona", provider: "openai", model: "m", maxMinutes: 120, staleSeq: 6,
};
function inbox() {
  const q: ParentMsg[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    push(m: ParentMsg) { q.push(m); wake?.(); },
    close() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (q.length) { yield q.shift()!; continue; }
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}
const until = async (c: () => boolean, ms = 2000) => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(5); } };

describe("runVoiceLoop", () => {
  it("starts, bridges audio both ways, relays say, and ends on stop", async () => {
    const provider = new FakeProvider();
    const audio = new FakeAudio();
    const ib = inbox();
    const out: ChildMsg[] = [];
    const done = runVoiceLoop({ init, makeProvider: () => provider, audio, inbox: ib, emit: (m) => out.push(m), tickMs: 5 });
    await until(() => out.some((m) => m.type === "started"));
    expect(provider.connects[0]!.instructions).toBe("persona");
    expect(provider.connects[0]!.tools.map((t) => t.name)).toEqual(["delegate", "end_call"]);
    audio.handlers!.onAudio(pcm(480));
    expect(provider.named("sendAudio")).toEqual([["sendAudio", 480]]);
    provider.emitEvent("audio", pcm(240), "i1");
    expect(audio.written.length).toBe(1);
    ib.push({ type: "say", text: "hello all", when: "next_gap", asOf: 0 });
    provider.emitEvent("responseDone");
    await until(() => provider.named("respond").length === 1);
    ib.push({ type: "stop", reason: "stopped" });
    expect(await done).toBe("stopped");
    expect(out.at(-1)).toEqual({ type: "ended", reason: "stopped" });
    expect(audio.closed).toBe(true);
    expect(provider.named("close").length).toBe(1);
  });

  it("resamples the downlink when the provider input rate differs", async () => {
    const provider = new FakeProvider();
    provider.caps = { inputRate: 16000, outputRate: 24000, truncate: false };
    const audio = new FakeAudio();
    const ib = inbox();
    const done = runVoiceLoop({ init, makeProvider: () => provider, audio, inbox: ib, emit: () => {}, tickMs: 5 });
    await until(() => audio.handlers !== null);
    audio.handlers!.onAudio(pcm(480));
    expect(provider.named("sendAudio")).toEqual([["sendAudio", 320]]);
    ib.close();
    expect(await done).toBe("parent_gone");
  });

  it("ends with the workbench reason", async () => {
    const audio = new FakeAudio();
    const out: ChildMsg[] = [];
    const done = runVoiceLoop({ init, makeProvider: () => new FakeProvider(), audio, inbox: inbox(), emit: (m) => out.push(m), tickMs: 5 });
    await until(() => audio.handlers !== null);
    audio.handlers!.onEnded("workbench:tab_closed");
    expect(await done).toBe("workbench:tab_closed");
  });

  it("reconnects on a non-fatal provider drop, then gives up after 3 failed attempts", async () => {
    const made: FakeProvider[] = [];
    const done = runVoiceLoop({
      init, audio: new FakeAudio(), inbox: inbox(), emit: () => {}, tickMs: 5, reconnectDelayMs: 1,
      makeProvider: () => { const p = new FakeProvider(); if (made.length >= 1) p.connectError = new Error("down"); made.push(p); return p; },
    });
    await until(() => made.length === 1 && made[0]!.connects.length === 1);
    made[0]!.emitEvent("error", { fatal: false, message: "x" });
    made[0]!.emitEvent("closed");
    expect(await done).toBe("provider_lost");
    expect(made.length).toBe(4); // initial + 3 failed attempts
  });

  it("ends provider_failed on a fatal provider error", async () => {
    const p = new FakeProvider();
    const done = runVoiceLoop({ init, makeProvider: () => p, audio: new FakeAudio(), inbox: inbox(), emit: () => {}, tickMs: 5 });
    await until(() => p.connects.length === 1);
    p.emitEvent("error", { fatal: true, message: "bad key" });
    expect(await done).toBe("provider_failed");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/voice/loop.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/voice/loop.ts`**

```ts
/**
 * The voice loop (voice mode spec §5): provider ⇄ conductor ⇄ workbench audio,
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
    p.on("audio", (pcm, item) => conductor.onAudio(pcm, item));
    p.on("transcript", (t) => conductor.onTranscript(t));
    p.on("speechStarted", () => void conductor.onSpeechStarted());
    p.on("speechStopped", () => conductor.onSpeechStopped());
    p.on("responseDone", () => conductor.onResponseDone());
    p.on("toolCall", (c) => conductor.onToolCall(c, now()));
    p.on("error", (e) => {
      if (e.fatal) end("provider_failed");
      else d.emit({ type: "log", level: "warn", message: `provider: ${e.message}` });
    });
    p.on("closed", () => {
      if (p === provider && !finished) void reconnect("dropped");
    });
  };

  const connect = (p: VoiceProvider, seed?: string) =>
    p.connect({ instructions: d.init.instructions, tools: VOICE_TOOLS, voice: d.init.voice, seed });

  async function reconnect(why: "planned" | "dropped"): Promise<void> {
    if (reconnecting || finished) return;
    reconnecting = true;
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
        return;
      } catch {
        await p.close().catch(() => {});
        await Bun.sleep((d.reconnectDelayMs ?? 500) * attempt);
      }
    }
    reconnecting = false;
    end("provider_lost");
  }

  attach(provider);
  try {
    await connect(provider);
  } catch (e) {
    d.emit({ type: "log", level: "error", message: `provider connect failed: ${e instanceof Error ? e.message : e}` });
    d.emit({ type: "ended", reason: "provider_failed" });
    await d.audio.close().catch(() => {});
    return "provider_failed";
  }

  await d.audio.start({
    onAudio: (pcm) => {
      if (reconnecting) return;
      provider.sendAudio(resample(pcm, d.init.audio.sampleRate, provider.caps.inputRate));
    },
    onEnded: (reason) => end(reason as EndReason),
  });
  d.emit({ type: "started", callId: d.init.callId, sampleRate: d.init.audio.sampleRate });

  const ticker = setInterval(() => conductor.tick(now()), d.tickMs ?? 250);
  void (async () => {
    for await (const m of d.inbox) {
      if (finished) break;
      if (m.type === "say") await conductor.say(m);
      else if (m.type === "context") conductor.context(m.text);
      else if (m.type === "stop") end(m.reason);
    }
    end("parent_gone");
  })();

  const reason = await ended;
  clearInterval(ticker);
  await d.audio.close().catch(() => {});
  await provider.close().catch(() => {});
  d.emit({ type: "ended", reason });
  return reason;
}
```

- [ ] **Step 4: Implement `src/voice/loop-entry.ts`**

```ts
/**
 * `slaude voice-loop` — child process entry. Reads one `init` line from stdin,
 * then say/context/stop lines; writes ChildMsg lines to stdout. Secrets come
 * only from the environment. stdin EOF (parent died) ends the call.
 */
import { AudioLink } from "./audio-link";
import { ENV_API_KEY, ENV_STREAM_TOKEN, encodeMsg, parseParentMsg, readLines, type ChildMsg, type ParentMsg } from "./ipc";
import { runVoiceLoop } from "./loop";
import { createProvider } from "./provider";

const emit = (m: ChildMsg) => process.stdout.write(encodeMsg(m));
const apiKey = process.env[ENV_API_KEY] ?? "";
const streamToken = process.env[ENV_STREAM_TOKEN] ?? "";
delete process.env[ENV_API_KEY];
delete process.env[ENV_STREAM_TOKEN];

const lines = readLines(Bun.stdin.stream());
const first = await lines.next();
const initMsg = first.done ? null : parseParentMsg(first.value);
if (!initMsg || initMsg.type !== "init" || !apiKey || !streamToken) {
  emit({ type: "log", level: "error", message: "voice-loop: missing init message or credentials" });
  emit({ type: "ended", reason: "loop_crashed" });
  process.exit(2);
}
const init = initMsg.init;

async function* inbox(): AsyncGenerator<ParentMsg> {
  for await (const line of lines) {
    const m = parseParentMsg(line);
    if (m && m.type !== "init") yield m;
  }
}

try {
  await runVoiceLoop({
    init,
    makeProvider: () => createProvider({ provider: init.provider, model: init.model, apiKey }),
    audio: new AudioLink({ baseUrl: init.workbenchUrl, endpoints: init.audio, streamToken }),
    inbox: inbox(),
    emit,
  });
  process.exit(0);
} catch (e) {
  emit({ type: "log", level: "error", message: `voice-loop crashed: ${e instanceof Error ? e.message : String(e)}` });
  emit({ type: "ended", reason: "loop_crashed" });
  process.exit(1);
}
```

- [ ] **Step 5: Register the subcommand**

In `bin/slaude.ts`, inside `switch (sub)` next to `case "brain-server":`, add:

```ts
      case "voice-loop":
        entry = "src/voice/loop-entry.ts";
        rest = argv.slice(1);
        break;
```

and in the help text block add the line:

```
  voice-loop          (internal) realtime voice loop child for a call
```

- [ ] **Step 6: Run to verify it passes** — `bun test tests/voice/loop.test.ts` → PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/voice/loop.ts src/voice/loop-entry.ts bin/slaude.ts tests/voice/loop.test.ts
git commit -m "feat(voice): voice loop wiring, child entry, slaude voice-loop subcommand"
```

---

### Task 10: AgentManager — idle hold and session-exit signal

**Files:**
- Modify: `src/agent/manager.ts` (`#armIdle` at ~667-680; teardown `finally` at ~1290-1312; add public `holdIdle`)
- Test: `tests/agent/manager-lifecycle.test.ts` (append a `describe` block that reuses the file's existing `FakeSession`, `plan`, `thread`, `until`, `res`, `shutdown` helpers)

**Interfaces:**
- Produces:
  - `AgentManager.holdIdle(sessionId: string, hold: boolean): void` — while held, the idle TTL never closes the session; releasing re-arms it.
  - `AgentManager` emits `"sessionExit"` with `(sessionId: string)` when a live session is torn down (idle close, reload, abort, stream end). Separate from `"event"` so it never reaches the events stream.

- [ ] **Step 1: Write the failing tests** (append to `tests/agent/manager-lifecycle.test.ts`; add `import { env } from "../../src/config/env";` at the top if absent)

```ts
describe("AgentManager voice support", () => {
  it("sessionExit fires on teardown", async () => {
    const mgr = new AgentManager();
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    const row = await mgr.ensureSession(thread());
    plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => mgr.isLive(row.id), 3000, "live");
    await shutdown(mgr, row.id);
    await until(() => exits.length === 1, 3000, "sessionExit");
    expect(exits).toEqual([row.id]);
  });

  it("holdIdle keeps a session past its idle TTL and release re-arms it", async () => {
    const spy = spyOn(env, "idleMs").mockReturnValue(30);
    try {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession(thread());
      const fs = plan();
      await mgr.sendMessage(row.id, "hello");
      await until(() => mgr.isLive(row.id), 3000, "live");
      mgr.holdIdle(row.id, true);
      fs.emit(res());
      await Bun.sleep(120);
      expect(mgr.isLive(row.id)).toBe(true);
      mgr.holdIdle(row.id, false);
      await until(() => !mgr.isLive(row.id), 3000, "idle close after release");
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/agent/manager-lifecycle.test.ts -t "voice support"`
Expected: FAIL — `mgr.holdIdle is not a function`; `sessionExit` never fires.

- [ ] **Step 3: Implement**

Add a field next to the other private maps in `AgentManager`:

```ts
  /** Sessions whose idle TTL is suspended (an active voice call, spec §6). */
  #idleHeld = new Set<string>();
```

Add the public method near `suppressNextTurn`:

```ts
  /** Suspend (true) or restore (false) the idle TTL for a live session. A voice
   *  call holds it so the warm session — and its warm-node registration — stays
   *  up for the whole call; release re-arms the normal timer. */
  holdIdle(sessionId: string, hold: boolean) {
    if (hold) this.#idleHeld.add(sessionId);
    else this.#idleHeld.delete(sessionId);
    const live = this.#live.get(sessionId);
    if (!live) return;
    if (hold) {
      if (live.idleTimer) clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    } else {
      this.#armIdle(live);
    }
  }
```

At the top of `#armIdle(live)`, after `if (live.idleTimer) clearTimeout(live.idleTimer);`, add:

```ts
    if (this.#idleHeld.has(live.id)) return;
```

In the teardown `finally`, immediately before the final `markExited();` of the owner path (after `metric.sessionsLive.set(this.#live.size);`), add:

```ts
        this.#idleHeld.delete(sessionId);
        this.emit("sessionExit", sessionId);
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test tests/agent/manager-lifecycle.test.ts`
Expected: PASS (whole file, including existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/manager.ts tests/agent/manager-lifecycle.test.ts
git commit -m "feat(agent): holdIdle and sessionExit for voice calls"
```

---

### Task 11: Voice turn flags and quiet thread

**Files:**
- Create: `src/voice/turn-flags.ts`
- Modify: `src/gateway/core/gateway.ts` (`wrapSurface` at ~477; stop guard at ~775)
- Modify: `src/node/shims/index.ts` (`ShimDeps` and `shimServer` handler)
- Test: `tests/voice/turn-flags.test.ts`, `tests/node/shims.test.ts` (append), `tests/voice/quiet-surface.test.ts`

**Interfaces:**
- Produces:
  - `voiceTurns: { enter(sessionId: string): void; exit(sessionId: string): void; active(sessionId: string): boolean }` (process-local, counted)
  - `VOICE_QUIET_TOOLS: ReadonlySet<string>` = `reply, edit, react, unreact, upload, typing`
  - `quietForVoice(surface: Surface, sessionId: string): Surface` (wraps with `suppressibleSurface` using `voiceTurns.active`)
  - `ShimDeps.voiceActive?(sessionId: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/voice/turn-flags.test.ts
import { describe, it, expect } from "bun:test";
import { voiceTurns } from "../../src/voice/turn-flags";

describe("voiceTurns", () => {
  it("counts nested enters", () => {
    voiceTurns.enter("s1");
    voiceTurns.enter("s1");
    voiceTurns.exit("s1");
    expect(voiceTurns.active("s1")).toBe(true);
    voiceTurns.exit("s1");
    expect(voiceTurns.active("s1")).toBe(false);
    voiceTurns.exit("s1"); // never negative
    expect(voiceTurns.active("s1")).toBe(false);
  });
});
```

```ts
// tests/voice/quiet-surface.test.ts
import { describe, it, expect } from "bun:test";
import { quietForVoice, voiceTurns } from "../../src/voice/turn-flags";
import type { Surface } from "../../src/gateway/core/surface";

function fakeSurface(posted: string[]): Surface {
  return {
    id: "slack", capabilities: new Set(), getHistory: async () => [],
    requestApproval: async () => ({ approved: true, by: "U1" } as any),
    reply: async (i: any) => { posted.push(i.text); return { ref: "1.0" }; },
  } as unknown as Surface;
}

describe("quietForVoice", () => {
  it("voice turn suppresses reply; a normal turn posts", async () => {
    const posted: string[] = [];
    const s = quietForVoice(fakeSurface(posted), "s9");
    voiceTurns.enter("s9");
    await s.reply({ text: "during call" } as any);
    voiceTurns.exit("s9");
    await s.reply({ text: "summary" } as any);
    expect(posted).toEqual(["summary"]);
  });
});
```

Append to `tests/node/shims.test.ts` (reuse the file's existing fake `NodeClient` and token helpers; the essential assertion):

```ts
  it("voice turn suppresses surface writes locally and still forwards other tools", async () => {
    const posted: string[] = [];
    const client = { postTool: async (seg: string, name: string) => { posted.push(`${seg}/${name}`); return { content: [{ type: "text", text: "{}" }] }; } } as any;
    const servers = buildShimServers("sv1", { client, tokenFor: () => "tok", voiceActive: (id) => id === "sv1" });
    const surface = (servers["slaude_surface"] as any).instance._registeredTools;
    const r = await surface["reply"].handler({ text: "x" });
    expect(JSON.parse(r.content[0].text)).toEqual({ ref: "voice-suppressed" });
    await surface["get_history"].handler({});
    expect(posted).toEqual(["surface/get_history"]);
  });
```

(`slaude_surface` is `SURFACE_SERVER` in `src/tools/contracts/surface.ts:10`.)

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/voice/turn-flags.test.ts tests/voice/quiet-surface.test.ts tests/node/shims.test.ts`
Expected: FAIL — module not found / `reply` posted.

- [ ] **Step 3: Implement `src/voice/turn-flags.ts`**

```ts
/**
 * Which sessions are running a voice-origin turn right now, in THIS process
 * (plan deviation 3). The turn runs where the warm session lives, and so do the
 * tools that post to Slack (mono: the in-process surface; node: the tool shim),
 * so a process-local flag is authoritative — no shared store needed.
 */
import { suppressibleSurface } from "../gateway/panel/suppress";
import type { Surface } from "../gateway/core/surface";

const counts = new Map<string, number>();

export const voiceTurns = {
  enter(sessionId: string): void {
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  },
  exit(sessionId: string): void {
    const n = (counts.get(sessionId) ?? 0) - 1;
    if (n > 0) counts.set(sessionId, n);
    else counts.delete(sessionId);
  },
  active(sessionId: string): boolean {
    return (counts.get(sessionId) ?? 0) > 0;
  },
};

export const VOICE_QUIET_TOOLS: ReadonlySet<string> = new Set(["reply", "edit", "react", "unreact", "upload", "typing"]);

export function quietForVoice(surface: Surface, sessionId: string): Surface {
  return suppressibleSurface(surface, sessionId, async (id) => voiceTurns.active(id));
}
```

- [ ] **Step 4: Wire mono / gateway**

In `src/gateway/core/gateway.ts`:

```ts
import { quietForVoice, voiceTurns } from "../../voice/turn-flags";
// …
  const wrapSurface = (surface: Surface, sessionId: string): Surface =>
    quietForVoice(panelInfra ? suppressibleSurface(surface, sessionId, panelHeldAsync) : surface, sessionId);
```

In the stop guard, first line of the callback:

```ts
    if (voiceTurns.active(sessionId)) return null;
```

- [ ] **Step 5: Wire the node shim**

In `src/node/shims/index.ts`: add to `ShimDeps`:

```ts
  /** True while this session runs a voice-origin turn (voice mode, plan
   *  deviation 3): user-visible surface writes are dropped locally. */
  voiceActive?(sessionId: string): boolean;
```

import `VOICE_QUIET_TOOLS` from `../../voice/turn-flags`, and in `shimServer`'s handler, right after the `if (!token) return errResult(...)` line:

```ts
        if (contract.server === surfaceContract.server && VOICE_QUIET_TOOLS.has(t.name) && deps.voiceActive?.(sessionId)) {
          return { content: [{ type: "text", text: JSON.stringify({ ref: "voice-suppressed" }) }] };
        }
```

- [ ] **Step 6: Run to verify they pass**

Run: `bun test tests/voice/turn-flags.test.ts tests/voice/quiet-surface.test.ts tests/node/shims.test.ts tests/gateway`
Expected: PASS (existing gateway tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/voice/turn-flags.ts src/gateway/core/gateway.ts src/node/shims/index.ts tests/voice/turn-flags.test.ts tests/voice/quiet-surface.test.ts tests/node/shims.test.ts
git commit -m "feat(voice): keep the thread quiet during voice turns (mono surface, node shim, stop guard)"
```

---

### Task 12: VoiceCall (parent side of one call) and spawn

**Files:**
- Create: `src/voice/spawn.ts`
- Create: `src/voice/call.ts`
- Test: `tests/voice/call.test.ts`

**Interfaces:**
- Consumes: `ChildMsg`, `ParentMsg`, `EndReason`, `VoiceInit`, `encodeMsg`, `readLines`, `parseChildMsg`, `ENV_API_KEY`, `ENV_STREAM_TOKEN` (Task 2); `TurnRunner` (defined here, implemented in Task 13).
- Produces:
  - `interface LoopChild { send(m: ParentMsg): void; messages: AsyncIterable<ChildMsg>; exited: Promise<number>; kill(): void }`
  - `spawnVoiceLoop(o: { apiKey: string; streamToken: string; execPath?: string }): LoopChild` (spawns `process.execPath src/voice/loop-entry.ts` with `PATH`, `HOME` and the two secret vars only)
  - `interface TurnRunner { run(sessionId: string, text: string, o: { suppress: boolean; voice: boolean }): Promise<void> }`
  - `interface VoiceCallDeps { sessionId: string; runner: TurnRunner; child: LoopChild; transcriptDir: string; holdIdle(hold: boolean): void; onClosed(): void; now?: () => number; idleFlushMs?: number; startTimeoutMs?: number }`
  - `class VoiceCall` with `readonly callId: string`, `start(init: VoiceInit): Promise<void>` (resolves on `started`, rejects on early `ended`/timeout), `say(text, when, replyTo?)`, `context(text)`, `stop(reason: EndReason): Promise<void>`, `done: Promise<EndReason>`.
  - `class VoiceCalls` with `get(sessionId)`, `add(sessionId, call)`, `remove(sessionId)`, `endAll(reason): Promise<void>`, `end(sessionId, reason): Promise<void>`.
  - `delegatePrompt(id, task, transcript): string`, `summaryPrompt(reason, transcriptPath | null): string`, `TRANSCRIPT_FLUSH_PREFIX`

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/call.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceCall, VoiceCalls, type LoopChild, type TurnRunner } from "../../src/voice/call";
import type { ChildMsg, ParentMsg, VoiceInit } from "../../src/voice/ipc";

function fakeChild() {
  const sent: ParentMsg[] = [];
  const q: ChildMsg[] = [];
  let wake: (() => void) | null = null;
  let exit!: (n: number) => void;
  const child: LoopChild & { push(m: ChildMsg): void; sent: ParentMsg[]; killed: boolean } = {
    sent, killed: false,
    send: (m) => sent.push(m),
    push: (m) => { q.push(m); wake?.(); },
    exited: new Promise<number>((r) => (exit = r)),
    kill() { this.killed = true; exit(137); wake?.(); },
    messages: { async *[Symbol.asyncIterator]() { while (true) { if (q.length) { const m = q.shift()!; yield m; if (m.type === "ended") return; continue; } if (child.killed) return; await new Promise<void>((r) => (wake = r)); } } },
  };
  return child;
}
function recRunner(fail = false) {
  const runs: Array<{ text: string; suppress: boolean; voice: boolean }> = [];
  const runner: TurnRunner = { run: async (_s, text, o) => { runs.push({ text, ...o }); if (fail && o.voice && !o.suppress) throw new Error("turn failed"); } };
  return { runner, runs };
}
const init = (callId: string): VoiceInit => ({ callId, audio: { streamUrl: "/s", clearUrl: "/c", headers: {}, sampleRate: 24000 },
  workbenchUrl: "https://wb.example.com", instructions: "x", provider: "openai", model: "m", maxMinutes: 120, staleSeq: 6 });
const until = async (c: () => boolean, ms = 2000) => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(5); } };

function make(over: { fail?: boolean; idleFlushMs?: number } = {}) {
  const child = fakeChild();
  const { runner, runs } = recRunner(over.fail);
  const holds: boolean[] = [];
  let closed = 0;
  const dir = mkdtempSync(join(tmpdir(), "voice-call-"));
  const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: dir, holdIdle: (h) => holds.push(h), onClosed: () => closed++, idleFlushMs: over.idleFlushMs ?? 60_000 });
  return { call, child, runs, holds, closed: () => closed, dir };
}

describe("VoiceCall", () => {
  it("start sends init, holds idle, resolves on started", async () => {
    const t = make();
    const p = t.call.start(init(t.call.callId));
    expect(t.child.sent[0]).toMatchObject({ type: "init" });
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    expect(t.holds).toEqual([true]);
  });

  it("delegate runs a voice turn carrying the buffered transcript", async () => {
    const t = make();
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "is the deploy green?" });
    t.child.push({ type: "delegate", id: "1", task: "check deploy status", asOf: 1 });
    await until(() => t.runs.length === 1);
    expect(t.runs[0]).toMatchObject({ suppress: false, voice: true });
    expect(t.runs[0]!.text).toContain("participant: is the deploy green?");
    expect(t.runs[0]!.text).toContain('voice_say(reply_to="1")');
  });

  it("flushes the transcript as a suppressed turn after idle", async () => {
    const t = make({ idleFlushMs: 20 });
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    t.child.push({ type: "transcript", seq: 1, role: "assistant", text: "hello everyone" });
    await until(() => t.runs.length === 1);
    expect(t.runs[0]).toMatchObject({ suppress: true, voice: true });
  });

  it("a failed delegate turn tells the voice", async () => {
    const t = make({ fail: true });
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    t.child.push({ type: "delegate", id: "7", task: "x", asOf: 0 });
    await until(() => t.child.sent.some((m) => m.type === "context"));
    expect((t.child.sent.find((m) => m.type === "context") as any).text).toContain("#7 failed");
  });

  it("say/context/stop relay to the child; end writes transcript, runs summary, releases idle", async () => {
    const t = make();
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "bye" });
    await Bun.sleep(10); // let the parent process the transcript line
    t.call.say("noted", "next_gap", "1");
    t.call.context("fact");
    const stopping = t.call.stop("stopped");
    expect(t.child.sent.map((m) => m.type)).toEqual(["init", "say", "context", "stop"]);
    expect((t.child.sent[1] as any).asOf).toBe(1);
    t.child.push({ type: "ended", reason: "stopped" });
    await stopping;
    expect(await t.call.done).toBe("stopped");
    const summary = t.runs.at(-1)!;
    expect(summary).toMatchObject({ suppress: false, voice: false });
    expect(summary.text).toContain("browser_audio_stop");
    const path = summary.text.match(/(\/\S+voice-call-\S+\.txt)/)![1]!;
    expect(readFileSync(path, "utf8")).toContain("participant: bye");
    expect(t.holds).toEqual([true, false]);
    expect(t.closed()).toBe(1);
  });

  it("child crash ends loop_crashed", async () => {
    const t = make();
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    t.child.kill();
    expect(await t.call.done).toBe("loop_crashed");
  });

  it("start rejects when the child ends before starting", async () => {
    const t = make();
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "ended", reason: "provider_failed" });
    await expect(p).rejects.toThrow(/provider_failed/);
  });
});

describe("VoiceCalls", () => {
  it("endAll says goodbye now, then stops every call", async () => {
    const calls = new VoiceCalls();
    const t = make();
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    calls.add("s1", t.call);
    const ending = calls.endAll("node_drain", "bye", 0);
    expect(t.child.sent.slice(-2).map((m) => m.type)).toEqual(["say", "stop"]);
    expect(t.child.sent.at(-2)).toMatchObject({ text: "bye", when: "now" });
    t.child.push({ type: "ended", reason: "node_drain" });
    await ending;
    expect(await t.call.done).toBe("node_drain");
  });

  it("session exit ends the call", async () => {
    const calls = new VoiceCalls();
    const t = make();
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    calls.add("s1", t.call);
    const ending = calls.end("s1", "session_rebooted");
    expect(t.child.sent.at(-1)).toEqual({ type: "stop", reason: "session_rebooted" });
    t.child.push({ type: "ended", reason: "session_rebooted" });
    await ending;
    expect(await t.call.done).toBe("session_rebooted");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/voice/call.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/voice/spawn.ts`**

```ts
/** Spawn the `slaude voice-loop` child (voice mode spec §4). Secrets ride the
 *  child's env only; the env is otherwise minimal so nothing else leaks in. */
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { ENV_API_KEY, ENV_STREAM_TOKEN, encodeMsg, parseChildMsg, readLines, type ChildMsg, type ParentMsg } from "./ipc";

const ENTRY = fileURLToPath(new URL("./loop-entry.ts", import.meta.url));

export interface LoopChild {
  send(m: ParentMsg): void;
  messages: AsyncIterable<ChildMsg>;
  exited: Promise<number>;
  kill(): void;
}

export function spawnVoiceLoop(o: { apiKey: string; streamToken: string; execPath?: string }): LoopChild {
  const cp = spawn(o.execPath ?? process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [ENV_API_KEY]: o.apiKey, [ENV_STREAM_TOKEN]: o.streamToken },
  });
  const exited = new Promise<number>((r) => cp.on("exit", (code) => r(code ?? 1)));
  const stdout = Readable.toWeb(cp.stdout!) as unknown as ReadableStream<Uint8Array>;
  return {
    send: (m) => { if (!cp.stdin!.destroyed) cp.stdin!.write(encodeMsg(m)); },
    messages: (async function* () {
      for await (const line of readLines(stdout)) {
        const m = parseChildMsg(line);
        if (m) yield m;
      }
    })(),
    exited,
    kill: () => { try { cp.kill("SIGKILL"); } catch {} },
  };
}
```

- [ ] **Step 4: Implement `src/voice/call.ts`**

```ts
/**
 * Parent side of one voice call (voice mode spec §6-§7): owns the voice-loop
 * child, buffers the transcript, runs delegated turns on the warm session
 * through a TurnRunner, relays Claude's steering, and closes the call with a
 * transcript file and a summary turn.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildMsg, EndReason, VoiceInit } from "./ipc";
import type { LoopChild } from "./spawn";

export type { LoopChild } from "./spawn";

export interface TurnRunner {
  run(sessionId: string, text: string, o: { suppress: boolean; voice: boolean }): Promise<void>;
}

export const TRANSCRIPT_FLUSH_PREFIX = "[voice call transcript]";

export function delegatePrompt(id: string, task: string, transcript: string): string {
  return [
    transcript ? `${TRANSCRIPT_FLUSH_PREFIX}\n${transcript}\n` : "",
    `Voice call request #${id}: ${task}`,
    `Answer with voice_say(reply_to="${id}"). Speakable: short sentences, no markdown, no URLs or code read aloud.`,
    "Do not post to the Slack thread during the call.",
  ].filter(Boolean).join("\n");
}

export function summaryPrompt(reason: EndReason, transcriptPath: string | null): string {
  return [
    `The voice call has ended (reason: ${reason}).`,
    "Call browser_audio_stop for the call's tab and leave the meeting in the browser if you are still in it.",
    "Then post a short summary to this thread: decisions, action items with owners, open questions." +
      (reason === "stopped" || reason === "ended_by_voice" ? "" : " Mention briefly why the call ended."),
    transcriptPath ? `Attach the transcript with the upload tool: ${transcriptPath}` : "",
  ].filter(Boolean).join("\n");
}

export interface VoiceCallDeps {
  sessionId: string;
  runner: TurnRunner;
  child: LoopChild;
  transcriptDir: string;
  holdIdle(hold: boolean): void;
  onClosed(): void;
  idleFlushMs?: number;
  startTimeoutMs?: number;
}

export class VoiceCall {
  readonly callId = randomUUID();
  #lines: string[] = [];
  #pending: string[] = [];
  #seq = 0;
  #queue: Promise<void> = Promise.resolve();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #resolveDone!: (r: EndReason) => void;
  readonly done: Promise<EndReason> = new Promise((r) => (this.#resolveDone = r));
  #endReason: EndReason | null = null;

  constructor(private d: VoiceCallDeps) {}

  start(init: VoiceInit): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("voice loop did not start in time")), this.d.startTimeoutMs ?? 20_000);
      this.d.child.send({ type: "init", init });
      void (async () => {
        for await (const m of this.d.child.messages) {
          if (m.type === "started" && !this.#started) {
            this.#started = true;
            clearTimeout(timer);
            this.d.holdIdle(true);
            resolve();
          } else if (m.type === "ended") {
            clearTimeout(timer);
            if (!this.#started) reject(new Error(`voice loop ended before start: ${m.reason}`));
            await this.#close(m.reason);
            return;
          } else {
            this.#onChild(m);
          }
        }
        clearTimeout(timer);
        if (!this.#started) reject(new Error("voice loop exited before start"));
        await this.#close("loop_crashed");
      })();
    });
  }

  #onChild(m: ChildMsg): void {
    if (m.type === "transcript") {
      this.#seq = m.seq;
      const line = `${m.role === "user" ? "participant" : "voice"}: ${m.text}`;
      this.#lines.push(line);
      this.#pending.push(line);
      this.#armFlush();
    } else if (m.type === "delegate") {
      const transcript = this.#takePending();
      this.#enqueue(async () => {
        try {
          await this.d.runner.run(this.d.sessionId, delegatePrompt(m.id, m.task, transcript), { suppress: false, voice: true });
        } catch (e) {
          this.d.child.send({ type: "context", text: `Request #${m.id} failed: ${e instanceof Error ? e.message : "error"}. Tell the participants you could not get that.` });
        }
      });
    } else if (m.type === "log") {
      console[m.level === "error" ? "error" : m.level === "warn" ? "warn" : "log"](`[voice] session=${this.d.sessionId} ${m.message}`);
    }
  }

  #takePending(): string {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    const t = this.#pending.join("\n");
    this.#pending = [];
    return t;
  }
  #armFlush(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = setTimeout(() => {
      const t = this.#takePending();
      if (t) this.#enqueue(() => this.d.runner.run(this.d.sessionId, `${TRANSCRIPT_FLUSH_PREFIX}\n${t}`, { suppress: true, voice: true }));
    }, this.d.idleFlushMs ?? 30_000);
  }
  #enqueue(fn: () => Promise<void>): void {
    this.#queue = this.#queue.then(fn).catch((e) => console.error(`[voice] turn failed session=${this.d.sessionId}:`, e instanceof Error ? e.message : e));
  }

  say(text: string, when: "next_gap" | "now", replyTo?: string): void {
    this.d.child.send({ type: "say", text, when, replyTo, asOf: this.#seq });
  }
  context(text: string): void {
    this.d.child.send({ type: "context", text });
  }
  async stop(reason: EndReason): Promise<void> {
    this.d.child.send({ type: "stop", reason });
    const t = setTimeout(() => this.d.child.kill(), 5_000);
    await this.done;
    clearTimeout(t);
  }

  async #close(reason: EndReason): Promise<void> {
    if (this.#endReason) return;
    this.#endReason = reason;
    const rest = this.#takePending();
    let path: string | null = null;
    if (this.#lines.length) {
      path = join(this.d.transcriptDir, `voice-call-${this.callId}.txt`);
      try {
        writeFileSync(path, this.#lines.join("\n") + "\n", { mode: 0o600 });
      } catch (e) {
        console.error(`[voice] transcript write failed session=${this.d.sessionId}:`, e instanceof Error ? e.message : e);
        path = null;
      }
    }
    if (rest) this.#enqueue(() => this.d.runner.run(this.d.sessionId, `${TRANSCRIPT_FLUSH_PREFIX}\n${rest}`, { suppress: true, voice: true }));
    if (this.#started) this.#enqueue(() => this.d.runner.run(this.d.sessionId, summaryPrompt(reason, path), { suppress: false, voice: false }));
    await this.#queue;
    if (this.#started) this.d.holdIdle(false);
    this.d.onClosed();
    this.#resolveDone(reason);
  }
}

export class VoiceCalls {
  #calls = new Map<string, VoiceCall>();
  get(sessionId: string): VoiceCall | undefined {
    return this.#calls.get(sessionId);
  }
  add(sessionId: string, call: VoiceCall): void {
    this.#calls.set(sessionId, call);
  }
  remove(sessionId: string): void {
    this.#calls.delete(sessionId);
  }
  async end(sessionId: string, reason: EndReason): Promise<void> {
    await this.#calls.get(sessionId)?.stop(reason);
  }
  /** Node drain: say a short goodbye on every call, give it a moment to play,
   *  then end each call with `reason`. */
  async endAll(reason: EndReason, farewell = "I have to drop off now. I'll post a summary in the thread.", waitMs = 4_000): Promise<void> {
    for (const c of this.#calls.values()) c.say(farewell, "now");
    if (this.#calls.size && waitMs > 0) await Bun.sleep(waitMs);
    await Promise.all([...this.#calls.keys()].map((id) => this.end(id, reason)));
  }
}
```

Note: in the "stop" test the `stop()` promise waits on `done`, which resolves after the summary run completes — the fake runner resolves immediately, so it settles.

- [ ] **Step 5: Run to verify it passes** — `bun test tests/voice/call.test.ts` → PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/voice/spawn.ts src/voice/call.ts tests/voice/call.test.ts
git commit -m "feat(voice): VoiceCall — child lifecycle, transcript buffering, delegated and summary turns"
```

---

### Task 13: Turn runners (mono and node)

**Files:**
- Create: `src/voice/runners.ts`
- Test: `tests/voice/runners.test.ts`

**Interfaces:**
- Consumes: `TurnRunner` (Task 12), `voiceTurns` (Task 11), `HELD_BY_OTHER` from `src/queue/locks.ts` (import as a value; it is a constant symbol there).
- Produces:
  - `interface TurnAgent { suppressNextTurn(id: string): void; sendMessage(id: string, text: string): Promise<void>; on(ev: "event", cb: (e: any) => void): unknown; off(ev: "event", cb: (e: any) => void): unknown }`
  - `waitTurnDone(agent: TurnAgent, sessionId: string, timeoutMs: number): Promise<void>` (resolves on a non-autoEvolve `done`, rejects on `error` or timeout)
  - `monoRunner(agent: TurnAgent, o?: { turnTimeoutMs?: number }): TurnRunner`
  - `nodeRunner(o: { agent: TurnAgent; lock<T>(sessionId: string, fn: () => Promise<T>): Promise<T | typeof HELD_BY_OTHER>; refreshToken(sessionId: string): Promise<void>; turnTimeoutMs?: number; retryMs?: number; maxWaitMs?: number }): TurnRunner`
  - `makeTokenKeeper(o: { jobId: string; token: string; refresh(jobId: string, token: string): Promise<string>; bind(token: string): void }): { refresh(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/runners.test.ts
import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { monoRunner, nodeRunner, makeTokenKeeper, waitTurnDone } from "../../src/voice/runners";
import { voiceTurns } from "../../src/voice/turn-flags";
import { HELD_BY_OTHER } from "../../src/queue/locks";

class StubAgent extends EventEmitter {
  sent: string[] = [];
  suppressed: string[] = [];
  activeDuringSend: boolean[] = [];
  outcome: "done" | "error" | "hang" = "done";
  suppressNextTurn(id: string) { this.suppressed.push(id); }
  async sendMessage(id: string, text: string) {
    this.sent.push(text);
    this.activeDuringSend.push(voiceTurns.active(id));
    if (this.outcome === "hang") return;
    queueMicrotask(() => this.emit("event", this.outcome === "done" ? { type: "done", sessionId: id } : { type: "error", sessionId: id, error: "boom" }));
  }
}

describe("waitTurnDone", () => {
  it("ignores other sessions and autoEvolve done", async () => {
    const a = new StubAgent();
    const p = waitTurnDone(a as any, "s1", 1000);
    a.emit("event", { type: "done", sessionId: "s2" });
    a.emit("event", { type: "done", sessionId: "s1", autoEvolve: true });
    a.emit("event", { type: "done", sessionId: "s1" });
    await p;
  });
  it("rejects on timeout", async () => {
    await expect(waitTurnDone(new StubAgent() as any, "s1", 10)).rejects.toThrow(/timed out/);
  });
});

describe("monoRunner", () => {
  it("suppresses when asked, flags voice turns, clears the flag after", async () => {
    const a = new StubAgent();
    const r = monoRunner(a as any);
    await r.run("s1", "t", { suppress: true, voice: true });
    expect(a.suppressed).toEqual(["s1"]);
    expect(a.activeDuringSend).toEqual([true]);
    expect(voiceTurns.active("s1")).toBe(false);
    await r.run("s1", "summary", { suppress: false, voice: false });
    expect(a.activeDuringSend).toEqual([true, false]);
  });
  it("propagates turn errors and still clears the flag", async () => {
    const a = new StubAgent();
    a.outcome = "error";
    await expect(monoRunner(a as any).run("s2", "t", { suppress: false, voice: true })).rejects.toThrow(/boom/);
    expect(voiceTurns.active("s2")).toBe(false);
  });
});

describe("nodeRunner", () => {
  it("node runner retries while the lock is held, refreshes the token, runs under the lock", async () => {
    const a = new StubAgent();
    let attempts = 0;
    const order: string[] = [];
    const r = nodeRunner({
      agent: a as any,
      lock: async (_id, fn) => { attempts++; if (attempts < 3) return HELD_BY_OTHER; order.push("locked"); return fn(); },
      refreshToken: async () => { order.push("refresh"); },
      retryMs: 1,
    });
    await r.run("s3", "t", { suppress: false, voice: true });
    expect(attempts).toBe(3);
    expect(order).toEqual(["locked", "refresh"]);
    expect(a.sent).toEqual(["t"]);
  });
  it("gives up after maxWaitMs", async () => {
    const r = nodeRunner({ agent: new StubAgent() as any, lock: async () => HELD_BY_OTHER, refreshToken: async () => {}, retryMs: 1, maxWaitMs: 20 });
    await expect(r.run("s4", "t", { suppress: false, voice: true })).rejects.toThrow(/session busy/);
  });
});

describe("makeTokenKeeper", () => {
  it("refreshes the call's own token chain and binds each fresh token", async () => {
    const bound: string[] = [];
    const seen: Array<[string, string]> = [];
    const k = makeTokenKeeper({ jobId: "j1", token: "t0", refresh: async (j, t) => { seen.push([j, t]); return `${t}+`; }, bind: (t) => bound.push(t) });
    await k.refresh();
    await k.refresh();
    expect(seen).toEqual([["j1", "t0"], ["j1", "t0+"]]);
    expect(bound).toEqual(["t0+", "t0++"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/voice/runners.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/voice/runners.ts`**

```ts
/**
 * Running voice-originated turns on the warm session (voice mode spec §6).
 *
 * mono: the AgentManager's prompt queue is the only serialization mono has
 *       (Slack turns use the same path), so sendMessage + wait is enough.
 * node: take lock:session:<id> exactly like a queued job (withSessionLock never
 *       waits, so retry), then refresh the call's job token through the
 *       existing /v1/jobs/:id/token-refresh and bind it, then run.
 */
import { HELD_BY_OTHER } from "../queue/locks";
import type { TurnRunner } from "./call";
import { voiceTurns } from "./turn-flags";

export interface TurnAgent {
  suppressNextTurn(id: string): void;
  sendMessage(id: string, text: string): Promise<void>;
  on(ev: "event", cb: (e: any) => void): unknown;
  off(ev: "event", cb: (e: any) => void): unknown;
}

const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000;

export function waitTurnDone(agent: TurnAgent, sessionId: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { agent.off("event", on); reject(new Error("voice turn timed out")); }, timeoutMs);
    const on = (e: any) => {
      if (e?.sessionId !== sessionId) return;
      if (e.type === "done" && !e.autoEvolve) { clearTimeout(t); agent.off("event", on); resolve(); }
      else if (e.type === "error") { clearTimeout(t); agent.off("event", on); reject(new Error(String(e.error ?? "turn error"))); }
    };
    agent.on("event", on);
  });
}

async function runOnce(agent: TurnAgent, sessionId: string, text: string, o: { suppress: boolean; voice: boolean }, timeoutMs: number) {
  if (o.voice) voiceTurns.enter(sessionId);
  try {
    const done = waitTurnDone(agent, sessionId, timeoutMs);
    if (o.suppress) agent.suppressNextTurn(sessionId);
    await agent.sendMessage(sessionId, text);
    await done;
  } finally {
    if (o.voice) voiceTurns.exit(sessionId);
  }
}

export function monoRunner(agent: TurnAgent, o: { turnTimeoutMs?: number } = {}): TurnRunner {
  return { run: (sid, text, ro) => runOnce(agent, sid, text, ro, o.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) };
}

export function nodeRunner(o: {
  agent: TurnAgent;
  lock<T>(sessionId: string, fn: () => Promise<T>): Promise<T | typeof HELD_BY_OTHER>;
  refreshToken(sessionId: string): Promise<void>;
  turnTimeoutMs?: number;
  retryMs?: number;
  maxWaitMs?: number;
}): TurnRunner {
  return {
    async run(sid, text, ro) {
      const deadline = Date.now() + (o.maxWaitMs ?? 120_000);
      while (true) {
        const r = await o.lock(sid, async () => {
          await o.refreshToken(sid);
          await runOnce(o.agent, sid, text, ro, o.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
          return true as const;
        });
        if (r !== HELD_BY_OTHER) return;
        if (Date.now() >= deadline) throw new Error("session busy: could not take the session lock for the voice turn");
        await Bun.sleep(o.retryMs ?? 250);
      }
    },
  };
}

export function makeTokenKeeper(o: {
  jobId: string;
  token: string;
  refresh(jobId: string, token: string): Promise<string>;
  bind(token: string): void;
}): { refresh(): Promise<void> } {
  let token = o.token;
  return {
    async refresh() {
      token = await o.refresh(o.jobId, token);
      o.bind(token);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/voice/runners.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/voice/runners.ts tests/voice/runners.test.ts
git commit -m "feat(voice): turn runners for mono and node (session lock, token refresh)"
```

---

### Task 14: Voice MCP tools for Claude

**Files:**
- Create: `src/agent/voice-mcp.ts`
- Test: `tests/voice/voice-mcp.test.ts`

**Interfaces:**
- Consumes: `VoiceConfig` (Task 1), `VoiceInit`, `AudioEndpoints` (Task 2), `VoiceCall`, `VoiceCalls`, `LoopChild`, `TurnRunner` (Task 12).
- Produces:
  - `const VOICE_MCP_NAME = "slaude_voice"`
  - `interface VoiceHost { config(sessionId: string): Promise<VoiceConfig | null>; refusal(sessionId: string): Promise<"VOICE_AGENT_ONLY" | "VOICE_UNAVAILABLE" | null>; runner(sessionId: string): TurnRunner; transcriptDir(sessionId: string): Promise<string>; spawn(o: { apiKey: string; streamToken: string }): LoopChild; holdIdle(sessionId: string, hold: boolean): void; instructions(sessionId: string, brief: string): Promise<string> }`
  - `createVoiceMcp(sessionId: string, host: VoiceHost, calls: VoiceCalls): McpSdkServerConfigWithInstance` with tools `voice_start`, `voice_say`, `voice_context`, `voice_stop`
  - `voiceHandlers` (exported for tests): `{ start(sessionId, host, calls, args), say(...), context(...), stop(...) }`
  - `SPEAKING_RULES: string`, `buildInstructions(o: { name?: string; role?: string; voice?: string; values: string[]; mandate?: string }, brief: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/voice-mcp.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceMcp, buildInstructions, type VoiceHost } from "../../src/agent/voice-mcp";
import { VoiceCalls } from "../../src/voice/call";
import type { ChildMsg, ParentMsg } from "../../src/voice/ipc";

const cfg = { provider: "openai" as const, model: "gpt-realtime", apiKey: "sk-x", workbenchUrl: "https://wb.example.com", maxMinutes: 120, staleSeq: 6 };
function fakeChild(autoStart = true) {
  const sent: ParentMsg[] = [];
  const q: ChildMsg[] = [];
  let wake: (() => void) | null = null;
  const child = {
    sent,
    send(m: ParentMsg) {
      sent.push(m);
      if (m.type === "init" && autoStart) { q.push({ type: "started", callId: m.init.callId, sampleRate: 24000 }); wake?.(); }
      if (m.type === "stop") { q.push({ type: "ended", reason: m.reason }); wake?.(); }
    },
    exited: new Promise<number>(() => {}),
    kill() {},
    messages: { async *[Symbol.asyncIterator]() { while (true) { if (q.length) { const m = q.shift()!; yield m; if (m.type === "ended") return; continue; } await new Promise<void>((r) => (wake = r)); } } },
  };
  return child;
}
function host(over: Partial<VoiceHost> = {}) {
  const spawned: Array<{ apiKey: string; streamToken: string }> = [];
  const child = fakeChild();
  const h: VoiceHost = {
    config: async () => cfg,
    refusal: async () => null,
    runner: () => ({ run: async () => {} }),
    transcriptDir: async () => mkdtempSync(join(tmpdir(), "vm-")),
    spawn: (o) => { spawned.push(o); return child as any; },
    holdIdle: () => {},
    instructions: async (_s, brief) => `persona\n${brief}`,
    ...over,
  };
  return { h, spawned, child };
}
const tools = (cfgObj: any) => cfgObj.instance._registeredTools;
const startArgs = {
  brief: "weekly sync",
  audio: { stream_url: "/api/browser/tabs/t1/audio/stream", clear_url: "/api/browser/tabs/t1/audio/clear",
    headers: { "X-Browser-Session": "rk" }, sample_rate: 24000, stream_token: "stok" },
};
const text = (r: any) => r.content[0].text as string;
const until = async (c: () => boolean, ms = 2000) => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(5); } };

describe("voice MCP", () => {
  it("voice_start spawns with secrets in env only and returns a call id", async () => {
    const { h, spawned, child } = host();
    const calls = new VoiceCalls();
    const t = tools(createVoiceMcp("s1", h, calls));
    const r = await t["voice_start"].handler(startArgs);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).callId).toBeString();
    expect(spawned).toEqual([{ apiKey: "sk-x", streamToken: "stok" }]);
    const init = (child.sent[0] as any).init;
    expect(JSON.stringify(init)).not.toContain("stok");
    expect(JSON.stringify(init)).not.toContain("sk-x");
    expect(init.audio).toEqual({ streamUrl: startArgs.audio.stream_url, clearUrl: startArgs.audio.clear_url, headers: { "X-Browser-Session": "rk" }, sampleRate: 24000 });
    expect(init.instructions).toContain("weekly sync");
    expect(calls.get("s1")).toBeDefined();
  });

  it("VOICE_BUSY on a second start", async () => {
    const { h } = host();
    const calls = new VoiceCalls();
    const t = tools(createVoiceMcp("s1", h, calls));
    await t["voice_start"].handler(startArgs);
    const r = await t["voice_start"].handler(startArgs);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("VOICE_BUSY");
  });

  it("VOICE_AGENT_ONLY in a locked or remote thread; nothing spawned", async () => {
    const { h, spawned } = host({ refusal: async () => "VOICE_AGENT_ONLY" });
    const r = await tools(createVoiceMcp("s1", h, new VoiceCalls()))["voice_start"].handler(startArgs);
    expect(text(r)).toContain("VOICE_AGENT_ONLY");
    expect(spawned).toEqual([]);
  });

  it("VOICE_DISABLED without config", async () => {
    const { h } = host({ config: async () => null });
    const r = await tools(createVoiceMcp("s1", h, new VoiceCalls()))["voice_start"].handler(startArgs);
    expect(text(r)).toContain("VOICE_DISABLED");
  });

  it("say/context/stop need an active call; stop ends it and frees the slot", async () => {
    const { h, child } = host();
    const calls = new VoiceCalls();
    const t = tools(createVoiceMcp("s1", h, calls));
    expect(text(await t["voice_say"].handler({ text: "x", when: "next_gap" }))).toContain("VOICE_NO_CALL");
    await t["voice_start"].handler(startArgs);
    await t["voice_say"].handler({ text: "hello", when: "now", reply_to: "2" });
    await t["voice_context"].handler({ text: "fact" });
    expect(child.sent.slice(1).map((m) => m.type)).toEqual(["say", "context"]);
    expect(child.sent[1]).toMatchObject({ text: "hello", when: "now", replyTo: "2" });
    const r = await t["voice_stop"].handler({});
    expect(JSON.parse(text(r)).reason).toBe("stopped");
    await until(() => calls.get("s1") === undefined);
  });
});

describe("buildInstructions", () => {
  it("combines identity, values, mandate, brief and speaking rules", () => {
    const s = buildInstructions({ name: "Ava", role: "release helper", voice: "warm, direct", values: ["honesty"], mandate: "ship safely" }, "standup");
    for (const part of ["Ava", "release helper", "warm, direct", "honesty", "ship safely", "standup", "delegate"]) expect(s).toContain(part);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/voice/voice-mcp.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/agent/voice-mcp.ts`**

```ts
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
    brief ? `This call: ${brief}` : "",
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

export const voiceHandlers = {
  async start(sessionId: string, host: VoiceHost, calls: VoiceCalls, args: { brief: string; audio: z.infer<typeof audioShape>; voice?: string }) {
    if (calls.get(sessionId)) return err("VOICE_BUSY", "a call is already active in this thread");
    const refusal = await host.refusal(sessionId);
    if (refusal === "VOICE_AGENT_ONLY") return err(refusal, "voice calls run as the agent only; not available in a /1on1-locked or /remote thread");
    if (refusal) return err(refusal, "voice is unavailable on this node right now");
    const cfg = await host.config(sessionId);
    if (!cfg) return err("VOICE_DISABLED", "voice mode is not configured");
    const child = host.spawn({ apiKey: cfg.apiKey, streamToken: args.audio.stream_token });
    const call = new VoiceCall({
      sessionId,
      runner: host.runner(sessionId),
      child,
      transcriptDir: await host.transcriptDir(sessionId),
      holdIdle: (h) => host.holdIdle(sessionId, h),
      onClosed: () => calls.remove(sessionId),
    });
    calls.add(sessionId, call);
    const init: VoiceInit = {
      callId: call.callId,
      audio: { streamUrl: args.audio.stream_url, clearUrl: args.audio.clear_url, headers: args.audio.headers, sampleRate: args.audio.sample_rate },
      workbenchUrl: cfg.workbenchUrl,
      instructions: await host.instructions(sessionId, args.brief),
      provider: cfg.provider,
      model: cfg.model,
      voice: args.voice ?? cfg.voice,
      maxMinutes: cfg.maxMinutes,
      staleSeq: cfg.staleSeq,
    };
    try {
      await call.start(init);
    } catch (e) {
      calls.remove(sessionId);
      child.kill();
      return err("VOICE_START_FAILED", e instanceof Error ? e.message : String(e));
    }
    return ok({ callId: call.callId });
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
    void call.stop("stopped");
    return ok({ reason: "stopped" });
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
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/voice/voice-mcp.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/voice-mcp.ts tests/voice/voice-mcp.test.ts
git commit -m "feat(voice): voice_start/say/context/stop tools for the Claude session"
```

---

### Task 15: Runtime bundle carries voice config

**Files:**
- Modify: `src/gateway/api/tenants.ts` (`RuntimeBundle` at ~38-73; `handleTenantRuntime` at ~377)
- Test: `tests/gateway/runtime-bundle-voice.test.ts`

**Interfaces:**
- Consumes: `VoiceBundle`, `voiceBundleFromEnv` (Task 1).
- Produces: `RuntimeBundle.voice?: VoiceBundle | null`, set at the single place every bundle leaves the gateway (`handleTenantRuntime`, before the ETag is computed, so a voice config change busts node caches).

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/runtime-bundle-voice.test.ts
import { describe, it, expect, beforeAll, afterEach } from "bun:test";

const { ensureHome } = await import("../../src/config/home");
const { handleTenantRuntime } = await import("../../src/gateway/api/tenants");
const { __resetPersonaRegistry } = await import("../../src/persona/registry");

const KEYS = ["SLAUDE_VOICE_ENABLED", "SLAUDE_VOICE_API_KEY", "SLAUDE_VOICE_WORKBENCH_URL"];
beforeAll(() => { ensureHome(); __resetPersonaRegistry(); });
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

const fetchBundle = async (etag?: string) =>
  handleTenantRuntime(new Request("http://gw/x", etag ? { headers: { "if-none-match": etag } } : {}), "default", "default");

describe("runtime bundle voice block", () => {
  it("is null when voice is disabled", async () => {
    const r = await fetchBundle();
    expect(r.status).toBe(200);
    expect((await r.json()).voice).toBeNull();
  });

  it("carries the gateway's voice env when enabled, and changes the ETag", async () => {
    const before = (await fetchBundle()).headers.get("etag")!;
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    const r = await fetchBundle(before);
    expect(r.status).toBe(200);
    expect((await r.json()).voice).toEqual({ model: "openai/gpt-realtime", apiKey: "k", workbenchUrl: "https://wb.example.com" });
  });
});
```

(`voice` is absent from the JSON when `voiceName` is unset, because `JSON.stringify` drops `undefined`; the `toEqual` above relies on that.)

- [ ] **Step 2: Run to verify it fails** — `bun test tests/gateway/runtime-bundle-voice.test.ts` → FAIL (`voice` is `undefined`, not `null`).

- [ ] **Step 3: Implement**

In `src/gateway/api/tenants.ts`:

```ts
import { voiceBundleFromEnv, type VoiceBundle } from "../../voice/config";
```

in `interface RuntimeBundle`:

```ts
  /** Voice provider config for voice mode (plan deviation 2): gateway env →
   *  node. Holds a plaintext key; evicted with the bundle like providerCreds. */
  voice?: VoiceBundle | null;
```

in `handleTenantRuntime`, replace

```ts
  if (!bundle) return notFound("unknown tenant or persona");
  const body = JSON.stringify(bundle);
```

with

```ts
  if (!bundle) return notFound("unknown tenant or persona");
  const body = JSON.stringify({ ...bundle, voice: voiceBundleFromEnv() });
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/gateway/runtime-bundle-voice.test.ts tests/gateway tests/skills-layout.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/api/tenants.ts tests/gateway/runtime-bundle-voice.test.ts
git commit -m "feat(voice): runtime bundle carries the gateway's voice config to nodes"
```

---

### Task 16: Wire voice into mono and the node worker

**Files:**
- Modify: `src/gateway/core/gateway.ts` (`mcpResolver` at ~842-856; stop guard already touched in Task 11)
- Modify: `src/node/worker.ts` (job tracking at claim ~813-827; `setMcpResolver` at ~498-519; `buildShimServers` deps; `stop()` drain at ~1030; `agent.on("sessionExit")`)
- Create: `src/voice/hosts.ts`
- Test: `tests/voice/hosts.test.ts`

**Interfaces:**
- Consumes: everything above; `decodeClaims` (`src/node/remote.ts:16`), `withSessionLock` (`src/queue/locks.ts:67`), `NodeClient.refreshJobToken(jobId, token)` (`src/node/client.ts:484`), `NodeClient.getRuntime(tenantId, personaId, jobToken)` (`src/node/client.ts:297`), `RestSessionStore.findById/bindToken/tokenFor`, `OneOnOne.find(channel, thread)` (`src/db/one-on-one.ts:45`), `activeRemoteTarget(channel, thread)` (`src/remote/active.ts:7`), `SoulDataSchema` fields `identity.{name,role,voice}`, `values`, `mandate`.
- Produces:
  - `voiceRefusalFromClaims(claims: { lock?: unknown; remote?: unknown; runAs?: string } | null): "VOICE_AGENT_ONLY" | null`
  - `makeMonoVoiceHost(o: { agent: AgentManager; findThread(sessionId): Promise<{ channel: string; threadTs: string } | null>; workingDir(sessionId): Promise<string>; soul(): { identity: { name?: string; role?: string; voice?: string }; values: string[]; mandate?: string } }): VoiceHost`
  - `makeNodeVoiceHost(o: { agent: AgentManager; tokenFor(id): string | undefined; currentJob(id): { jobId: string; token: string } | undefined; bindToken(id, token): void; refresh(jobId, token): Promise<string>; lock<T>(id, fn: () => Promise<T>): Promise<T | typeof HELD_BY_OTHER>; bundle(id): Promise<{ voice?: VoiceBundle | null; soulJson: unknown } | null>; workingDir(id): Promise<string>; draining(): boolean }): VoiceHost`

- [ ] **Step 1: Write the failing test**

```ts
// tests/voice/hosts.test.ts
import { describe, it, expect } from "bun:test";
import { voiceRefusalFromClaims, makeNodeVoiceHost } from "../../src/voice/hosts";

describe("voiceRefusalFromClaims", () => {
  it("refuses locked, remote, or person-identity turns", () => {
    expect(voiceRefusalFromClaims({ lock: { user: "U1", openScope: null } })).toBe("VOICE_AGENT_ONLY");
    expect(voiceRefusalFromClaims({ lock: null, remote: { addr: "a", dir: "/d" } })).toBe("VOICE_AGENT_ONLY");
    expect(voiceRefusalFromClaims({ lock: null, runAs: "user:U1" })).toBe("VOICE_AGENT_ONLY");
    expect(voiceRefusalFromClaims({ lock: null, runAs: "agent" })).toBeNull();
    expect(voiceRefusalFromClaims(null)).toBeNull();
  });
});

describe("node voice host", () => {
  const base = {
    agent: {} as any, tokenFor: () => "t", bindToken: () => {}, refresh: async (_j: string, t: string) => t + "+",
    lock: async (_id: string, fn: () => Promise<any>) => fn(), workingDir: async () => "/tmp",
  };
  it("is unavailable while draining", async () => {
    const h = makeNodeVoiceHost({ ...base, currentJob: () => ({ jobId: "j", token: "t" }), bundle: async () => null, draining: () => true });
    expect(await h.refusal("s1")).toBe("VOICE_UNAVAILABLE");
  });
  it("is unavailable without a current job to refresh from", async () => {
    const h = makeNodeVoiceHost({ ...base, currentJob: () => undefined, bundle: async () => null, draining: () => false });
    expect(await h.refusal("s1")).toBe("VOICE_UNAVAILABLE");
  });
  it("reads voice config from the bundle", async () => {
    const h = makeNodeVoiceHost({ ...base, currentJob: () => ({ jobId: "j", token: "t" }), draining: () => false,
      bundle: async () => ({ voice: { model: "openai/gpt-realtime", apiKey: "k", workbenchUrl: "https://wb.example.com" }, soulJson: null }) });
    expect((await h.config("s1"))!.apiKey).toBe("k");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/voice/hosts.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/voice/hosts.ts`**

```ts
/**
 * VoiceHost implementations: where a call's config, identity check, turn runner
 * and child process come from, per runtime (mono process or node worker).
 */
import type { AgentManager } from "../agent/manager";
import { buildInstructions, type VoiceHost } from "../agent/voice-mcp";
import type { HELD_BY_OTHER } from "../queue/locks";
import { voiceConfigFromBundle, voiceConfigFromEnv, type VoiceBundle } from "./config";
import { makeTokenKeeper, monoRunner, nodeRunner } from "./runners";
import { spawnVoiceLoop } from "./spawn";

type SoulExcerpt = { identity: { name?: string; role?: string; voice?: string }; values: string[]; mandate?: string };

export function voiceRefusalFromClaims(c: { lock?: unknown; remote?: unknown; runAs?: string } | null): "VOICE_AGENT_ONLY" | null {
  if (!c) return null;
  if (c.lock) return "VOICE_AGENT_ONLY";
  if (c.remote) return "VOICE_AGENT_ONLY";
  if (c.runAs && c.runAs !== "agent") return "VOICE_AGENT_ONLY";
  return null;
}

function excerpt(soulJson: unknown): SoulExcerpt {
  const s = (soulJson ?? {}) as Partial<SoulExcerpt>;
  return { identity: s.identity ?? {}, values: Array.isArray(s.values) ? s.values : [], mandate: s.mandate };
}

export function makeMonoVoiceHost(o: {
  agent: AgentManager;
  findThread(sessionId: string): Promise<{ channel: string; threadTs: string } | null>;
  oneOnOne(channel: string, threadTs: string): Promise<unknown | null>;
  remoteTarget(channel: string, threadTs: string): Promise<unknown | null>;
  workingDir(sessionId: string): Promise<string>;
  soul(): SoulExcerpt;
}): VoiceHost {
  const runner = monoRunner(o.agent);
  return {
    config: async () => voiceConfigFromEnv(),
    refusal: async (sid) => {
      const t = await o.findThread(sid);
      if (!t) return null;
      const [lock, remote] = await Promise.all([o.oneOnOne(t.channel, t.threadTs), o.remoteTarget(t.channel, t.threadTs)]);
      return voiceRefusalFromClaims({ lock, remote });
    },
    runner: () => runner,
    transcriptDir: (sid) => o.workingDir(sid),
    spawn: (s) => spawnVoiceLoop(s),
    holdIdle: (sid, h) => o.agent.holdIdle(sid, h),
    instructions: async (_sid, brief) => {
      const s = o.soul();
      return buildInstructions({ ...s.identity, values: s.values, mandate: s.mandate }, brief);
    },
  };
}

export function makeNodeVoiceHost(o: {
  agent: AgentManager;
  tokenFor(id: string): string | undefined;
  currentJob(id: string): { jobId: string; token: string } | undefined;
  bindToken(id: string, token: string): void;
  refresh(jobId: string, token: string): Promise<string>;
  lock<T>(id: string, fn: () => Promise<T>): Promise<T | typeof HELD_BY_OTHER>;
  bundle(id: string): Promise<{ voice?: VoiceBundle | null; soulJson: unknown } | null>;
  workingDir(id: string): Promise<string>;
  draining(): boolean;
  claims?(id: string): { lock?: unknown; remote?: unknown; runAs?: string } | null;
}): VoiceHost {
  const keepers = new Map<string, { refresh(): Promise<void> }>();
  return {
    config: async (sid) => voiceConfigFromBundle((await o.bundle(sid))?.voice),
    refusal: async (sid) => {
      if (o.draining()) return "VOICE_UNAVAILABLE";
      const job = o.currentJob(sid);
      if (!job) return "VOICE_UNAVAILABLE";
      const r = voiceRefusalFromClaims(o.claims?.(sid) ?? null);
      if (r) return r;
      keepers.set(sid, makeTokenKeeper({ jobId: job.jobId, token: job.token, refresh: o.refresh, bind: (t) => o.bindToken(sid, t) }));
      return null;
    },
    runner: (sid) =>
      nodeRunner({
        agent: o.agent,
        lock: o.lock,
        refreshToken: async () => {
          const k = keepers.get(sid);
          if (!k) throw new Error("no call token for this session");
          await k.refresh();
        },
      }),
    transcriptDir: (sid) => o.workingDir(sid),
    spawn: (s) => spawnVoiceLoop(s),
    holdIdle: (sid, h) => {
      o.agent.holdIdle(sid, h);
      if (!h) keepers.delete(sid);
    },
    instructions: async (sid, brief) => {
      const s = excerpt((await o.bundle(sid))?.soulJson);
      return buildInstructions({ ...s.identity, values: s.values, mandate: s.mandate }, brief);
    },
  };
}
```

`nodeRunner`'s refresh failure (the gateway refused: label changed, max age) throws inside the turn; `VoiceCall` reports it to the voice as a failed request. To end the call with `auth_lost` as the spec requires, `refreshToken` rethrows a typed error and `VoiceCall`'s delegate catch checks it: add to `src/voice/runners.ts`:

```ts
export class VoiceAuthLost extends Error {}
```

wrap the keeper call in `makeNodeVoiceHost`'s `refreshToken`:

```ts
          try { await k.refresh(); } catch (e) { throw new VoiceAuthLost(e instanceof Error ? e.message : String(e)); }
```

and in `VoiceCall.#onChild`'s delegate catch (Task 12 file), before sending context:

```ts
          if (e instanceof VoiceAuthLost) { this.d.child.send({ type: "stop", reason: "auth_lost" }); return; }
```

(import `VoiceAuthLost` from `./runners` in `call.ts`). Add a test to `tests/voice/call.test.ts`:

```ts
  it("auth lost on a delegate stops the call with auth_lost", async () => {
    const { VoiceAuthLost } = await import("../../src/voice/runners");
    const child = fakeChild();
    const call = new VoiceCall({ sessionId: "s1", child, transcriptDir: tmpdir(), holdIdle: () => {}, onClosed: () => {},
      runner: { run: async (_s, _t, o) => { if (o.voice && !o.suppress) throw new VoiceAuthLost("refused"); } } });
    const p = call.start(init(call.callId));
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
    child.push({ type: "delegate", id: "1", task: "x", asOf: 0 });
    await until(() => child.sent.some((m) => m.type === "stop"));
    expect(child.sent.at(-1)).toEqual({ type: "stop", reason: "auth_lost" });
  });
```

- [ ] **Step 4: Wire mono (`src/gateway/core/gateway.ts`)**

Near the top-level of `createGateway`, after `routes` is defined:

```ts
import { createVoiceMcp, VOICE_MCP_NAME } from "../../agent/voice-mcp";
import { VoiceCalls } from "../../voice/call";
import { makeMonoVoiceHost } from "../../voice/hosts";
import * as OneOnOne from "../../db/one-on-one";
import { activeRemoteTarget } from "../../remote/active";
import * as Sessions from "../../db/sessions";
// …
  const voiceCalls = new VoiceCalls();
  const voiceHost = env.voice.enabled()
    ? makeMonoVoiceHost({
        agent,
        findThread: async (sid) => {
          const r = await Sessions.findById(sid);
          return r ? { channel: r.slack_channel_id, threadTs: r.slack_thread_ts } : null;
        },
        oneOnOne: (c, t) => OneOnOne.find(c, t),
        remoteTarget: (c, t) => activeRemoteTarget(c, t),
        workingDir: async (sid) => (await Sessions.findById(sid))!.working_dir,
        soul: () => soulData(),
      })
    : null;
  agent.on("sessionExit", (sid: string) => void voiceCalls.end(sid, "session_rebooted"));
```

(Session rows carry `slack_channel_id`, `slack_thread_ts` and `working_dir` — `src/db/sessions.ts`. If `gateway.ts` already imports the one-on-one or sessions modules under other names, reuse those imports instead of adding new ones.)

Inside `mcpResolver = async (sessionId) => {…}`, add to the returned server map, only when `voiceHost` is set and the session is not a gateway-role session (mono path only — gateway role never runs sessions):

```ts
      ...(voiceHost ? { [VOICE_MCP_NAME]: createVoiceMcp(sessionId, voiceHost, voiceCalls) } : {}),
```

- [ ] **Step 5: Wire the node worker (`src/node/worker.ts`)**

Add imports (the worker already imports `withSessionLock`, `HELD_BY_OTHER` and `decodeClaims`):

```ts
import { createVoiceMcp, VOICE_MCP_NAME } from "../agent/voice-mcp";
import { VoiceCalls } from "../voice/call";
import { makeNodeVoiceHost } from "../voice/hosts";
import { voiceTurns } from "../voice/turn-flags";
```

a) Track the current job per session. Next to `tenants`/`personas` maps:

```ts
  /** The newest claimed job per session — voice_start's token chain starts here. */
  const currentJobs = new Map<string, { jobId: string; token: string }>();
```

after `jobToken = await tokenAtClaim(...)` (~815), add:

```ts
    currentJobs.set(data.sessionId, { jobId: String(job.id), token: jobToken });
```

and delete it wherever `tenants.delete(sessionId)` runs in the heartbeat cleanup.

b) Build the host and registry once, after `agent.setSessionStore(store);`:

```ts
  const voiceCalls = new VoiceCalls();
  const voiceHost = makeNodeVoiceHost({
    agent,
    tokenFor: (id) => store.tokenFor(id),
    currentJob: (id) => currentJobs.get(id),
    bindToken: (id, t) => store.bindToken(id, t),
    refresh: (jobId, t) => client.refreshJobToken(jobId, t),
    lock: (id, fn) => withSessionLock(id, nodeId, () => fn(), { redis: cmd, keys, ...sessionLockOpts, ...opts.lock }),
    bundle: async (id) => {
      const tenant = tenants.get(id);
      const tok = store.tokenFor(id);
      return tenant && tok ? client.getRuntime(tenant, personas.get(id) ?? "default", tok) : null;
    },
    workingDir: async (id) => (await store.findById(id))!.working_dir,
    draining: () => state === "draining" || state === "stopped",
    claims: (id) => decodeClaims(store.tokenFor(id) ?? "") as any,
  });
  agent.on("sessionExit", (sid: string) => void voiceCalls.end(sid, "session_rebooted"));
```

(`sessionLockOpts`, `cmd`, `keys`, `nodeId`, `state` are existing locals in the worker; if any name differs, use the one at the `withSessionLock` call site ~837.)

c) In `setMcpResolver`, pass `voiceActive` to the shims and mount the voice MCP when the bundle has voice:

```ts
      ...buildShimServers(sessionId, {
        client,
        tokenFor: (id) => store.tokenFor(id),
        signalFor: (id) => turnAborts.get(id)?.signal,
        voiceActive: (id) => voiceTurns.active(id),
      }),
      [SESSION_MCP_NAME]: createSessionMcp({ getSnapshot: () => agent.getTokenSnapshot(sessionId) }),
      ...((await voiceHost.config(sessionId)) ? { [VOICE_MCP_NAME]: createVoiceMcp(sessionId, voiceHost, voiceCalls) } : {}),
```

d) Drain: at the start of `stop()`, right after `state = "draining";`:

```ts
    await voiceCalls.endAll("node_drain").catch(() => {});
```

`endAll` (Task 12) says the goodbye line and waits ~4 s before stopping each call, inside the drain grace.

- [ ] **Step 6: Run the affected suites**

Run: `bun test tests/voice tests/node tests/gateway tests/agent`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/voice/hosts.ts src/voice/call.ts src/voice/runners.ts src/gateway/core/gateway.ts src/node/worker.ts tests/voice/hosts.test.ts tests/voice/call.test.ts
git commit -m "feat(voice): wire voice calls into mono and the node worker (identity check, drain, session exit)"
```

---

### Task 17: End-to-end in-process test

**Files:**
- Create: `tests/voice/e2e-mono.test.ts`

**Interfaces:**
- Consumes: `runVoiceLoop` (Task 9), `VoiceCall`/`VoiceCalls` (Task 12), `monoRunner` (Task 13), `createVoiceMcp` (Task 14), `FakeProvider`, `FakeAudio` (Task 4).

This test runs the whole parent/child path in one process: the child side is `runVoiceLoop` with fakes, connected to the parent's `VoiceCall` through an in-memory `LoopChild` pair, and the Claude side is a stub agent whose "turn" calls the voice MCP's `voice_say` tool — the shape a real delegated turn takes.

- [ ] **Step 1: Write the test**

```ts
// tests/voice/e2e-mono.test.ts
import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVoiceLoop } from "../../src/voice/loop";
import { VoiceCalls, type LoopChild } from "../../src/voice/call";
import { monoRunner } from "../../src/voice/runners";
import { createVoiceMcp, type VoiceHost } from "../../src/agent/voice-mcp";
import { voiceTurns } from "../../src/voice/turn-flags";
import type { ChildMsg, ParentMsg } from "../../src/voice/ipc";
import { FakeProvider, FakeAudio } from "./fakes";

function chan<T>() {
  const q: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(x: T) { q.push(x); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() { while (true) { if (q.length) { yield q.shift()!; continue; } if (closed) return; await new Promise<void>((r) => (wake = r)); } },
  };
}
const until = async (c: () => boolean, ms = 3000) => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(5); } };

describe("voice e2e (in-process)", () => {
  it("delegate → Claude turn with transcript → voice_say → provider speaks; quiet thread; summary at end", async () => {
    const provider = new FakeProvider();
    const audio = new FakeAudio();
    const toChild = chan<ParentMsg>();
    const toParent = chan<ChildMsg>();
    let exit!: (n: number) => void;
    const child: LoopChild = { send: (m) => toChild.push(m), messages: toParent, exited: new Promise((r) => (exit = r)), kill: () => { toChild.close(); exit(1); } };
    const childInbox = (async function* () { for await (const m of toChild) if (m.type !== "init") yield m; })();
    let childStarted = false;

    const posted: string[] = [];
    const turns: string[] = [];
    let mcpTools: any;
    class StubAgent extends EventEmitter {
      suppressNextTurn() {}
      holdIdle() {}
      async sendMessage(sid: string, text: string) {
        turns.push(text);
        if (text.includes("Voice call request #1")) {
          // a real turn would also try to reply — suppressed while voiceTurns is active
          if (!voiceTurns.active(sid)) posted.push("leaked");
          await mcpTools["voice_say"].handler({ text: "The deploy is green.", when: "next_gap", reply_to: "1" });
        }
        if (text.includes("voice call has ended")) posted.push("summary");
        queueMicrotask(() => this.emit("event", { type: "done", sessionId: sid }));
      }
    }
    const agent = new StubAgent();
    const host: VoiceHost = {
      config: async () => ({ provider: "openai", model: "m", apiKey: "k", workbenchUrl: "https://wb.example.com", maxMinutes: 120, staleSeq: 6 }),
      refusal: async () => null,
      runner: () => monoRunner(agent as any),
      transcriptDir: async () => mkdtempSync(join(tmpdir(), "voice-e2e-")),
      spawn: () => {
        // first ParentMsg is init → start the in-process loop with it
        const origSend = child.send;
        child.send = (m) => {
          if (m.type === "init" && !childStarted) {
            childStarted = true;
            void runVoiceLoop({ init: m.init, makeProvider: () => provider, audio, inbox: childInbox, emit: (x) => toParent.push(x), tickMs: 5 })
              .then(() => toParent.close());
            return;
          }
          origSend(m);
        };
        return child;
      },
      holdIdle: () => {},
      instructions: async (_s, brief) => brief,
    };
    const calls = new VoiceCalls();
    mcpTools = (createVoiceMcp("s1", host, calls) as any).instance._registeredTools;

    const r = await mcpTools["voice_start"].handler({ brief: "deploy sync", audio: { stream_url: "/s", clear_url: "/c", headers: {}, sample_rate: 24000, stream_token: "st" } });
    expect(r.isError).toBeFalsy();

    provider.emitEvent("transcript", { role: "user", text: "is the deploy green?", itemId: "u1" });
    provider.emitEvent("toolCall", { callId: "c1", name: "delegate", args: { task: "check deploy status" } });
    await until(() => turns.length === 1);
    expect(turns[0]).toContain("participant: is the deploy green?");
    await until(() => provider.named("addContext").some((c) => String(c[1]).includes("The deploy is green.")));
    expect(provider.named("respond").length).toBeGreaterThanOrEqual(1);
    expect(posted).toEqual([]);

    await mcpTools["voice_stop"].handler({});
    await until(() => calls.get("s1") === undefined);
    expect(posted).toEqual(["summary"]);
    expect(audio.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — `bun test tests/voice/e2e-mono.test.ts` → PASS. If it fails, the failure points at an interface mismatch between tasks; fix in the owning task's file, not in the test.

- [ ] **Step 3: Run the full suite** — `bun test` → PASS, coverage thresholds from `bunfig.toml` still met.

- [ ] **Step 4: Commit**

```bash
git add tests/voice/e2e-mono.test.ts
git commit -m "test(voice): in-process end-to-end — delegate, steer, quiet thread, summary"
```

---

### Task 18: Opt-in live test, docs, release notes

**Files:**
- Create: `tests/voice/live.test.ts`
- Create: `docs/site/_content/guides/voice-mode.md` (check `docs/site/nav.json` for the right section and add an entry)
- Create: `docs/site/_content/releases/vX.Y.Z.md` (next stable name; RC notes live here per CLAUDE.md)
- Create: `docs/site/_content/field-notes/2026-10-08-voice-mode.md` and index it in `CLAUDE.md`'s Findings Log (newest first)

- [ ] **Step 1: Write the opt-in live test**

```ts
// tests/voice/live.test.ts — runs only with VOICE_E2E=1 and real credentials.
// Needs: SLAUDE_VOICE_API_KEY (OpenAI), VOICE_E2E_WORKBENCH_URL, VOICE_E2E_STREAM_URL,
// VOICE_E2E_CLEAR_URL, VOICE_E2E_ROUTE, VOICE_E2E_STREAM_TOKEN — from a workbench tab on a
// local test page where browser_audio_start was already called.
import { describe, it, expect } from "bun:test";
import { runVoiceLoop } from "../../src/voice/loop";
import { AudioLink } from "../../src/voice/audio-link";
import { OpenAIRealtime } from "../../src/voice/provider/openai-realtime";
import type { ChildMsg } from "../../src/voice/ipc";

const live = process.env.VOICE_E2E === "1";
describe.skipIf(!live)("voice live", () => {
  it("hears speech played into the tab and answers with audio", async () => {
    const e = process.env;
    const out: ChildMsg[] = [];
    const audio = new AudioLink({
      baseUrl: e.VOICE_E2E_WORKBENCH_URL!,
      endpoints: { streamUrl: e.VOICE_E2E_STREAM_URL!, clearUrl: e.VOICE_E2E_CLEAR_URL!, headers: { "X-Browser-Session": e.VOICE_E2E_ROUTE! }, sampleRate: 24000 },
      streamToken: e.VOICE_E2E_STREAM_TOKEN!,
    });
    let written = 0;
    const counting = { ...audio, start: audio.start.bind(audio), clear: audio.clear.bind(audio), close: audio.close.bind(audio), write: (p: Int16Array) => { written += p.length; audio.write(p); } };
    const inbox = (async function* () { await Bun.sleep(60_000); yield { type: "stop" as const, reason: "stopped" as const }; })();
    await runVoiceLoop({
      init: { callId: "live", audio: { streamUrl: "", clearUrl: "", headers: {}, sampleRate: 24000 }, workbenchUrl: e.VOICE_E2E_WORKBENCH_URL!,
        instructions: "You are a test assistant. Answer any question in one short sentence.", provider: "openai", model: "gpt-realtime", maxMinutes: 2, staleSeq: 6 },
      makeProvider: () => new OpenAIRealtime({ apiKey: e.SLAUDE_VOICE_API_KEY!, model: "gpt-realtime" }),
      audio: counting, inbox, emit: (m) => out.push(m),
    });
    expect(out.some((m) => m.type === "transcript" && m.role === "user")).toBe(true);
    expect(written).toBeGreaterThan(0);
  }, 90_000);
});
```

- [ ] **Step 2: Docs page** (`docs/site/_content/guides/voice-mode.md`) — sections: what it does; prerequisites (workbench with `BROWSER_AUDIO_ENABLED` and the `stream_token` capability); configuration table (`SLAUDE_VOICE_ENABLED`, `SLAUDE_VOICE_MODEL`, `SLAUDE_VOICE_NAME`, `SLAUDE_VOICE_API_KEY`, `SLAUDE_VOICE_WORKBENCH_URL`, `SLAUDE_VOICE_MAX_MINUTES`, `SLAUDE_VOICE_STALE_SEQ`) and that in the gateway topology only the gateway sets them; how a call starts (ask the agent in a thread to join a meeting link; it joins, calls `browser_audio_start`, then `voice_start`); agent-identity-only rule; the quiet thread and the end-of-call summary; consent note ("the agent introduces itself; recording and consent law is the operator's responsibility"). Use generic examples only (`#team-channel`, `https://meet.example.com/abc`). Add the page to `docs/site/nav.json`.

- [ ] **Step 3: Release notes** (`docs/site/_content/releases/vX.Y.Z.md`) — Features: voice mode (why: talk with the agent in live calls while the thread's session does the thinking); Internal: `holdIdle`/`sessionExit` on AgentManager, runtime bundle `voice` block; note it ships as an RC first and needs the workbench `stream_token` change.

- [ ] **Step 4: Field note stub** (`docs/site/_content/field-notes/2026-10-08-voice-mode.md`) — mechanism decisions (node-local loop, no gateway state, token refresh keyed on the voice_start job, quiet thread via surface suppression, flush-not-barge), and a "Measured" section to fill during RC soak: flush latency, `played_ms` accuracy seen by the VL, delegate round trip, reconnect gap. Add the index line at the top of `CLAUDE.md`'s Findings Log.

- [ ] **Step 5: Leak scan and commit**

```bash
git add tests/voice/live.test.ts docs/site/_content/guides/voice-mode.md docs/site/nav.json docs/site/_content/releases/ docs/site/_content/field-notes/2026-10-08-voice-mode.md CLAUDE.md
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY'
git commit -m "docs(voice): guide, release notes, field note; opt-in live test"
```

Expected: the grep prints nothing (test fixtures use `sk-x`/`sk-test`, which do not match the 20-char pattern).

---

## Self-review notes

- **Spec coverage:** §3 tools → Task 14; §4 IPC → Task 2; §5.1 interface/adapters → Tasks 4-6; §5.2 rates → Tasks 3, 9; §5.3 voice tools → Task 8; §5.4 conductor → Task 8; §5.5 audio link → Task 7 (with deviation 1); §6 injection, token, output, identity drift, idle TTL → Tasks 10, 11, 13, 16; §7 lifecycle/summary → Task 12; §8 failures → Tasks 7, 8, 9, 12, 16; §9 config → Tasks 1, 15 (deviation 2); §10 security → Tasks 12 (env-only secrets), 14 (agent-only), 16; §11 tests → per task + Task 17; §12 release → Task 18.
- **Known gap kept from the spec:** no thread notice when a node dies mid-call.
- **Order dependencies:** 1→2→(3,4)→5→6→7→8→9 build the child; 10→11→12→13→14→15→16 build the parent side; 17 needs both; 18 last.
