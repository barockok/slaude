import { clientForApp, type AppRef, type Transport, type WebClientLike } from "../core/transport";
import { loadApprovers, selectApprovers, selectApproversFrom } from "../../soul/loader";
import { effectiveSoulForChannel } from "../../soul/extract";
import { approversFor, isDenied, loadGrants } from "../../access/role";
import * as PendingGates from "../../db/pending-gates";
import { defaultGateBus, type GateBus } from "../../queue/gate-bus";
import { randomBytes } from "node:crypto";
import { approvalTitle, auditGateRow } from "../../audit/emit";
import { redactSlack } from "./redact";
import { redactPatternsFor } from "../../soul/per-persona";

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
  /** Slack app the session belongs to (D1.2). The card is posted, and its
   *  timeout edit made, as this app. A click needs no client: it answers
   *  through the click's own response_url, which belongs to the posting app. */
  app?: AppRef;
  /** Persona name, stamped into the row for its audit rows. */
  persona?: string | null;
  /** Sent privately (a DM) to each approver after the card is posted, never
   *  into the thread: a reply an owner guardrail holds. With it, a request
   *  with no named approver is refused rather than left to anyone. */
  privateDetail?: string;
  /** A shorter limit than the persona's own timeout (never a longer one). */
  timeoutSeconds?: number;
};

/** An approver id no Slack user has: an approver set of just this admits
 *  nobody (an empty set would admit anyone). Never rendered on the card. */
const NOBODY = "!nobody";

