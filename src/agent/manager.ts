import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../config/home";
import { env } from "../config/env";
import { soulSystemBlock } from "../soul/loader";
import * as Sessions from "../db/sessions";
import type { ThreadKey } from "../db/sessions";
import { memory } from "../memory/sqlite-provider";

type LiveSession = {
  id: string;
  pushUser: (text: string) => void;
  closeIterable: () => void;
  abort: AbortController;
  /** Buffer of last user message + accumulated assistant text for memory.syncTurn. */
  turn: { user: string; assistant: string[] };
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
      // flush prior turn if any pending assistant content was buffered
      this.#flushTurn(live);
      live.turn.user = text;
      live.turn.assistant = [];
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

    const memBlock = await memory.prefetch(sessionId);
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

    // Pass through Anthropic-compatible provider env so any compatible API works.
    const providerEnv: Record<string, string | undefined> = {};
    for (const k of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      if (process.env[k]) providerEnv[k] = process.env[k];
    }

    const options: Options = {
      cwd: row.working_dir,
      model: row.model,
      abortController: abort,
      env: { ...process.env, ...providerEnv },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          soulSystemBlock(),
          memBlock ? `<memory-context>\n${memBlock}\n</memory-context>` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...(row.claude_started ? { resume: row.id } : {}),
    };

    const live: LiveSession = {
      id: sessionId,
      pushUser,
      closeIterable,
      abort,
      turn: { user: firstText, assistant: [] },
    };
    this.#live.set(sessionId, live);
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
    const live = this.#live.get(sessionId);
    switch (msg.type) {
      case "assistant": {
        Sessions.markStarted(sessionId);
        for (const block of msg.message.content) {
          if (block.type === "text") {
            live?.turn.assistant.push(block.text);
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
      case "result": {
        // End of one user→assistant turn. Persist memory.
        if (live) this.#flushTurn(live);
        break;
      }
      default:
        break;
    }
  }

  #flushTurn(live: LiveSession) {
    if (!live.turn.user || live.turn.assistant.length === 0) return;
    const user = live.turn.user;
    const assistant = live.turn.assistant.join("\n");
    live.turn = { user: "", assistant: [] };
    void memory.syncTurn({ sessionId: live.id, user, assistant });
  }
}
