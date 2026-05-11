import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { loadApprovers, selectApprovers, selectApproversFrom } from "../../soul/loader";
import { soulData } from "../../soul/extract";

export type ApprovalRequest = {
  channel: string;
  threadTs: string;
  summary: string;
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
 */
type Pending = {
  resolve: (d: ApprovalDecision) => void;
  approvers: Set<string>;
};

export class ApprovalGate {
  #client: WebClient;
  #pending = new Map<string, Pending>();
  #counter = 0;
  /** Env-derived fallback allowlist. Used when persona has no approvers block
   *  or no matching category and no 'default' key either. */
  #envApprovers: Set<string>;

  constructor(app: App, envApprovers: string[]) {
    this.#client = app.client;
    this.#envApprovers = new Set(envApprovers);
    app.action(
      /^slaude_appr:(approve|deny):.+$/,
      async ({ ack, action, body, respond }) => {
        await ack();
        const a = action as { action_id: string };
        const m = a.action_id.match(/^slaude_appr:(approve|deny):(.+)$/);
        if (!m) return;
        const decision = m[1] as "approve" | "deny";
        const id = m[2]!;
        const pending = this.#pending.get(id);
        const userId = (body as any).user?.id ?? "unknown";
        if (!pending) {
          try {
            await respond({
              replace_original: true,
              text: `:lock: approval already decided`,
              blocks: [],
            });
          } catch {}
          return;
        }

        // Authorize the clicker against this request's allowlist.
        if (pending.approvers.size > 0 && !pending.approvers.has(userId)) {
          try {
            await respond({
              response_type: "ephemeral",
              replace_original: false,
              text: `:no_entry: <@${userId}>, you are not on the approver allowlist for this plan. The plan stays pending.`,
            });
          } catch {}
          return; // do NOT consume the pending entry
        }

        this.#pending.delete(id);
        const verb = decision === "approve" ? "*Approved*" : "*Denied*";
        try {
          await respond({
            replace_original: true,
            text: `Plan → ${verb} by <@${userId}>`,
            blocks: [],
          });
        } catch {}
        pending.resolve({ approved: decision === "approve", by: userId });
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
    const structured = soulData().approvers;
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
    const id = `${Date.now().toString(36)}_${(++this.#counter).toString(36)}`;
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
    sections.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: `slaude_appr:approve:${id}`,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: `slaude_appr:deny:${id}`,
        },
      ],
    });

    await this.#client.chat.postMessage({
      channel: req.channel,
      thread_ts: req.threadTs,
      text: `:bell: Approval needed: ${truncate(req.summary, 80)}`,
      blocks: sections,
    });

    return new Promise<ApprovalDecision>((resolve) => {
      this.#pending.set(id, { resolve, approvers });
      abortSignal?.addEventListener(
        "abort",
        () => {
          const p = this.#pending.get(id);
          if (!p) return;
          this.#pending.delete(id);
          p.resolve({ approved: false, by: "system", note: "aborted" });
        },
        { once: true },
      );
    });
  }
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
