import type { Transport, WebClientLike } from "../core/transport";
import { loadApprovers, selectApprovers, selectApproversFrom } from "../../soul/loader";
import { effectiveSoulForChannel } from "../../soul/extract";
import * as PendingGates from "../../db/pending-gates";
import { randomBytes } from "node:crypto";

export type ApprovalRequest = {
  channel: string;
  threadTs: string;
  summary: string;
  /** Session the plan belongs to, when known. Falls back to the thread key —
   *  pending_gates.session_id is NOT NULL and some approvals (slash-command
   *  authz) run before any session exists. */
  sessionId?: string;
  tools?: string[];
  files?: string[];
  risks?: string;
  /** Optional category — kept for backward compat with the old "category:
   *  ids" SOUL format. Modern persona uses scope-described approvers, where
   *  the runtime keyword-matches the summary against each approver's scope. */
  category?: string;
};

export type ApprovalDecision = {
  approved: boolean;
  by: string;
  note?: string;
};

/**
 * Agent-initiated approval gate. The agent calls
 * `mcp__slaude_slack__request_approval` with a plan summary; we post a Block
 * Kit message with Approve / Deny buttons and resolve when the user clicks.
 *
 * Distinct from PermissionGate (per-tool, SDK-driven). This one is per-task,
 * agent-driven — typical use: agent runs in YOLO/bypass mode but soul forces
 * a high-level approval checkpoint before destructive batches.
 *
 * Durable state: each request writes a pending_gates row (kind 'approval');
 * clicks and the auto-deny timer settle it through the repo's
 * status='pending' guarded UPDATE, so exactly one outcome wins even across
 * replicas. The in-process #pending map stays as the promise wakeup until
 * the long-poll plane lands (spec M4).
 */
type Pending = {
  resolve: (d: ApprovalDecision) => void;
  approvers: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  channel: string;
  ts?: string;
};

export class ApprovalGate {
  #client: WebClientLike;
  #pending = new Map<string, Pending>();
  #counter = 0;
  /** Env-derived fallback allowlist. Used when persona has no approvers block
   *  or no matching category and no 'default' key either. */
  #envApprovers: Set<string>;
  /** Source for the per-request timeout. Injected so tests can override. */
  #timeoutSeconds: () => number;

  constructor(
    transport: Transport,
    envApprovers: string[],
    opts: { timeoutSeconds?: () => number } = {},
  ) {
    this.#client = transport.client;
    this.#envApprovers = new Set(envApprovers);
    this.#timeoutSeconds = opts.timeoutSeconds ?? (() => 0);
    transport.action(
      /^slaude_appr:(approve|deny):.+$/,
      async ({ ack, action, body, respond }) => {
        await ack();
        const a = action as { action_id: string };
        const m = a.action_id.match(/^slaude_appr:(approve|deny):(.+)$/);
        if (!m) return;
        const verb = m[1] as "approve" | "deny";
        const approved = verb === "approve";
        const id = m[2]!;
        const pending = this.#pending.get(id);
        const userId = (body as any).user?.id ?? "unknown";
        const stale = async () => {
          try {
            await respond({
              replace_original: true,
              text: `:lock: approval already decided`,
              blocks: [],
            });
          } catch {}
        };
        // Durable row is the source of truth for "still open?".
        const row = await PendingGates.get(id);
        if (!row || row.status !== "pending") return void (await stale());
        if (!pending) {
          // Open row but no local waiter: the process restarted and the
          // promise died with it. Settle the orphan so it doesn't linger;
          // nothing is listening, so keep the already-decided UX.
          await PendingGates.resolve(id, "cancelled", userId);
          return void (await stale());
        }

        // Authorize the clicker against this request's allowlist — BEFORE the
        // guarded resolve, so a non-approver click never consumes the row.
        const approvers = new Set<string>(
          (row.payload.approvers as string[] | undefined) ?? [...pending.approvers],
        );
        if (approvers.size > 0 && !approvers.has(userId)) {
          try {
            await respond({
              response_type: "ephemeral",
              replace_original: false,
              text: `:no_entry: <@${userId}>, you are not on the approver allowlist for this plan. The plan stays pending.`,
            });
          } catch {}
          return; // do NOT consume the pending entry
        }

        // Exactly one click wins the guarded UPDATE; a duplicate or a race
        // against the auto-deny timer sees null and is stale.
        const resolved = await PendingGates.resolve(id, approved ? "approved" : "denied", userId);
        if (!resolved) return void (await stale());

        if (pending.timer) clearTimeout(pending.timer);
        this.#pending.delete(id);
        const label = approved ? "*Approved*" : "*Denied*";
        try {
          await respond({
            replace_original: true,
            text: `Plan → ${label} by <@${userId}>`,
            blocks: [],
          });
        } catch {}
        pending.resolve({ approved, by: userId });
      },
    );
  }

