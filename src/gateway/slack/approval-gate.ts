import type { Transport, WebClientLike } from "../core/transport";
import { loadApprovers, selectApprovers, selectApproversFrom } from "../../soul/loader";
import { effectiveSoulForChannel } from "../../soul/extract";
import * as PendingGates from "../../db/pending-gates";
import { defaultGateBus, type GateBus } from "../../queue/gate-bus";
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

/** Map a settled pending_gates approval row to a decision. Used by the
 *  gate-bus waiter wakeup here and by the node's long-poll mapping. */
export function decisionFromApprovalRow(row: {
  status: string;
  resolvedBy: string | null;
}): ApprovalDecision {
  if (row.status === "approved") return { approved: true, by: row.resolvedBy ?? "unknown" };
  if (row.status === "denied") return { approved: false, by: row.resolvedBy ?? "unknown" };
  return { approved: false, by: "system", note: row.status };
}

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
 * replicas.
 *
 * Wakeups (spec §5): winning settles publish `gate:<id>` on the gate bus
 * (when Redis is configured) so sibling replicas' in-process waiters and node
 * long-polls wake instantly. `open()` mints poll-waiter rows for the REST
 * plane — no in-process promise anywhere; ANY replica's click settles them.
 * Without a bus, foreign in-process rows keep the conservative "pending on
 * another replica" answer, exactly as before.
 */
