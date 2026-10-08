/** Spawn the `slaude voice-loop` child (voice mode spec §4). Secrets ride the
 *  child's env only — never argv or stdin — and the env is otherwise minimal so
 *  nothing else leaks in. `--no-env-file` stops Bun auto-loading a `.env` from
 *  the working directory into the child. */
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

export interface SpawnSecrets {
  apiKey: string;
  streamToken: string;
}

export function childEnv(o: SpawnSecrets): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [ENV_API_KEY]: o.apiKey, [ENV_STREAM_TOKEN]: o.streamToken };
}

export function spawnVoiceLoop(o: SpawnSecrets & { execPath?: string }): LoopChild {
  const cp = spawn(o.execPath ?? process.execPath, ["--no-env-file", ENTRY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv(o),
  });
  const exited = new Promise<number>((r) => cp.on("exit", (code) => r(code ?? 1)));
  // A write after the child died raises EPIPE on the stream; the exit path ends the call.
  cp.stdin!.on("error", () => {});
  const stdout = Readable.toWeb(cp.stdout!) as unknown as ReadableStream<Uint8Array>;
  return {
    send: (m) => {
      if (!cp.stdin!.destroyed && cp.stdin!.writable) cp.stdin!.write(encodeMsg(m));
    },
    messages: (async function* () {
      for await (const line of readLines(stdout)) {
        const m = parseChildMsg(line);
        if (m) yield m;
      }
    })(),
    exited,
    kill: () => {
      try {
        cp.kill("SIGKILL");
      } catch {}
    },
  };
}
