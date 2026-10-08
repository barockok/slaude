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

let audio: AudioLink;
try {
  audio = new AudioLink({ baseUrl: init.workbenchUrl, endpoints: init.audio, streamToken });
} catch (e) {
  // e.g. endpoints not same-origin as the workbench: end cleanly, never crash.
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
