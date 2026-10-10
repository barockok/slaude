/**
 * `slaude voice-loop` — child process entry. Reads one `init` line from stdin,
 * then say/context/stop lines; writes ChildMsg lines to stdout. The provider key
 * comes only from the environment; the audio capability URLs come in `init` and
 * are scrubbed from every log line. stdin EOF (parent died) ends the call.
 */
import { AudioLink, CapabilityRedactor } from "./audio-link";
import { parseAudioOrigins } from "./audio-acl";
import { ENV_API_KEY, encodeMsg, parseParentMsg, readLines, type ChildMsg, type ParentMsg } from "./ipc";
import { runVoiceLoop } from "./loop";
import { createProvider } from "./provider";

let endedEmitted = false;
// Set once init arrives: the capability URLs are the audio session's secret.
let scrub = (s: string) => s;
const emit = (m: ChildMsg) => {
  if (m.type === "ended") {
    if (endedEmitted) return;
    endedEmitted = true;
  }
  if (m.type === "log") m = { ...m, message: scrub(m.message) };
  process.stdout.write(encodeMsg(m));
};
const crash = (e: unknown) => {
  emit({ type: "log", level: "error", message: `voice-loop crashed: ${e instanceof Error ? e.message : String(e)}` });
  emit({ type: "ended", reason: "loop_crashed" });
  process.exit(1);
};
process.on("unhandledRejection", crash);
process.on("uncaughtException", crash);
const apiKey = process.env[ENV_API_KEY] ?? "";
delete process.env[ENV_API_KEY];

const lines = readLines(Bun.stdin.stream());
const first = await lines.next();
const initMsg = first.done ? null : parseParentMsg(first.value);
if (!initMsg || initMsg.type !== "init" || !apiKey) {
  emit({ type: "log", level: "error", message: "voice-loop: missing init message or credentials" });
  emit({ type: "ended", reason: "loop_crashed" });
  process.exit(2);
}
const init = initMsg.init;
const redactor = new CapabilityRedactor(init.audio);
scrub = (s) => redactor.redact(s);

async function* inbox(): AsyncGenerator<ParentMsg> {
  for await (const line of lines) {
    const m = parseParentMsg(line);
    if (m && m.type !== "init") yield m;
  }
}

let audio: AudioLink;
try {
  audio = new AudioLink({ allowedOrigins: parseAudioOrigins(init.audioAllowedOrigins), endpoints: init.audio, log: (message) => emit({ type: "log", level: "warn", message }) });
} catch (e) {
  // e.g. endpoints off the audio allowlist, or a malformed list: end cleanly, never crash.
  emit({ type: "log", level: "error", message: `audio link rejected: ${e instanceof Error ? e.message : String(e)}` });
  emit({ type: "ended", reason: "audio_lost" });
  process.exit(1);
}

try {
  await runVoiceLoop({
    init,
    makeProvider: () => createProvider({ provider: init.provider, model: init.model, apiKey }),
    audio,
    inbox: inbox(),
    emit,
  });
  process.exit(0);
} catch (e) {
  emit({ type: "log", level: "error", message: `voice-loop crashed: ${e instanceof Error ? e.message : String(e)}` });
  emit({ type: "ended", reason: "loop_crashed" });
  process.exit(1);
}
