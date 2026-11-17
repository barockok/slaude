import type { WebClient } from "@slack/web-api";
import { basename } from "node:path";
import { openConfined, UploadTooLarge } from "../core/confined-file";
import { env } from "../../config/env";
import { checkUploadUrl } from "../upload/url";
import { deliver, formatOutbound, outbound, OutboundRefusal, TRACKER_HIDDEN, type OutboundKind, type OutboundOptions } from "./outbound";
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
      ...(b.replyTo && !b.unattended ? { replyTo: b.replyTo } : {}),
      unattended: b.unattended === true,
      ...(b.turnSignal ? { signal: b.turnSignal } : {}),
      ...(b.turnDeadline !== undefined ? { deadline: b.turnDeadline } : {}),
    };
  }

  async #post(text: string): Promise<string> {
    const r = await this.#client.chat.postMessage({ channel: this.#b.conversationId, thread_ts: this.#b.threadRef, text, mrkdwn: true }); // outbound: surface reply, edit and upload caption through deliver(); runtime and tracker text through outbound() too
    return String(r.ts);
  }

  async #update(ref: string, text: string): Promise<void> {
    await this.#client.chat.update({ channel: this.#b.conversationId, ts: ref, text }); // outbound: surface reply, edit and upload caption through deliver(); runtime and tracker text through outbound() too
  }

  /** A todo or task list: model-written items through the reply rules; nobody holds it, so a deny or approve hides it. */
  async #tracker(text: string): Promise<string> {
    const v = await outbound(text, { ...this.#opts("todo"), unattended: true });
    return v.action === "send" ? v.text : formatOutbound(TRACKER_HIDDEN, "runtime", this.#persona);
  }

  async reply({ text, runtime, tracker }: { text: string; runtime?: boolean; tracker?: boolean }): Promise<{ ref: string; note?: string }> {
    if (tracker) return { ref: await this.#post(await this.#tracker(text)) };
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
    await this.#client.chat.postEphemeral({ // runtime-ui: sayEphemeral (the runtime's own private notices), formatted only
      channel: this.#b.conversationId,
      user,
      text: formatOutbound(i.text, "runtime", this.#persona),
      ...(i.blocks ? { blocks: i.blocks } : {}),
      ...(this.#b.threadRef ? { thread_ts: this.#b.threadRef } : {}),
    });
  }

  /** An edit is judged on the whole new text (a streamed message re-checked in full at every edit). */
  async edit({ ref, text, runtime, tracker }: { ref: string; text: string; runtime?: boolean; tracker?: boolean }): Promise<void | { note?: string }> {
    if (tracker) return this.#update(ref, await this.#tracker(text));
    if (runtime) return this.#update(ref, formatOutbound(text, "runtime", this.#persona));
    const write = async (t: string) => {
      await this.#update(ref, t);
      return ref;
    };
    const r = await deliver(text, { ...this.#opts("edit"), ref }, { post: write, edit: (_r, t) => this.#update(ref, t) });
    if (!r.ok) throw new OutboundRefusal(r.error);
    return r.note ? { note: r.note } : undefined;
  }

  async react({ name, ref }: { name: string; ref?: string }): Promise<void> {
    // A turn with no triggering message (a console turn at root) has nothing to react to.
    const timestamp = ref ?? this.#b.inboundRef;
    if (!timestamp) return;
    try {
      await this.#client.reactions.add({ channel: this.#b.conversationId, timestamp, name });
    } catch (e: any) {
      const msg = e?.data?.error ?? e?.message ?? String(e);
      if (msg === "already_reacted") return; // idempotent — treat as success
      throw e;
    }
  }

  async unreact({ name, ref }: { name: string; ref?: string }): Promise<void> {
    const timestamp = ref ?? this.#b.inboundRef;
    if (!timestamp) return;
    await this.#client.reactions.remove({ channel: this.#b.conversationId, timestamp, name });
  }

  /** Direct upload, first call. The persona's client asks Slack for a presigned URL; nothing is posted. */
  async uploadBegin({ filename, size, altText }: { filename: string; size: number; altText?: string }): Promise<{ uploadUrl: string; fileId: string }> {
    const r = await this.#client.files.getUploadURLExternal({ // outbound: upload begin sends a file name and size only, no message text; the caption is judged at upload complete through deliver()
      filename,
      length: size,
      ...(altText ? { alt_text: altText } : {}),
    });
    if (!r.ok || !r.upload_url || !r.file_id) throw new Error("Slack returned no upload URL");
    // The node sends the bytes wherever this says: only Slack's own upload host will do.
    if (!checkUploadUrl(r.upload_url)) throw new Error("Slack returned an upload URL on an unexpected host");
    return { uploadUrl: r.upload_url, fileId: r.file_id };
  }

  /**
   * Direct upload, last call. The channel and thread are this surface's binding;
   * the gateway builds that from the begin handle, never from the node. The caption
   * is judged here exactly as the co-located upload judges it (held for approval,
   * redacted or refused by the owner's reply rules). Title, file name and alt text
   * are not run through the rules, as in the co-located path.
   */
  async uploadComplete({ fileId, filename, title, comment }: { fileId: string; filename: string; title?: string; comment?: string }): Promise<void> {
    const send = async (caption: string | undefined) => {
      await this.#client.files.completeUploadExternal({ // outbound: surface reply, edit and upload caption through deliver(); runtime and tracker text through outbound() too
        files: [{ id: fileId, title: title ?? filename }],
        channel_id: this.#b.conversationId,
        ...(this.#b.threadRef ? { thread_ts: this.#b.threadRef } : {}),
        ...(caption ? { initial_comment: caption } : {}),
      });
      return undefined;
    };
    if (!comment) return void (await send(undefined));
    const r = await deliver(comment, this.#opts("upload_caption"), { post: send });
    if (!r.ok) throw new OutboundRefusal(r.error);
  }

  async upload({ path, title, comment, altText }: { path: string; title?: string; comment?: string; altText?: string }): Promise<void> {
    // Confined to the session's working directory: the descriptor checked here is the one streamed.
    let workingDir: string | undefined;
    try { workingDir = await this.#b.workingDir?.(); } catch { workingDir = undefined; }
    const file = openConfined(path, workingDir);
    // uploadV2 reads the whole stream into memory: a lower cap than the direct path's.
    const max = env.uploadColocatedMaxBytes();
    if (file.size > max) {
      file.stream.destroy();
      throw new UploadTooLarge(path, file.size, max);
    }
    const filename = basename(path);
    let used = false;
    const send = async (caption: string | undefined) => {
      used = true;
      await this.#client.files.uploadV2({ // outbound: surface reply, edit and upload caption through deliver(); runtime and tracker text through outbound() too
        channel_id: this.#b.conversationId,
        thread_ts: this.#b.threadRef,
        file: file.stream,
        filename,
        title: title ?? filename,
        ...(caption ? { initial_comment: caption } : {}),
        ...(altText ? { alt_text: altText } : {}),
      } as any);
      return undefined;
    };
    try {
      if (!comment) return void (await send(undefined));
      // No message to hold in place: a held caption waits for the card, then the file goes out with it.
      const r = await deliver(comment, this.#opts("upload_caption"), { post: send });
      if (!r.ok) throw new OutboundRefusal(r.error);
    } finally {
      // A refused or failed caption never read the stream: release the descriptor.
      if (!used) file.stream.destroy();
    }
  }
}

/** Close over a Slack WebClient and return a factory that builds a SlackSurface per session, posting as `persona`. */
export function makeSlackSurfaceFactory(client: WebClient | (() => WebClient), persona?: string): SurfaceFactory {
  return (binding: SessionBinding) => new SlackSurface(client, binding, persona);
}
