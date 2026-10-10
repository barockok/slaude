/** Spawn the `slaude voice-loop` child (voice mode spec §4). Secrets ride the
 *  child's env only — never argv or stdin — and the env is otherwise minimal so
 *  nothing else leaks in. `--no-env-file` stops Bun auto-loading a `.env` from
 *  the working directory into the child. */
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { CapabilityRedactor } from "./audio-link";
import { ENV_API_KEY, encodeMsg, parseChildMsg, readLines, type ChildMsg, type ParentMsg } from "./ipc";

const ENTRY = fileURLToPath(new URL("./loop-entry.ts", import.meta.url));

export interface LoopChild {
  send(m: ParentMsg): void;
  messages: AsyncIterable<ChildMsg>;
  exited: Promise<number>;
  kill(): void;
}

export interface SpawnSecrets {
  apiKey: string;
}

/** Non-secret variables the child may need to reach the provider through a
 *  proxy or a private CA; passed through only when set. */
const PASSTHROUGH = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
] as const;

export function childEnv(o: SpawnSecrets, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: from.PATH ?? "", HOME: from.HOME ?? "" };
  for (const k of PASSTHROUGH) if (from[k] !== undefined) env[k] = from[k]!;
  env[ENV_API_KEY] = o.apiKey;
  return env;
}

/** Longest child stderr line passed on; longer lines are cut. */
export const STDERR_LINE_MAX = 64 * 1024;
const TRUNCATED = "…(truncated)";

/** Lines of `stream` (trailing "\r" dropped, indentation kept), each at most
 *  `max` characters. An over-long line is flushed cut back to its last
 *  whitespace (so no partial token, which the exact-match scrubber could not
 *  recognise, is passed on) plus a marker, and the rest of it is dropped. */
export async function* boundedLines(stream: ReadableStream<Uint8Array>, max = STDERR_LINE_MAX): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  let dropping = false;
  const cut = (s: string) => {
    const i = Math.max(s.lastIndexOf(" "), s.lastIndexOf("\t"));
    return (i > 0 ? s.slice(0, i + 1) : "") + TRUNCATED;
  };
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (dropping) { dropping = false; continue; }
      if (line.length > max) { yield cut(line.slice(0, max)); continue; }
      if (line) yield line;
    }
    if (!dropping && buf.length > max) {
      yield cut(buf.slice(0, max));
      buf = "";
      dropping = true;
    } else if (dropping) {
      buf = "";
    }
  }
  const tail = buf + dec.decode();
  if (tail && !dropping) yield tail.length > max ? cut(tail.slice(0, max)) : tail;
}

/** `entry` replaces the child script (tests use a stand-in). */
export function spawnVoiceLoop(o: SpawnSecrets & { execPath?: string; entry?: string }): LoopChild {
  // stderr is piped, not inherited: whatever the child or Bun writes there
  // passes the same capability-URL scrubber as its log lines.
  const cp = spawn(o.execPath ?? process.execPath, ["--no-env-file", o.entry ?? ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(o),
  });
  // Set when init is sent: the child only learns the capability URLs from it.
  let scrub = (s: string) => s;
  if (cp.stderr) {
    const stderr = Readable.toWeb(cp.stderr) as unknown as ReadableStream<Uint8Array>;
    void (async () => {
      try {
        for await (const line of boundedLines(stderr)) process.stderr.write(`${scrub(line)}\n`);
      } catch {
        // stream destroyed (spawn error / kill)
      }
    })();
  }
  let dead = false;
  const exited = new Promise<number>((r) => {
    cp.on("exit", (code) => {
      dead = true;
      r(code ?? 1);
    });
    // Spawn failure (bad execPath, EAGAIN, EMFILE...): 'exit' may never fire,
    // and an unhandled 'error' would crash the host process.
    cp.on("error", (e) => {
      dead = true;
      console.error(`[voice] voice-loop child error: ${e.message}`);
      cp.stdout?.destroy();
      r(1);
    });
  });
  // A write after the child died raises EPIPE on the stream; the exit path ends the call.
  cp.stdin?.on("error", () => {});
  return {
    send: (m) => {
      if (m.type === "init") {
        const r = new CapabilityRedactor(m.init.audio);
        scrub = (s) => r.redact(s);
      }
      if (!dead && cp.stdin && !cp.stdin.destroyed && cp.stdin.writable) cp.stdin.write(encodeMsg(m));
    },
    messages: (async function* () {
      if (!cp.stdout) return;
      const stdout = Readable.toWeb(cp.stdout) as unknown as ReadableStream<Uint8Array>;
      try {
        for await (const line of readLines(stdout)) {
          const m = parseChildMsg(line);
          if (m) yield m.type === "log" ? { ...m, message: scrub(m.message) } : m;
        }
      } catch {
        // stream destroyed (spawn error / kill): the iterator just ends
      }
    })(),
    exited,
    kill: () => {
      if (dead) return;
      try {
        cp.kill("SIGKILL");
      } catch {}
    },
  };
}
