import type { WASocket } from "@whiskeysockets/baileys";

export type ApprovalRequest = {
  jid: string;
  summary: string;
  tools?: string[];
  files?: string[];
  risks?: string;
  category?: string;
};

export type ApprovalDecision = {
  approved: boolean;
  by: string;
  note?: string;
};

type PendingApproval = {
  jid: string;
  resolve: (value: ApprovalDecision) => void;
  timer: Timer;
  approvers: Set<string>;
};

export class ApprovalGate {
  #sock: WASocket;
  #pending = new Map<string, PendingApproval>(); // sessionId → pending
  #defaultApprovers: Set<string>;
  #timeoutMs: number;

  constructor(sock: WASocket, approvers: string[], timeoutSeconds = 300) {
    this.#sock = sock;
    this.#defaultApprovers = new Set(approvers.map((a) => a.replace(/[^0-9]/g, "")));
    this.#timeoutMs = timeoutSeconds * 1000;
  }

  /**
   * Request approval for a plan. Sends summary to approvers, waits for reply.
   */
  async request(sessionId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(sessionId);
        resolve({ approved: false, by: "system", note: "Approval timed out (auto-denied)." });
      }, this.#timeoutMs);

      this.#pending.set(sessionId, {
        jid: req.jid,
        resolve,
        timer,
        approvers: this.#defaultApprovers,
      });

      const tools = req.tools?.length ? `\nTools: ${req.tools.join(", ")}` : "";
      const files = req.files?.length ? `\nFiles: ${req.files.join(", ")}` : "";
      const risks = req.risks ? `\n⚠️ Risks: ${req.risks}` : "";

      this.#sock.sendMessage(req.jid, {
        text: `📋 *Approval Required*\n\n${req.summary}${tools}${files}${risks}\n\nReply: *approve* or *deny*`,
      });
    });
  }

  /**
   * Called by adapter when any message arrives. If it's an approval response
   * from an authorized approver, resolves the pending approval.
   */
  handleReply(sessionId: string, phone: string, text: string): boolean {
    const pending = this.#pending.get(sessionId);
    if (!pending) return false;
    if (!pending.approvers.has(phone)) return false;

    const reply = text.trim().toLowerCase();
    if (reply === "approve" || reply === "approved" || reply === "yes") {
      clearTimeout(pending.timer);
      this.#pending.delete(sessionId);
      pending.resolve({ approved: true, by: phone });
      return true;
    }
    if (reply === "deny" || reply === "denied" || reply === "no") {
      clearTimeout(pending.timer);
      this.#pending.delete(sessionId);
      pending.resolve({ approved: false, by: phone });
      return true;
    }
    return false;
  }
}