  /** Resolve who may approve. Order:
   *   1. LLM-extracted SoulData approvers (preferred when available).
   *   2. Scope-described persona via regex parser.
   *   3. Legacy "category: ids" persona: persona[category] → persona.default.
   *   4. env SLAUDE_APPROVERS.
   *   5. Empty (anyone may click). */
  #resolveApprovers(req: ApprovalRequest): Set<string> {
    const structured = effectiveSoulForChannel(req.channel).approvers;
    if (structured.length) {
      const ids = selectApproversFrom(structured, req.summary, req.category);
      if (ids.length) return new Set(ids);
    }

    const scoped = selectApprovers(req.summary, req.category);
    if (scoped.length) return new Set(scoped);

    const legacy = loadApprovers();
    if (legacy) {
      if (req.category && legacy[req.category.toLowerCase()]?.length) {
        return new Set(legacy[req.category.toLowerCase()]);
      }
      if (legacy.default?.length) {
        return new Set(legacy.default);
      }
    }
    return new Set(this.#envApprovers);
  }

  async request(req: ApprovalRequest, abortSignal?: AbortSignal): Promise<ApprovalDecision> {
    // Globally unique — the id is now a pending_gates PRIMARY KEY, and several
    // gate instances (tests, future replicas) may mint in the same millisecond.
    const id = `${Date.now().toString(36)}_${(++this.#counter).toString(36)}_${randomBytes(4).toString("hex")}`;
    const approvers = this.#resolveApprovers(req);
    const heading = req.category
      ? `:bell: *Approval needed* — \`${req.category}\``
      : `:bell: *Approval needed*`;
    const sections: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: heading },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: req.summary || "_(no summary)_" },
      },
    ];
    if (req.tools && req.tools.length) {
      sections.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*Tools:* ${req.tools.map((t) => "`" + t + "`").join(", ")}` },
        ],
      });
    }
    if (req.files && req.files.length) {
      sections.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*Files:* ${req.files.map((f) => "`" + f + "`").join(", ")}` },
        ],
      });
    }
    if (req.risks) {
      sections.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `:warning: ${req.risks}` }],
      });
    }
    if (approvers.size > 0) {
      const list = Array.from(approvers)
        .map((u) => `<@${u}>`)
        .join(" ");
      sections.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `Approver(s): ${list}` }],
      });
    }
    const actionElements = [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: `slaude_appr:approve:${id}` },
      { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: `slaude_appr:deny:${id}` },
    ];
    sections.push({ type: "actions", elements: actionElements });

    const timeoutSec = this.#timeoutSeconds();

    // Durable pending state FIRST, then the in-process waiter, then the
    // buttons — by the time a click can exist, both stores are in place.
    await PendingGates.create({
      id,
      kind: "approval",
      sessionId: req.sessionId ?? `${req.channel}:${req.threadTs}`,
      payload: {
        channel: req.channel,
        threadTs: req.threadTs,
        summary: req.summary,
        category: req.category ?? null,
        approvers: [...approvers],
      },
      expiresAt: timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : undefined,
    });

    let resolveFn!: (d: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((resolve) => {
      resolveFn = resolve;
    });
    const pending: Pending = {
      resolve: resolveFn,
      approvers,
      channel: req.channel,
    };
    if (timeoutSec > 0) {
      pending.timer = setTimeout(() => {
        void (async () => {
          const p = this.#pending.get(id);
          if (!p) return;
          // Settle the durable row; a click that raced us wins the guard and
          // its handler owns the outcome. A recurring sweep may have expired
          // the row already — that outcome is still ours to deliver locally.
          const row = await PendingGates.resolve(id, "expired", "system");
          if (!row) {
            const cur = await PendingGates.get(id);
            if (cur && cur.status !== "expired") return; // a click won
          }
          this.#pending.delete(id);
          // Best-effort UI update so the block doesn't look pending forever.
          if (p.ts) {
            void this.#client.chat
              .update({
                channel: p.channel,
                ts: p.ts,
                text: `:hourglass: Auto-denied after ${timeoutSec}s — no approver clicked.`,
                blocks: [],
              })
              .catch(() => {});
          }
          p.resolve({ approved: false, by: "system", note: `timeout-${timeoutSec}s` });
        })();
      }, timeoutSec * 1000);
    }
    this.#pending.set(id, pending);
    abortSignal?.addEventListener(
      "abort",
      () => {
        const p = this.#pending.get(id);
        if (!p) return;
        if (p.timer) clearTimeout(p.timer);
        this.#pending.delete(id);
        void PendingGates.resolve(id, "cancelled", "system").catch(() => {});
        p.resolve({ approved: false, by: "system", note: "aborted" });
      },
      { once: true },
    );

    try {
      const posted = await this.#client.chat.postMessage({
        channel: req.channel,
        thread_ts: req.threadTs,
        text: `:bell: Approval needed: ${truncate(req.summary, 80)}`,
        blocks: sections,
      });
      pending.ts = posted.ts as string | undefined;
    } catch (e) {
      // The prompt never reached Slack — tear both stores down and rethrow.
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(id);
      void PendingGates.resolve(id, "cancelled", "system").catch(() => {});
      throw e;
    }

    if (timeoutSec > 0) {
      sections.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `:hourglass: Auto-denies in *${timeoutSec}s* if no one clicks.` }],
      });
    }
    return promise;
  }
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
