import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../config/home";
import { env } from "../config/env";
import { soulSystemBlock } from "../soul/loader";
import * as Sessions from "../db/sessions";
import type { ThreadKey } from "../db/sessions";

type LiveSession = {
  id: string;
  pushUser: (text: string) => void;
  closeIterable: () => void;
  abort: AbortController;
};

export type AgentEvent =
  | { type: "assistantText"; sessionId: string; text: string }
  | { type: "toolCall"; sessionId: string; tool: string; input: unknown }
  | { type: "toolResult"; sessionId: string; tool: string; result: unknown }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "done"; sessionId: string }
  | { type: "error"; sessionId: string; error: string };

export class AgentManager extends EventEmitter {
  #live = new Map<string, LiveSession>();

  /** Get-or-create a session bound to a Slack thread. */
  ensureSession(thread: ThreadKey, opts: { title?: string } = {}) {
    let row = Sessions.findByThread(thread);
    if (!row) {
      const workingDir = join(paths.workspaces, `${thread.team_id}-${thread.channel_id}-${thread.thread_ts}`);
      mkdirSync(workingDir, { recursive: true });
      row = Sessions.createForThread({
        thread,
        model: env.model(),
        working_dir: workingDir,
        title: opts.title,
      });
    }
    return row;
  }

  /** Send user input. Starts session loop if not already live. */
  async sendMessage(sessionId: string, text: string) {
    const live = this.#live.get(sessionId);
    if (live) {
      live.pushUser(text);
      return;
    }
    await this.#startSession(sessionId, text);
  }

  /** Cancel any in-flight turn for the session. */
  abort(sessionId: string) {
    this.#live.get(sessionId)?.abort.abort();
  }

  async #startSession(sessionId: string, firstText: string) {
    const row = Sessions.findById(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);

    const abort = new AbortController();
    const queue: string[] = [firstText];
    let resolveNext: (() => void) | null = null;
    let closed = false;

    const pushUser = (text: string) => {
      queue.push(text);
      resolveNext?.();
      resolveNext = null;
    };

    const closeIterable = () => {
      closed = true;
      resolveNext?.();
      resolveNext = null;
    };

    const promptIterable = (async function* () {
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((r) => (resolveNext = r));
          continue;
        }
        const text = queue.shift()!;
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: text },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }
    })();

    const options: Options = {
      cwd: row.working_dir,
      model: row.model,
      abortController: abort,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: soulSystemBlock(),
      },
      ...(row.claude_started ? { resume: row.id } : {}),
    };

    this.#live.set(sessionId, { id: sessionId, pushUser, closeIterable, abort });
    Sessions.setStatus(sessionId, "running");

    (async () => {
      try {
        const q = query({ prompt: promptIterable, options });
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          this.#fanout(sessionId, msg);
        }
        this.emit("event", { type: "done", sessionId } satisfies AgentEvent);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit("event", { type: "error", sessionId, error: message } satisfies AgentEvent);
      } finally {
        Sessions.setStatus(sessionId, "idle");
        this.#live.delete(sessionId);
      }
    })();
  }

  #fanout(sessionId: string, msg: SDKMessage) {
    switch (msg.type) {
      case "assistant": {
        Sessions.markStarted(sessionId);
        for (const block of msg.message.content) {
          if (block.type === "text") {
            this.emit("event", {
              type: "assistantText",
              sessionId,
              text: block.text,
            } satisfies AgentEvent);
          } else if (block.type === "thinking") {
            this.emit("event", {
              type: "thinking",
              sessionId,
              text: block.thinking,
            } satisfies AgentEvent);
          } else if (block.type === "tool_use") {
            this.emit("event", {
              type: "toolCall",
              sessionId,
              tool: block.name,
              input: block.input,
            } satisfies AgentEvent);
          }
        }
        break;
      }
      case "user": {
        if (msg.tool_use_result !== undefined) {
          this.emit("event", {
            type: "toolResult",
            sessionId,
            tool: "",
            result: msg.tool_use_result,
          } satisfies AgentEvent);
        }
        break;
      }
      default:
        break;
    }
  }
}
