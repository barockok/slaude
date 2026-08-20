import type { WASocket } from "@whiskeysockets/baileys";
import type {
  CanUseTool,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

type Pending = {
  resolve: (value: Awaited<ReturnType<CanUseTool>>) => void;
  toolName: string;
  input: Record<string, unknown>;
  timer: Timer;
};

export class PermissionGate {
  #sock: WASocket;
  #pending = new Map<string, Pending>(); // sessionId → pending
  #approvers: Set<string>;
  #timeoutMs: number;

  constructor(sock: WASocket, approvers: string[], timeoutSeconds = 300) {
    this.#sock = sock;
    this.#approvers = new Set(approvers.map((a) => a.replace(/[^0-9]/g, "")));
    this.#timeoutMs = timeoutSeconds * 1000;
  }

  /**
   * Called by the adapter when a user replies to a permission prompt.
   * Returns true if the message was consumed as a permission response.
   */
  handleReply(sessionId: string, phone: string, text: string): boolean {
    const pending = this.#pending.get(sessionId);
    if (!pending) return false;

    const reply = text.trim().toLowerCase();
    if (reply === "allow") {
      clearTimeout(pending.timer);
      this.#pending.delete(sessionId);
      pending.resolve({ behavior: "allow", updatedInput: pending.input });
      return true;
    }
    if (reply === "always") {
      clearTimeout(pending.timer);
      this.#pending.delete(sessionId);
      const permissions: PermissionUpdate[] = [{
        type: "addRules",
        rules: [{ toolName: pending.toolName }],
        behavior: "allow",
        destination: "session",
      }];
      pending.resolve({
        behavior: "allow",
        updatedInput: pending.input,
        updatedPermissions: permissions,
      });
      return true;
    }
    if (reply === "deny") {
      clearTimeout(pending.timer);
      this.#pending.delete(sessionId);
      pending.resolve({ behavior: "deny", message: "Denied by user" });
      return true;
    }
    return false;
  }

  resolver: (
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    ctx: Parameters<CanUseTool>[2],
  ) => ReturnType<CanUseTool> = async (sessionId, toolName, input, ctx) => {
    // Auto-allow read-only tools, WhatsApp MCP tools, skill introspection.
    const readOnly = ["Read", "Grep", "Glob", "LSP", "Bash"];
    const safePrefix = ["mcp__slaude_whatsapp__", "mcp__slaude_skills__", "mcp__slaude_kb__", "mcp__slaude_session__"];
    const isReadOnly = readOnly.includes(toolName) || safePrefix.some((p) => toolName.startsWith(p));
    const isSafe = isReadOnly || (toolName === "Bash" && !(input?.command as string)?.match(/rm\s+-rf|>|sudo/));

    if (isSafe) return { behavior: "allow", updatedInput: input };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(sessionId);
        resolve({ behavior: "deny", message: "Permission request timed out (no response)." });
      }, this.#timeoutMs);

      this.#pending.set(sessionId, { resolve, toolName, input, timer });

      // Send permission prompt to the chat
      const jid = ctx as unknown as string; // adapter passes jid as ctx
      this.#sock.sendMessage(jid, {
        text: `🔒 Allow \`${toolName}\`?\n\nReply with: *allow* | *always* | *deny*`,
      });
    });
  };
}
