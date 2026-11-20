/**
 * Private delivery for gateway-generated notices (not model text). A notice
 * meant for one person reaches that person as an ephemeral message, then as a
 * DM, and is dropped (logged and counted) when neither works. It is never
 * posted to the channel: the only public path is `publicFallback`, which runs
 * only while SLAUDE_PRIVATE_NOTICES is off (the rollback switch).
 *
 * Delivery is best effort. Slack accepts an ephemeral for a user who is not
 * looking at the channel, and drops it on a reload, so `sent` counts accepted
 * posts, not seen ones. A notice whose loss would strand the user (a link, a
 * credential prompt) is `sensitive` and goes by DM, which persists.
 */
import { env } from "../../config/env";
import { m as metric } from "../../metrics";

export type PrivateClass = "info" | "failure" | "sensitive";
export type PrivateResult = "ephemeral" | "dm" | "dropped" | "limited" | "disabled";

export interface PrivateNotice {
  cls: PrivateClass;
  /** What the notice is, for logs: "help", "one_on_one", "ignored", "oauth_link". */
  kind: string;
  userId: string;
  channel: string;
  thread?: string;
  text: string;
  blocks?: unknown[];
  /**
   * Set for an unsolicited notice only (the answer to something the user asked
   * is never limited). Spent after a successful delivery, not before.
   */
  limitKey?: string;
  /** Added to a DM so it has context. */
  permalink?: string;
  /** Runs only when the switch is off: the old public behavior, kept as a rollback. */
  publicFallback?: () => Promise<void>;
  /**
   * Called after a successful delivery with where it landed. A DM can be edited
   * later (for example to take a spent link out); an ephemeral cannot.
   */
  onDelivered?: (d: { path: "ephemeral" | "dm"; channel?: string; ts?: string }) => void;
}

export interface PrivateClient {
  chat: { postEphemeral(a: any): Promise<any>; postMessage(a: any): Promise<any> };
}

interface Deps {
  now?: () => number;
  windowMs?: () => number;
  enabled?: () => boolean;
}

const reason = (e: unknown): string => (e as any)?.data?.error ?? (e as Error)?.message ?? String(e);

export function makePrivateSender(deps: Deps = {}) {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? (() => 10 * 60_000);
  const enabled = deps.enabled ?? (() => env.privateNotices());
  // In-process, like the guardrail reply limiter: two replicas may each notify once.
  const until = new Map<string, number>();
  const cap = 5000;
  const quiet = (k: string): boolean => (until.get(k) ?? 0) > now();
  const spend = (k: string): void => {
    until.delete(k);
    until.set(k, now() + windowMs());
    if (until.size > cap) until.delete(until.keys().next().value as string);
  };

  async function send(client: PrivateClient, n: PrivateNotice): Promise<PrivateResult> {
    if (!enabled()) {
      await n.publicFallback?.();
      return "disabled";
    }
    if (n.limitKey && quiet(n.limitKey)) return "limited";
    const done = (path: "ephemeral" | "dm", res?: any): PrivateResult => {
      if (n.limitKey) spend(n.limitKey);
      metric.privateNoticeSentTotal.inc({ class: n.cls, path });
      try {
        n.onDelivered?.({ path, ...(typeof res?.channel === "string" ? { channel: res.channel } : {}), ...(typeof (res?.ts ?? res?.message_ts) === "string" ? { ts: res.ts ?? res.message_ts } : {}) });
      } catch { /* a callback must not undo a delivery */ }
      return path;
    };
    if (n.cls !== "sensitive") {
      try {
        const r = await client.chat.postEphemeral({ // runtime-ui: private notice delivery (ephemeral)
          channel: n.channel,
          user: n.userId,
          ...(n.thread ? { thread_ts: n.thread } : {}),
          text: n.text,
          ...(n.blocks ? { blocks: n.blocks } : {}),
        });
        return done("ephemeral", r);
      } catch (e) {
        console.error(`[private-notice] ephemeral failed kind=${n.kind} ch=${n.channel}: ${reason(e)}`);
      }
    }
    try {
      const text = n.permalink ? `${n.text}\n<${n.permalink}|Open the thread>` : n.text;
      const r = await client.chat.postMessage({ // runtime-ui: private notice delivery (DM to the user)
        channel: n.userId,
        text,
        ...(n.blocks ? { blocks: n.blocks } : {}),
      });
      return done("dm", r);
    } catch (e) {
      console.error(`[private-notice] dm failed kind=${n.kind}: ${reason(e)}`);
      metric.privateNoticeDroppedTotal.inc({ class: n.cls });
      return "dropped";
    }
  }

  return { send };
}

/** The process-wide sender the gateway uses. */
export const privateSender = makePrivateSender();
