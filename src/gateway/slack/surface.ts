import type { WebClient } from "@slack/web-api";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { deliver, formatOutbound, OutboundRefusal, type OutboundKind, type OutboundOptions } from "./outbound";
import { SLACK_SURFACE_ID } from "../core/surface";
import type {
  ApprovalRequest,
  ApprovalResult,
  HistoryItem,
  SessionBinding,
  Surface,
  SurfaceCapability,
  SurfaceFactory,
} from "../core/surface";

// Agent text goes through the outbound choke point (formatting, the soul's
// redaction, the owner's reply rules); the runtime's own text through a
// surface (runtime: true, sayEphemeral) gets the formatting only.

/** Surface implementation over the Slack Web API. Bound to one conversation/thread per
 *  session. The sim drives this exact class over a fake WebClient, so the agent sees an
 *  identical Surface in sim and prod. */
export class SlackSurface implements Surface {
  readonly id = SLACK_SURFACE_ID;
  readonly capabilities: ReadonlySet<SurfaceCapability> = new Set<SurfaceCapability>(["edit", "react", "upload", "ephemeral"]);

  #resolve: () => WebClient;
  #b: SessionBinding;
  #persona: string | undefined;

  /** `client` may be a resolver, read on every call: a named persona's surface
   *  then follows its CURRENT client, so a token rotated by a persona sync
   *  reaches surfaces (and the in-process surface MCP holding one) built
   *  before it. */
  constructor(client: WebClient | (() => WebClient), binding: SessionBinding, persona?: string) {
    this.#resolve = typeof client === "function" ? client : () => client;
    this.#b = binding;
    this.#persona = persona;
  }

  get #client(): WebClient {
    return this.#resolve();
  }

  #opts(kind: OutboundKind): OutboundOptions {
    const b = this.#b;
    return {
      kind,
      persona: this.#persona ?? null,
      channel: b.conversationId,
      thread: { channel: b.conversationId, threadTs: b.threadRef ?? null },
      ...(b.appId || b.teamId ? { app: { apiAppId: b.appId, teamId: b.teamId } } : {}),
      sessionId: b.sessionId ?? null,
      unattended: b.unattended === true,
    };
  }

  async #post(text: string): Promise<string> {
    const r = await this.#client.chat.postMessage({ channel: this.#b.conversationId, thread_ts: this.#b.threadRef, text, mrkdwn: true });
    return String(r.ts);
  }

  async #update(ref: string, text: string): Promise<void> {
    await this.#client.chat.update({ channel: this.#b.conversationId, ts: ref, text });
  }

  async reply({ text, runtime }: { text: string; runtime?: boolean }): Promise<{ ref: string; note?: string }> {
    if (runtime) return { ref: await this.#post(formatOutbound(text, "runtime", this.#persona)) };
    const r = await deliver(text, this.#opts("reply"), { post: (t) => this.#post(t), edit: (ref, t) => this.#update(ref, t) });
    if (!r.ok) throw new OutboundRefusal(r.error);
    return { ref: r.ref ?? "", ...(r.note ? { note: r.note } : {}) };
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

  /** Refuses rather than degrading: a silent fallback to chat.postMessage would
   *  broadcast an onboarding link to the whole channel. */
  async sayEphemeral(i: { text: string; userId?: string; blocks?: unknown[] }): Promise<void> {
    const user = i.userId ?? this.#b.userId;
    if (!user) throw new Error("sayEphemeral needs a user: refusing to post publicly");
    await this.#client.chat.postEphemeral({
      channel: this.#b.conversationId,
      user,
      text: formatOutbound(i.text, "runtime", this.#persona),
      ...(i.blocks ? { blocks: i.blocks } : {}),
      ...(this.#b.threadRef ? { thread_ts: this.#b.threadRef } : {}),
    });
  }

  /** An edit is judged on the whole new text (a streamed message re-checked in full at every edit). */
  async edit({ ref, text, runtime }: { ref: string; text: string; runtime?: boolean }): Promise<void | { note?: string }> {
    if (runtime) return this.#update(ref, formatOutbound(text, "runtime", this.#persona));
    const write = async (t: string) => {
      await this.#update(ref, t);
      return ref;
    };
    const r = await deliver(text, this.#opts("edit"), { post: write, edit: (_r, t) => this.#update(ref, t) });
    if (!r.ok) throw new OutboundRefusal(r.error);
    return r.note ? { note: r.note } : undefined;
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
    const send = async (caption: string | undefined) => {
      await this.#client.files.uploadV2({
        channel_id: this.#b.conversationId,
        thread_ts: this.#b.threadRef,
        file: createReadStream(path),
        filename,
        title: title ?? filename,
        ...(caption ? { initial_comment: caption } : {}),
        ...(altText ? { alt_text: altText } : {}),
      } as any);
      return undefined;
    };
    if (!comment) return void (await send(undefined));
    // No message to hold in place: a held caption waits for the card, then the file goes out with it.
    const r = await deliver(comment, this.#opts("upload_caption"), { post: send });
    if (!r.ok) throw new OutboundRefusal(r.error);
  }
}

/** Close over a Slack WebClient and return a factory that builds a SlackSurface per session, posting as `persona`. */
export function makeSlackSurfaceFactory(client: WebClient | (() => WebClient), persona?: string): SurfaceFactory {
  return (binding: SessionBinding) => new SlackSurface(client, binding, persona);
}
