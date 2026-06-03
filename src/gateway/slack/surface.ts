import type { WebClient } from "@slack/web-api";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { mdToMrkdwn } from "./format";
import { redactSlack } from "./redact";
import { soulData } from "../../soul/extract";
import type {
  ApprovalRequest,
  ApprovalResult,
  HistoryItem,
  SessionBinding,
  Surface,
  SurfaceCapability,
  SurfaceFactory,
} from "../core/surface";

// Same outbound formatting the legacy slack tools used — markdown → mrkdwn + soul redaction.
function format(text: string): string {
  return redactSlack(mdToMrkdwn(text), soulData().redactPatterns);
}

/** Surface implementation over the Slack Web API. Bound to one conversation/thread per
 *  session. The sim drives this exact class over a fake WebClient, so the agent sees an
 *  identical Surface in sim and prod. */
export class SlackSurface implements Surface {
  readonly id = "slack";
  readonly capabilities: ReadonlySet<SurfaceCapability> = new Set<SurfaceCapability>(["edit", "react", "upload"]);

  #client: WebClient;
  #b: SessionBinding;

  constructor(client: WebClient, binding: SessionBinding) {
    this.#client = client;
    this.#b = binding;
  }

  async reply({ text }: { text: string }): Promise<{ ref: string }> {
    const r = await this.#client.chat.postMessage({
      channel: this.#b.conversationId,
      thread_ts: this.#b.threadRef,
      text: format(text),
      mrkdwn: true,
    });
    return { ref: String(r.ts) };
  }

  async getHistory({ limit, includeReplies }: { limit?: number; includeReplies?: boolean }): Promise<{ messages: HistoryItem[]; hasMore: boolean }> {
    const r = await this.#client.conversations.replies({
      channel: this.#b.conversationId,
      ts: this.#b.threadRef ?? this.#b.inboundRef,
      limit: limit ?? 20,
    });
    const messages: HistoryItem[] = ((r.messages ?? []) as any[]).map((m) => ({
      author: m.user,
      text: m.text,
      ref: m.ts,
      threadRef: m.thread_ts,
      replyCount: m.reply_count,
      ...(includeReplies !== false && m.replies
        ? { replies: m.replies.map((rep: any) => ({ ts: rep.ts, user: rep.user })) }
        : {}),
    }));
    return { messages, hasMore: Boolean(r.has_more) };
  }

  requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    return this.#b.requestApproval(req);
  }

  async edit({ ref, text }: { ref: string; text: string }): Promise<void> {
    await this.#client.chat.update({ channel: this.#b.conversationId, ts: ref, text: format(text) });
  }

  async react({ name, ref }: { name: string; ref?: string }): Promise<void> {
    try {
      await this.#client.reactions.add({ channel: this.#b.conversationId, timestamp: ref ?? this.#b.inboundRef, name });
    } catch (e: any) {
      const msg = e?.data?.error ?? e?.message ?? String(e);
      if (msg === "already_reacted") return; // idempotent — treat as success
      throw e;
    }
  }

  async unreact({ name, ref }: { name: string; ref?: string }): Promise<void> {
    await this.#client.reactions.remove({ channel: this.#b.conversationId, timestamp: ref ?? this.#b.inboundRef, name });
  }

  async upload({ path, title, comment, altText }: { path: string; title?: string; comment?: string; altText?: string }): Promise<void> {
    statSync(path); // throws if missing
    const filename = basename(path);
    await this.#client.files.uploadV2({
      channel_id: this.#b.conversationId,
      thread_ts: this.#b.threadRef,
      file: createReadStream(path),
      filename,
      title: title ?? filename,
      ...(comment ? { initial_comment: format(comment) } : {}),
      ...(altText ? { alt_text: altText } : {}),
    } as any);
  }
}

/** Close over a Slack WebClient and return a factory that builds a SlackSurface per session. */
export function makeSlackSurfaceFactory(client: WebClient): SurfaceFactory {
  return (binding: SessionBinding) => new SlackSurface(client, binding);
}
