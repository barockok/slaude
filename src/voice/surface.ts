// VoiceSurface — manages the bridge subprocess for one active call.
//
// Spawns: xvfb-run -a bun src/voice/bridge.ts <url> [--name <name>]
// Reads JSONL from bridge stdout and emits typed events.
// Writes JSONL commands to bridge stdin.
//
// Events:
//   "status"    ({state: string, code?: number})  — bridge lifecycle state
//   "delegate"  ({id: number, question: string})  — big-brain question needed
//   "error"     ({message: string})               — non-fatal bridge error
//   "closed"    ()                                — bridge exited

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export interface DelegateEvent {
  id: number;
  question: string;
}

export class VoiceSurface extends EventEmitter {
  private proc: ReturnType<typeof spawn> | null = null;
  private callUrl: string | null = null;

  get active(): boolean {
    return this.proc !== null;
  }

  get url(): string | null {
    return this.callUrl;
  }

  /** Spawn the bridge. Resolves once the process starts (not once in-call). */
  join(url: string, name = "Trevor"): void {
    if (this.proc) throw new Error("already in a call — leave first");
    this.callUrl = url;
    const bridgePath = resolve(import.meta.dir, "bridge.ts");
    const proc = spawn(
      "xvfb-run",
      ["-a", "bun", bridgePath, url, "--name", name],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.proc = proc;

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      switch (msg.ev) {
        case "status":
          this.emit("status", { state: msg.state, code: msg.code });
          break;
        case "delegate":
          this.emit("delegate", { id: msg.id, question: msg.question } as DelegateEvent);
          break;
        case "error":
          this.emit("error", { message: msg.message });
          break;
      }
    });

    proc.stderr!.on("data", () => {});

    proc.on("exit", () => {
      this.proc = null;
      this.callUrl = null;
      this.emit("closed");
    });
  }

  /** Send a delegate answer back to the bridge (which submits it to Realtime). */
  answer(id: number, text: string): void {
    this.write({ cmd: "say", id, text });
  }

  /** Instruct the bridge to hang up and exit. */
  leave(): void {
    this.write({ cmd: "leave" });
  }

  private write(obj: unknown): void {
    try {
      this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
    } catch {
      // ignore EPIPE if bridge already exited
    }
  }
}