type Pending = {
  resolve: (d: ApprovalDecision) => void;
  approvers: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  channel: string;
  ts?: string;
  /** gate-bus unsubscribe, when a bus is configured. */
  unsub?: () => Promise<void>;
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
  /** Explicit bus override (tests/sim); undefined = env-driven default. */
  #busOverride: GateBus | null | undefined;

  constructor(
    transport: Transport,
    envApprovers: string[],
    opts: { timeoutSeconds?: () => number; gateBus?: GateBus | null } = {},
  ) {
    this.#client = transport.client;
    this.#envApprovers = new Set(envApprovers);
    this.#timeoutSeconds = opts.timeoutSeconds ?? (() => 0);
    this.#busOverride = opts.gateBus;
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
        const notAllowed = async () => {
          try {
            await respond({
              response_type: "ephemeral",
              replace_original: false,
              text: `:no_entry: <@${userId}>, you are not on the approver allowlist for this plan. The plan stays pending.`,
            });
          } catch {}
        };
        // Durable row is the source of truth for "still open?".
        const row = await PendingGates.get(id);
        if (!row || row.status !== "pending") {
          // A sweep expired (or something cancelled/purged) the row while our
          // waiter is still parked on it — deliver the deny locally so the
          // agent never hangs. approved/denied rows are a click's outcome and
          // its handler already delivered.
          if (
            pending &&
            (!row || row.status === "expired" || row.status === "cancelled") &&
            this.#pending.delete(id)
          ) {
            if (pending.timer) clearTimeout(pending.timer);
            void pending.unsub?.().catch(() => {});
            pending.resolve({ approved: false, by: "system", note: row?.status ?? "missing" });
          }
          return void (await stale());
        }
        if (!pending) {
          const isPollRow = (row.payload as any)?.waiter === "poll";
          if (!isPollRow && row.instanceId === PendingGates.INSTANCE_ID) {
            // Our own in-process row with no waiter: the abort raced the
            // click. Settle the stray so it doesn't linger until expiry.
            await PendingGates.resolve(id, "cancelled", userId);
            await this.#publish(id);
            return void (await stale());
          }
          const bus = this.#bus();
          if (isPollRow || bus) {
            // poll row: the waiter is a node long-poll — any replica decides.
            // foreign in-process row + bus: the sibling's subscription wakes
            // its waiter, so deciding here is safe (spec §5). The approver
            // allowlist rides in the payload precisely so ANY replica can
            // authorize the clicker — checked BEFORE the guarded resolve so a
            // non-approver click never consumes the row.
            const approvers = new Set<string>((row.payload.approvers as string[] | undefined) ?? []);
            if (approvers.size > 0 && !approvers.has(userId)) return void (await notAllowed());
            const resolved = await PendingGates.resolve(id, approved ? "approved" : "denied", userId);
            if (!resolved) return void (await stale());
            await this.#publish(id);
            try {
              await respond({
                replace_original: true,
                text: `Plan → ${approved ? "*Approved*" : "*Denied*"} by <@${userId}>`,
                blocks: [],
              });
            } catch {}
            return;
          }
          // Foreign pending row and no bus: a sibling replica may be alive and
          // holding the promise with no way to wake it from here — cancelling
          // would leave the legit approver with "already decided" while the
          // sibling hangs forever. Keep the buttons, tell the clicker.
          try {
            await respond({
              response_type: "ephemeral",
              replace_original: false,
              text: ":hourglass: This approval is pending on another replica — it will be decided there (or auto-expire).",
            });
          } catch {}
          return;
        }

        // Authorize the clicker against this request's allowlist — BEFORE the
        // guarded resolve, so a non-approver click never consumes the row.
        const approvers = new Set<string>(
          (row.payload.approvers as string[] | undefined) ?? [...pending.approvers],
        );
        if (approvers.size > 0 && !approvers.has(userId)) return void (await notAllowed());

        // Exactly one click wins the guarded UPDATE; a duplicate or a race
        // against the auto-deny timer sees null and is stale.
        const resolved = await PendingGates.resolve(id, approved ? "approved" : "denied", userId);
        if (!resolved) {
          // A sweep expired (or an abort cancelled) the row under the live
          // waiter — deliver the deny locally, never hang.
          const cur = await PendingGates.get(id);
          if (cur && (cur.status === "expired" || cur.status === "cancelled") && this.#pending.delete(id)) {
            if (pending.timer) clearTimeout(pending.timer);
            void pending.unsub?.().catch(() => {});
            pending.resolve({ approved: false, by: "system", note: cur.status });
          }
          return void (await stale());
        }

        if (pending.timer) clearTimeout(pending.timer);
        this.#pending.delete(id);
        void pending.unsub?.().catch(() => {});
        await this.#publish(id);
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

  #bus(): GateBus | null {
    return this.#busOverride !== undefined ? this.#busOverride : defaultGateBus();
  }

  async #publish(id: string): Promise<void> {
    try {
      await this.#bus()?.publish(id);
    } catch (e) {
      console.error("[approval-gate] gate publish failed", e);
    }
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

  /** Globally unique gate id — a pending_gates PRIMARY KEY; several gate
   *  instances (tests, replicas) may mint in the same millisecond. */
  #mintId(): string {
    return `${Date.now().toString(36)}_${(++this.#counter).toString(36)}_${randomBytes(4).toString("hex")}`;
  }

  #card(req: ApprovalRequest, approvers: Set<string>, id: string, timeoutSec: number): any[] {
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
    sections.push({
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: `slaude_appr:approve:${id}` },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: `slaude_appr:deny:${id}` },
      ],
    });
    // Auto-deny hint must be in the blocks BEFORE the post — appending after
    // postMessage (the historical bug) never rendered anywhere.
    if (timeoutSec > 0) {
      sections.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `:hourglass: Auto-denies in *${timeoutSec}s* if no one clicks.` }],
      });
    }
    return sections;
  }

  /**
   * Non-blocking open for the REST tool plane (spec §3 "Blocking tools"):
   * durable row (payload.waiter='poll') + card + auto-deny timer, no promise.
   * The caller (a node) long-polls /v1/pending/:id; ANY replica's click
   * settles the row and publishes the wakeup.
   */
  async open(req: ApprovalRequest): Promise<{ pendingId: string }> {
    const id = this.#mintId();
    const approvers = this.#resolveApprovers(req);
    const timeoutSec = this.#timeoutSeconds();
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
        waiter: "poll",
      },
      expiresAt: timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : undefined,
    });

    let cardTs: string | undefined;
    if (timeoutSec > 0) {
      const timer = setTimeout(() => {
        void (async () => {
          const row = await PendingGates.resolve(id, "expired", "system");
          if (!row) return; // a click won
          await this.#publish(id);
          if (cardTs) {
            void this.#client.chat
              .update({
                channel: req.channel,
                ts: cardTs,
                text: `:hourglass: Auto-denied after ${timeoutSec}s — no approver clicked.`,
                blocks: [],
              })
              .catch(() => {});
          }
        })();
      }, timeoutSec * 1000);
      timer.unref?.();
    }

    try {
      const posted = await this.#client.chat.postMessage({
        channel: req.channel,
        thread_ts: req.threadTs,
        text: `:bell: Approval needed: ${truncate(req.summary, 80)}`,
        blocks: this.#card(req, approvers, id, timeoutSec),
      });
      cardTs = posted.ts as string | undefined;
    } catch (e) {
      // The card never reached Slack — settle the row and rethrow.
      void PendingGates.resolve(id, "cancelled", "system").catch(() => {});
      void this.#publish(id);
      throw e;
    }
    return { pendingId: id };
  }

  async request(req: ApprovalRequest, abortSignal?: AbortSignal): Promise<ApprovalDecision> {
    const id = this.#mintId();
    const approvers = this.#resolveApprovers(req);
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
          // Settle the durable row. If someone beat us to it, only a click on
          // THIS instance (status approved/denied) has a handler that will
          // deliver the decision — bus-woken siblings deliver via the
          // subscription. Any other terminal state (expired by a sweep,
          // cancelled, or even a purged row) is ours to finish: deny locally,
          // never hang.
          const row = await PendingGates.resolve(id, "expired", "system");
          if (row) await this.#publish(id);
          if (!row) {
            const cur = await PendingGates.get(id);
            if (cur && (cur.status === "approved" || cur.status === "denied")) return;
          }
          if (!this.#pending.delete(id)) return; // decision already delivered
          void p.unsub?.().catch(() => {});
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
    // Cross-replica wakeup: a click landing on a sibling replica resolves the
    // row and publishes; this subscription delivers the promise here.
    const bus = this.#bus();
    if (bus) {
      try {
        pending.unsub = await bus.subscribe(id, () => {
          void (async () => {
            const cur = await PendingGates.get(id);
            if (!cur || cur.status === "pending") return;
            if (!this.#pending.delete(id)) return; // local path already delivered
            if (pending.timer) clearTimeout(pending.timer);
            void pending.unsub?.().catch(() => {});
            pending.resolve(decisionFromApprovalRow(cur));
          })();
        });
      } catch (e) {
        console.error("[approval-gate] gate subscribe failed (falling back to click-only)", e);
      }
    }
    abortSignal?.addEventListener(
      "abort",
      () => {
        const p = this.#pending.get(id);
        if (!p) return;
        if (p.timer) clearTimeout(p.timer);
        this.#pending.delete(id);
        void p.unsub?.().catch(() => {});
        void PendingGates.resolve(id, "cancelled", "system")
          .then((row) => (row ? this.#publish(id) : undefined))
          .catch(() => {});
        p.resolve({ approved: false, by: "system", note: "aborted" });
      },
      { once: true },
    );

    try {
      const posted = await this.#client.chat.postMessage({
        channel: req.channel,
        thread_ts: req.threadTs,
        text: `:bell: Approval needed: ${truncate(req.summary, 80)}`,
        blocks: this.#card(req, approvers, id, timeoutSec),
      });
      pending.ts = posted.ts as string | undefined;
    } catch (e) {
      // The prompt never reached Slack — tear both stores down and rethrow.
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(id);
      void pending.unsub?.().catch(() => {});
      void PendingGates.resolve(id, "cancelled", "system").catch(() => {});
      throw e;
    }
    return promise;
  }
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