/** Slack's three escapes, so a request's own words never become markup. */
const escapeMrkdwn = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The card's decided line, named by the request itself (`Deploy to staging →
 * *Approved* by @x`), redacted with the request persona's patterns.
 */
export function decidedLine(payload: Record<string, unknown> | null | undefined, approved: boolean, userId: string): string {
  const persona = typeof payload?.personaName === "string" ? payload.personaName : undefined;
  const line = `${escapeMrkdwn(approvalTitle(payload))} → ${approved ? "*Approved*" : "*Denied*"} by <@${userId}>`;
  return redactSlack(line, redactPatternsFor(persona));
}

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
  /** Client of the app the card was posted as; the timeout edit reuses it. */
  client: WebClientLike;
  /** gate-bus unsubscribe, when a bus is configured. */
  unsub?: () => Promise<void>;
};

export class ApprovalGate {
  #transport: Pick<Transport, "client" | "clientFor">;
  #pending = new Map<string, Pending>();
  #counter = 0;
  /** Env-derived fallback allowlist. Used when persona has no approvers block
   *  or no matching category and no 'default' key either. */
  #envApprovers: Set<string>;
  /** Source for the per-request timeout, given the request's persona. Injected so tests can override. */
  #timeoutSeconds: (persona?: string | null) => number;
  /** Explicit bus override (tests/sim); undefined = env-driven default. */
  #busOverride: GateBus | null | undefined;

  constructor(
    transport: Transport,
    envApprovers: string[],
    opts: { timeoutSeconds?: (persona?: string | null) => number; gateBus?: GateBus | null } = {},
  ) {
    this.#transport = transport;
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
        const stale = async (status?: string) => {
          try {
            // Ephemeral note only: a decided card is the visible record. An
            // expired/cancelled row was never decided, so don't say it was.
            await respond({ // runtime-ui: approval card
              response_type: "ephemeral",
              replace_original: false,
              text:
                status === "expired" || status === "cancelled"
                  ? `:hourglass: this approval ${status}`
                  : `:lock: approval already decided`,
            });
          } catch {}
        };
        const notAllowed = async (pendingRow: PendingGates.PendingGate, denied = false) => {
          // The allowlist or a deny grant refused the click; the row stays pending.
          auditGateRow(pendingRow, {
            verb: "refused",
            actorKind: "slack_user",
            actorId: userId,
            decision: "refused",
            summary: `approval ${verb} refused: ${denied ? "clicker is denied on this persona" : "clicker is not an approver"}`,
          });
          try {
            await respond({ // runtime-ui: approval card
              response_type: "ephemeral",
              replace_original: false,
              text: `:no_entry: <@${userId}>, you are not on the approver allowlist for this plan. The plan stays pending.`,
            });
          } catch {}
        };
        // A deny grant on the card's persona refuses the clicker even when the
        // card lists them or admits anyone (an empty allowlist). Read at click
        // time, so a deny added after the card was posted applies too.
        const deniedClicker = async (pendingRow: PendingGates.PendingGate): Promise<boolean> =>
          isDenied(await loadGrants((pendingRow.payload.personaName as string | undefined) ?? "default"), userId);
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
          return void (await stale(row?.status));
        }
        if (!pending) {
          const isPollRow = (row.payload as any)?.waiter === "poll";
          if (!isPollRow && row.instanceId === PendingGates.INSTANCE_ID) {
            // Our own in-process row with no waiter: the abort raced the
            // click. Settle the stray so it doesn't linger until expiry.
            const settled = await PendingGates.resolve(id, "cancelled", userId);
            if (settled) auditApprovalCancelled(settled, "slack_user", userId, "click raced the turn's abort");
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
            if (approvers.size > 0 && !approvers.has(userId)) return void (await notAllowed(row));
            if (await deniedClicker(row)) return void (await notAllowed(row, true));
            const resolved = await PendingGates.resolve(id, approved ? "approved" : "denied", userId);
            if (!resolved) return void (await stale());
            auditApprovalDecided(resolved, userId, approved);
            await this.#publish(id);
            try {
              await respond({ // runtime-ui: approval card
                replace_original: true,
                text: decidedLine(resolved.payload, approved, userId),
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
            await respond({ // runtime-ui: approval card
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
        if (approvers.size > 0 && !approvers.has(userId)) return void (await notAllowed(row));
        if (await deniedClicker(row)) return void (await notAllowed(row, true));

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
          return void (await stale(cur?.status));
        }

        if (pending.timer) clearTimeout(pending.timer);
        this.#pending.delete(id);
        void pending.unsub?.().catch(() => {});
        auditApprovalDecided(resolved, userId, approved);
        await this.#publish(id);
        try {
          await respond({ // runtime-ui: approval card
            replace_original: true,
            text: decidedLine(resolved.payload, approved, userId),
            blocks: [],
          });
        } catch {}
        pending.resolve({ approved, by: userId });
      },
    );
  }

  /** Per-request client: the request's app on a multi-app transport (D1.2). */
  #clientFor(req: ApprovalRequest): WebClientLike {
    return clientForApp(this.#transport, req.app);
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

  /** Resolve who may approve.
   *
   *  A named persona: every user whose role on it (roleOf, channel-aware) is
   *  approver or manager, with no scope keyword matching (phase 1); when it
   *  has none, the default persona's managers. Never the legacy list, the env
   *  list or "anyone": with no manager anywhere nobody may approve and the
   *  card times out denied.
   *
   *  The default persona, in order:
   *   1. LLM-extracted SoulData approvers, scope matched.
   *   2. Scope-described persona via regex parser.
   *   3. Legacy "category: ids" persona: persona[category] → persona.default.
   *   4. env SLAUDE_APPROVERS.
   *   5. Empty (anyone may click).
   *  then minus every user with a deny grant on the default persona. When the
   *  deny removes everyone the chain named, nobody may approve (never anyone).
   *  An empty set stays "anyone"; the click handler refuses a denied clicker. */
  async #resolveApprovers(req: ApprovalRequest): Promise<Set<string>> {
    if (req.persona && req.persona !== "default") {
      const ids = await approversFor(req.persona, req.channel);
      if (ids.length) return new Set(ids);
      console.warn(`[approval-gate] persona=${req.persona} has no approver or manager, nor does the default persona: nobody can approve`);
      return new Set([NOBODY]);
    }
    const chain = this.#defaultChain(req);
    if (chain.size === 0) return chain;
    const grants = await loadGrants("default");
    const kept = [...chain].filter((u) => !isDenied(grants, u));
    if (kept.length === chain.size) return chain;
    if (kept.length) return new Set(kept);
    console.warn("[approval-gate] every approver for this request is denied on the default persona: nobody can approve");
    return new Set([NOBODY]);
  }

  /** The default persona's approver chain, before deny grants apply. */
  #defaultChain(req: ApprovalRequest): Set<string> {
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
        // The agent wrote the summary: redacted with its persona's patterns like any post.
        text: { type: "mrkdwn", text: req.summary ? redactSlack(req.summary, redactPatternsFor(req.persona)) : "_(no summary)_" },
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
        .filter((u) => u !== NOBODY)
        .map((u) => `<@${u}>`)
        .join(" ") || "nobody (no manager is configured)";
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
    const approvers = await this.#resolveApprovers(req);
    const timeoutSec = this.#timeoutSeconds(req.persona);
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
        ...(req.persona ? { personaName: req.persona } : {}),
      },
      expiresAt: timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : undefined,
    });

    const client = this.#clientFor(req);
    let cardTs: string | undefined;
    if (timeoutSec > 0) {
      const timer = setTimeout(() => {
        void (async () => {
          const row = await PendingGates.resolve(id, "expired", "system");
          if (!row) return; // a click won
          auditApprovalExpired(row, timeoutSec);
          await this.#publish(id);
          if (cardTs) {
            void client.chat
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
      const posted = await client.chat.postMessage({ // runtime-ui: approval card
        channel: req.channel,
        thread_ts: req.threadTs,
        text: `:bell: Approval needed: ${truncate(req.summary, 80)}`,
        blocks: this.#card(req, approvers, id, timeoutSec),
      });
      cardTs = posted.ts as string | undefined;
    } catch (e) {
      // The card never reached Slack — settle the row and rethrow.
      void PendingGates.resolve(id, "cancelled", "system")
        .then((row) => row && auditApprovalCancelled(row, "system", "system", "card post failed"))
        .catch(() => {});
      void this.#publish(id);
      throw e;
    }
    return { pendingId: id };
  }

  /** Who may decide `req` (the set the card would name). Empty: anyone may click. */
  async approversFor(req: ApprovalRequest): Promise<string[]> {
    return [...(await this.#resolveApprovers(req))].filter((a) => a !== NOBODY);
  }

  /** The held text, to each approver's DM (best effort: an approver who cannot be reached can still deny). */
  async #sendDetail(client: WebClientLike, req: ApprovalRequest, approvers: Set<string>): Promise<void> {
    const where = `<#${req.channel}>`;
    for (const a of approvers) {
      if (a === NOBODY) continue;
      try {
        await client.chat.postMessage({ channel: a, text: `Held for your approval in ${where} (${escapeMrkdwn(req.summary)}):\n\n${req.privateDetail}` }); // runtime-ui: a held text to an approver's DM (already judged by deliver())
      } catch (e) {
        console.warn(`[approval-gate] could not send the held text to an approver: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async request(req: ApprovalRequest, abortSignal?: AbortSignal): Promise<ApprovalDecision> {
    const approvers = await this.#resolveApprovers(req);
    // A held text is for named approvers only: "anyone may click" would let
    // the thread approve what it was held from.
    if (req.privateDetail !== undefined && (approvers.size === 0 || [...approvers].every((a) => a === NOBODY))) {
      throw new Error("this agent has no approver to ask");
    }
    const id = this.#mintId();
    const own = this.#timeoutSeconds(req.persona);
    const timeoutSec = req.timeoutSeconds && req.timeoutSeconds > 0 ? (own > 0 ? Math.min(own, req.timeoutSeconds) : req.timeoutSeconds) : own;

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
        ...(req.persona ? { personaName: req.persona } : {}),
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
      client: this.#clientFor(req),
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
          if (row) {
            auditApprovalExpired(row, timeoutSec);
            await this.#publish(id);
          }
          if (!row) {
            const cur = await PendingGates.get(id);
            if (cur && (cur.status === "approved" || cur.status === "denied")) return;
          }
          if (!this.#pending.delete(id)) return; // decision already delivered
          void p.unsub?.().catch(() => {});
          // Best-effort UI update so the block doesn't look pending forever.
          if (p.ts) {
            void p.client.chat
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
          .then((row) => {
            if (!row) return;
            auditApprovalCancelled(row, "system", "system", "turn aborted");
            return this.#publish(id);
          })
          .catch(() => {});
        p.resolve({ approved: false, by: "system", note: "aborted" });
      },
      { once: true },
    );

    try {
      const posted = await pending.client.chat.postMessage({ // runtime-ui: approval card
        channel: req.channel,
        thread_ts: req.threadTs || undefined,
        text: `:bell: Approval needed: ${truncate(req.summary, 80)}`,
        blocks: this.#card(req, approvers, id, timeoutSec),
      });
      pending.ts = posted.ts as string | undefined;
      if (req.privateDetail !== undefined) await this.#sendDetail(pending.client, req, approvers);
    } catch (e) {
      // The prompt never reached Slack — tear both stores down and rethrow.
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(id);
      void pending.unsub?.().catch(() => {});
      void PendingGates.resolve(id, "cancelled", "system")
        .then((row) => row && auditApprovalCancelled(row, "system", "system", "card post failed"))
        .catch(() => {});
      throw e;
    }
    return promise;
  }
}

// Audit helpers. Each is called only by the path whose guarded resolve won,
// so every row is recorded once. Expiry: the in-process auto-deny timer owns
// the rows it expires; rows a sweep expires (no timer alive) are audited by
// the sweep's caller (auditExpiredGates).
function auditApprovalDecided(row: PendingGates.PendingGate, userId: string, approved: boolean): void {
  auditGateRow(row, {
    verb: "decided",
    actorKind: "slack_user",
    actorId: userId,
    decision: approved ? "allow" : "deny",
    summary: `${approved ? "approved" : "denied"}: ${String(row.payload.summary ?? "")}`,
  });
}

function auditApprovalExpired(row: PendingGates.PendingGate, timeoutSec: number): void {
  auditGateRow(row, {
    verb: "expired",
    actorKind: "system",
    actorId: "system",
    decision: "expired",
    summary: `auto-denied after ${timeoutSec}s: ${String(row.payload.summary ?? "")}`,
    details: { timeoutSec },
  });
}

function auditApprovalCancelled(
  row: PendingGates.PendingGate,
  actorKind: "slack_user" | "system",
  actorId: string,
  reason: string,
): void {
  auditGateRow(row, {
    verb: "cancelled",
    actorKind,
    actorId,
    decision: "cancelled",
    summary: `cancelled (${reason}): ${String(row.payload.summary ?? "")}`,
    details: { reason },
  });
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
