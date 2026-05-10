import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

export type ApprovalRequest = {
  channel: string;
  threadTs: string;
  summary: string;
  tools?: string[];
  files?: string[];
  risks?: string;
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
export class ApprovalGate {
  #client: WebClient;
  #pending = new Map<string, (d: ApprovalDecision) => void>();
  #counter = 0;
  #approvers: Set<string>;

  constructor(app: App, approvers: string[]) {
    this.#client = app.client;
    this.#approvers = new Set(approvers);
    app.action(
      /^slaude_appr:(approve|deny):.+$/,
      async ({ ack, action, body, respond }) => {
        await ack();
        const a = action as { action_id: string };
        const m = a.action_id.match(/^slaude_appr:(approve|deny):(.+)$/);
        if (!m) return;
        const decision = m[1] as "approve" | "deny";
        const id = m[2]!;
        const resolve = this.#pending.get(id);
        const userId = (body as any).user?.id ?? "unknown";
        if (!resolve) {
          try {
            await respond({
              replace_original: true,
              text: `:lock: approval already decided`,
              blocks: [],
            });
          } catch {}
          return;
        }

        // Authorize the clicker. Empty allowlist = anyone may approve
        // (single-user / DM use). Non-empty allowlist enforced strictly.
        if (this.#approvers.size > 0 && !this.#approvers.has(userId)) {
          try {
            await respond({
              response_type: "ephemeral",
              replace_original: false,
              text: `:no_entry: <@${userId}>, you are not on the approver allowlist for this agent. The plan stays pending.`,
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
        resolve({ approved: decision === "approve", by: userId });
      },
    );
  }

  async request(req: ApprovalRequest, abortSignal?: AbortSignal): Promise<ApprovalDecision> {
    const id = `${Date.now().toString(36)}_${(++this.#counter).toString(36)}`;
    const sections: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:bell: *Approval needed*` },
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
    if (this.#approvers.size > 0) {
      const list = Array.from(this.#approvers)
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
      this.#pending.set(id, resolve);
      abortSignal?.addEventListener(
        "abort",
        () => {
          if (!this.#pending.has(id)) return;
          this.#pending.delete(id);
          resolve({ approved: false, by: "system", note: "aborted" });
        },
        { once: true },
      );
    });
  }
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
