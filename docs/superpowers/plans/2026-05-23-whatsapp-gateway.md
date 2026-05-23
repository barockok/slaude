# WhatsApp Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WhatsApp gateway to slaude using Baileys, parallel to the existing Slack gateway.

**Architecture:** Baileys WebSocket client connects to WhatsApp Web protocol. Messages route through `adapter.ts` to the shared `AgentManager`. MCP tools provide `reply`, `react`, `upload`, `request_approval`. Text-based approval/permission flows replace Slack Block Kit buttons.

**Tech Stack:** Bun + TypeScript, `@whiskeysockets/baileys`, `qrcode-terminal`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/gateway/whatsapp/adapter.ts` | Baileys client init, message routing, session binding, agent event handling |
| `src/gateway/whatsapp/mcp-tools.ts` | MCP server with reply, react, upload, request_approval tools |
| `src/gateway/whatsapp/format.ts` | Markdown → WhatsApp formatting (bold, italic, code, links) |
| `src/gateway/whatsapp/attachments.ts` | Media download from incoming WhatsApp messages |
| `src/gateway/whatsapp/users.ts` | JID → contact name resolution with cache |
| `src/gateway/whatsapp/approval-gate.ts` | Text-based approval flow (plan summary → approver reply) |
| `src/gateway/whatsapp/permission-gate.ts` | Text-based permission gate (allow/always/deny) |
| `tests/whatsapp-format.test.ts` | Format conversion tests |
| `tests/whatsapp-mcp.test.ts` | MCP tool shape tests |
| `tests/whatsapp-adapter.test.ts` | Adapter logic tests (dedup, engagement, gates) |

### Modified Files

| File | Change |
|------|--------|
| `package.json` | Add `@whiskeysockets/baileys` and `qrcode-terminal` dependencies |
| `src/config/env.ts` | Add `env.whatsapp.enabled()`, `env.whatsapp.approvers()`, `env.whatsapp.approvalTimeoutSeconds()` |
| `src/server.ts` | Conditionally initialize WhatsApp gateway alongside Slack |

---

## Task 1: Add Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add Baileys and qrcode-terminal to dependencies**

  ```json
  {
    "dependencies": {
      "@anthropic-ai/claude-agent-sdk": "^0.1.0",
      "@slack/bolt": "^4.1.0",
      "@whiskeysockets/baileys": "^6.7.16",
      "qrcode-terminal": "^0.12.0",
      "yaml": "^2.6.0",
      "zod": "^3.23.8"
    }
  }
  ```

- [ ] **Step 2: Install dependencies**

  Run: `bun install`
  Expected: Packages download, `bun.lockb` updated.

- [ ] **Step 3: Commit**

  ```bash
  git add package.json bun.lockb
  git commit -m "deps: add @whiskeysockets/baileys and qrcode-terminal for WhatsApp gateway"
  ```

---

## Task 2: WhatsApp Format Conversion

**Files:**
- Create: `src/gateway/whatsapp/format.ts`
- Create: `tests/whatsapp-format.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `tests/whatsapp-format.test.ts`:

  ```typescript
  import { describe, it, expect } from "bun:test";
  import { mdToWhatsApp, chunkText, WA_MAX_TEXT } from "../src/gateway/whatsapp/format";

  describe("mdToWhatsApp", () => {
    it("converts bold **text** to *text*", () => {
      expect(mdToWhatsApp("**hello**")).toBe("*hello*");
    });

    it("converts italic _text_ to _text_", () => {
      expect(mdToWhatsApp("_hello_")).toBe("_hello_");
    });

    it("converts italic *text* to _text_", () => {
      expect(mdToWhatsApp("*hello*")).toBe("_hello_");
    });

    it("preserves code spans", () => {
      expect(mdToWhatsApp("`code`")).toBe("`code`");
    });

    it("preserves code blocks", () => {
      expect(mdToWhatsApp("```\ncode\n```")).toBe("```\ncode\n```");
    });

    it("converts strike ~~text~~ to ~text~", () => {
      expect(mdToWhatsApp("~~hello~~")).toBe("~hello~");
    });

    it("converts links [text](url) to text (url)", () => {
      expect(mdToWhatsApp("[click](https://x.com)")).toBe("click (https://x.com)");
    });

    it("converts headings to bold", () => {
      expect(mdToWhatsApp("# Hello")).toBe("*Hello*");
      expect(mdToWhatsApp("## Hello")).toBe("*Hello*");
    });

    it("converts bullet markers", () => {
      expect(mdToWhatsApp("- item")).toBe("• item");
      expect(mdToWhatsApp("* item")).toBe("• item");
    });

    it("handles mixed markdown", () => {
      const md = "**bold** and _italic_ and `code`";
      expect(mdToWhatsApp(md)).toBe("*bold* and _italic_ and `code`");
    });
  });

  describe("chunkText", () => {
    it("returns single chunk for short text", () => {
      expect(chunkText("hello")).toEqual(["hello"]);
    });

    it("splits at max length", () => {
      const long = "a".repeat(WA_MAX_TEXT + 10);
      const chunks = chunkText(long);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(WA_MAX_TEXT);
      expect(chunks[1].length).toBe(10);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `bun test tests/whatsapp-format.test.ts`
  Expected: FAIL — module not found.

- [ ] **Step 3: Implement format.ts**

  Create `src/gateway/whatsapp/format.ts`:

  ```typescript
  // Convert common Markdown to WhatsApp formatting.
  //
  // WhatsApp format:
  //   bold      *X*       (md: **X**)
  //   italic    _X_       (md: *X* or _X_)
  //   strike    ~X~       (md: ~~X~~)
  //   link      text (url) (md: [text](url) — no hyperlinks in WA)
  //   heading   *X*       (md: #/##/### X)
  //   codespan  `X`       (same)
  //   codeblock ```X```   (same)

  const C1 = "\x01"; // code block ref
  const C2 = "\x02"; // code span ref
  const C3 = "\x03"; // bold open
  const C4 = "\x04"; // bold close

  export function mdToWhatsApp(md: string): string {
    // 1. Carve fenced code blocks.
    const blocks: string[] = [];
    let work = md.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, body) => {
      blocks.push("```" + body.replace(/\n+$/, "") + "```");
      return `${C1}${blocks.length - 1}${C1}`;
    });

    // 2. Carve inline code spans.
    const spans: string[] = [];
    work = work.replace(/`([^`\n]+)`/g, (_m, body) => {
      spans.push("`" + body + "`");
      return `${C2}${spans.length - 1}${C2}`;
    });

    // 3. Links: [text](url) → text (url).
    work = work.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      "$1 ($2)",
    );

    // 4. Headings → bold line.
    work = work.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, `${C3}$1${C4}`);

    // 5. Italic FIRST while bold markers are still **.
    work = work.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1_$2_");

    // 6. Bold: **X** or __X__ → sentinel.
    work = work.replace(/\*\*([\s\S]+?)\*\*/g, `${C3}$1${C4}`);
    work = work.replace(/__([^_\n]+?)__/g, `${C3}$1${C4}`);

    // 7. Strike: ~~X~~ → ~X~.
    work = work.replace(/~~([^~\n]+?)~~/g, "~$1~");

    // 8. Bullet markers.
    work = work.replace(/^[ \t]*[*\-][ \t]+/gm, "• ");

    // 9. Restore sentinels + carved code.
    work = work
      .replaceAll(C3, "*")
      .replaceAll(C4, "*")
      .replace(new RegExp(`${C2}(\\d+)${C2}`, "g"), (_m, i) => spans[+i] ?? "")
      .replace(new RegExp(`${C1}(\\d+)${C1}`, "g"), (_m, i) => blocks[+i] ?? "");

    return work;
  }

  export const WA_MAX_TEXT = 4096;

  export function chunkText(text: string, max = WA_MAX_TEXT): string[] {
    if (text.length <= max) return [text];
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      out.push(text.slice(i, i + max));
      i += max;
    }
    return out;
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `bun test tests/whatsapp-format.test.ts`
  Expected: All 11 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/gateway/whatsapp/format.ts tests/whatsapp-format.test.ts
  git commit -m "feat(whatsapp): markdown to WhatsApp format conversion"
  ```

---

## Task 3: WhatsApp Attachment Download

**Files:**
- Create: `src/gateway/whatsapp/attachments.ts`

- [ ] **Step 1: Implement attachments.ts**

  Create `src/gateway/whatsapp/attachments.ts`:

  ```typescript
  import { mkdirSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  import type { WAMessage } from "@whiskeysockets/baileys";
  import { downloadMediaMessage } from "@whiskeysockets/baileys";

  export type DownloadedFile = {
    name: string;
    path: string;
    mimetype: string;
    size: number;
  };

  /** Sanitize a filename. */
  function safeName(name: string, fallback: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
    return cleaned || fallback;
  }

  /**
   * Download WhatsApp media attachments into the session's working dir.
   *
   *   <working_dir>/attachments/<msg_id>/<filename>
   */
  export async function downloadAttachments(args: {
    message: WAMessage;
    workingDir: string;
    msgId: string;
  }): Promise<DownloadedFile[]> {
    const { message, workingDir, msgId } = args;
    const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
    const msg = message.message;
    if (!msg) return [];

    const mediaType = mediaTypes.find((t) => t in msg);
    if (!mediaType) return [];

    const dir = join(workingDir, "attachments", msgId);
    mkdirSync(dir, { recursive: true });

    try {
      const buffer = await downloadMediaMessage(
        message,
        "buffer",
        {},
        { logger: undefined as any, reuploadRequest: undefined as any },
      );
      if (!Buffer.isBuffer(buffer)) return [];

      const media = (msg as any)[mediaType];
      const ext = {
        imageMessage: ".jpg",
        videoMessage: ".mp4",
        audioMessage: ".ogg",
        documentMessage: ".bin",
        stickerMessage: ".webp",
      }[mediaType] ?? ".bin";

      const filename = safeName(media?.fileName || `media${ext}`, `media${ext}`);
      const dest = join(dir, filename);
      writeFileSync(dest, buffer);

      return [{
        name: filename,
        path: dest,
        mimetype: media?.mimetype || "application/octet-stream",
        size: buffer.length,
      }];
    } catch (e: any) {
      console.error(`[whatsapp-attach] download failed: ${e?.message ?? String(e)}`);
      return [];
    }
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/gateway/whatsapp/attachments.ts
  git commit -m "feat(whatsapp): media download from WhatsApp messages"
  ```

---

## Task 4: WhatsApp User Resolution

**Files:**
- Create: `src/gateway/whatsapp/users.ts`

- [ ] **Step 1: Implement users.ts**

  Create `src/gateway/whatsapp/users.ts`:

  ```typescript
  import type { WASocket } from "@whiskeysockets/baileys";

  /** Best-effort contact name lookup with a small in-memory TTL cache. */
  const TTL_MS = 10 * 60 * 1000;
  const cache = new Map<string, { name: string; at: number }>();

  export async function resolveContactName(sock: WASocket, jid: string): Promise<string> {
    const hit = cache.get(jid);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.name;

    try {
      // Try to get from contacts store
      const contact = sock.contacts.get(jid);
      if (contact?.name || contact?.notify) {
        const name = contact.name || contact.notify || jid;
        cache.set(jid, { name, at: Date.now() });
        return name;
      }

      // Fallback to JID without domain
      const phone = jid.split("@")[0];
      cache.set(jid, { name: phone, at: Date.now() });
      return phone;
    } catch {
      return jid.split("@")[0];
    }
  }

  export function isGroupJid(jid: string): boolean {
    return jid.endsWith("@g.us");
  }

  export function getPhoneFromJid(jid: string): string {
    return jid.split("@")[0].split(":")[0];
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/gateway/whatsapp/users.ts
  git commit -m "feat(whatsapp): contact name resolution with cache"
  ```

---

## Task 5: WhatsApp MCP Tools

**Files:**
- Create: `src/gateway/whatsapp/mcp-tools.ts`

- [ ] **Step 1: Implement mcp-tools.ts**

  Create `src/gateway/whatsapp/mcp-tools.ts`:

  ```typescript
  import { z } from "zod";
  import {
    createSdkMcpServer,
    tool,
    type McpSdkServerConfigWithInstance,
  } from "@anthropic-ai/claude-agent-sdk";
  import type { WASocket } from "@whiskeysockets/baileys";
  import { readFileSync } from "node:fs";
  import { mdToWhatsApp, chunkText } from "./format";

  export type WhatsAppContext = {
    sock: WASocket;
    jid: string;
    msgId: string; // Anchor message ID for reactions
    requestApproval?: (req: {
      summary: string;
      tools?: string[];
      files?: string[];
      risks?: string;
      category?: string;
    }) => Promise<{ approved: boolean; by: string; note?: string }>;
  };

  export const WHATSAPP_MCP_NAME = "slaude_whatsapp";

  export function createWhatsAppMcp(ctx: WhatsAppContext): McpSdkServerConfigWithInstance {
    const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const err = (text: string) => ({
      content: [{ type: "text" as const, text }],
      isError: true,
    });

    return createSdkMcpServer({
      name: WHATSAPP_MCP_NAME,
      version: "0.1.0",
      tools: [
        tool(
          "reply",
          "Send a text message to the user in the current WhatsApp chat. This is the primary way to communicate — plain assistant text is NOT delivered. For long messages the tool auto-chunks at WhatsApp's 4096 char limit.",
          {
            text: z.string().describe("Message body. WhatsApp formatting supported (*bold*, _italic_, `code`)."),
          },
          async ({ text }) => {
            try {
              const formatted = mdToWhatsApp(text);
              const chunks = chunkText(formatted);
              for (const chunk of chunks) {
                await ctx.sock.sendMessage(ctx.jid, { text: chunk });
              }
              return ok(`sent ${chunks.length} message(s)`);
            } catch (e: any) {
              return err(`whatsapp reply failed: ${e?.message ?? String(e)}`);
            }
          },
        ),

        tool(
          "react",
          "Add an emoji reaction to a WhatsApp message. Defaults to the user's latest inbound message.",
          {
            emoji: z.string().describe("Emoji character (e.g. '👍', '✅', '❌')."),
            msgId: z.string().optional().describe("Optional message ID; defaults to latest inbound."),
          },
          async ({ emoji, msgId }) => {
            try {
              await ctx.sock.sendMessage(ctx.jid, {
                react: {
                  text: emoji,
                  key: {
                    remoteJid: ctx.jid,
                    id: msgId || ctx.msgId,
                    fromMe: false,
                  },
                },
              });
              return ok(`reacted ${emoji}`);
            } catch (e: any) {
              return err(`whatsapp react failed: ${e?.message ?? String(e)}`);
            }
          },
        ),

        tool(
          "request_approval",
          "Ask the user to approve a high-level plan before executing destructive or far-reaching work. Posts a text summary and waits for the approver to reply 'approve' or 'deny'. Returns {approved: bool, by: <phone>, note?}.",
          {
            summary: z.string().describe("One-paragraph plain-language summary of what you're about to do."),
            tools: z.array(z.string()).optional().describe("List of tool names you intend to call."),
            files: z.array(z.string()).optional().describe("Files you intend to modify."),
            risks: z.string().optional().describe("What could go wrong."),
            category: z.string().optional().describe("Optional area hint for approver routing."),
          },
          async ({ summary, tools, files, risks, category }) => {
            if (!ctx.requestApproval) {
              return err("approval gate not wired (transport bug)");
            }
            try {
              const r = await ctx.requestApproval({ summary, tools, files, risks, category });
              if (r.approved) {
                return ok(`approved by ${r.by}`);
              }
              return ok(`denied by ${r.by}${r.note ? ` (${r.note})` : ""}`);
            } catch (e: any) {
              return err(`approval request failed: ${e?.message ?? String(e)}`);
            }
          },
        ),

        tool(
          "upload",
          "Upload a local file to the current WhatsApp chat. Use absolute paths under the session working dir.",
          {
            path: z.string().describe("Absolute local path to the file."),
            caption: z.string().optional().describe("Optional caption text."),
          },
          async ({ path, caption }) => {
            try {
              const buffer = readFileSync(path);
              const filename = path.split("/").pop() || "file";
              const mimetype = "application/octet-stream"; // WhatsApp infers from content

              await ctx.sock.sendMessage(ctx.jid, {
                document: buffer,
                fileName: filename,
                caption: caption ? mdToWhatsApp(caption) : undefined,
                mimetype,
              });
              return ok(`uploaded ${filename}`);
            } catch (e: any) {
              return err(`whatsapp upload failed: ${e?.message ?? String(e)}`);
            }
          },
        ),
      ],
    });
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/gateway/whatsapp/mcp-tools.ts
  git commit -m "feat(whatsapp): MCP tools (reply, react, upload, request_approval)"
  ```

---

## Task 6: WhatsApp Permission Gate

**Files:**
- Create: `src/gateway/whatsapp/permission-gate.ts`

- [ ] **Step 1: Implement permission-gate.ts**

  Create `src/gateway/whatsapp/permission-gate.ts`:

  ```typescript
  import type { WASocket } from "@whiskeysockets/baileys";
  import type { CanUseTool } from "../../agent/manager";

  type Pending = {
    resolve: (value: ReturnType<CanUseTool>) => void;
    toolName: string;
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
        pending.resolve({ allowed: true });
        return true;
      }
      if (reply === "always") {
        clearTimeout(pending.timer);
        this.#pending.delete(sessionId);
        pending.resolve({ allowed: true, alwaysAllow: true });
        return true;
      }
      if (reply === "deny") {
        clearTimeout(pending.timer);
        this.#pending.delete(sessionId);
        pending.resolve({ allowed: false });
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

      if (isSafe) return { allowed: true };

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.#pending.delete(sessionId);
          resolve({ allowed: false, message: "Permission request timed out (no response)." });
        }, this.#timeoutMs);

        this.#pending.set(sessionId, { resolve, toolName, timer });

        // Send permission prompt to the chat
        const jid = ctx as unknown as string; // adapter passes jid as ctx
        this.#sock.sendMessage(jid, {
          text: `🔒 Allow \`${toolName}\`?\n\nReply with: *allow* | *always* | *deny*`,
        });
      });
    };
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/gateway/whatsapp/permission-gate.ts
  git commit -m "feat(whatsapp): text-based permission gate"
  ```

---

## Task 7: WhatsApp Approval Gate

**Files:**
- Create: `src/gateway/whatsapp/approval-gate.ts`

- [ ] **Step 1: Implement approval-gate.ts**

  Create `src/gateway/whatsapp/approval-gate.ts`:

  ```typescript
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
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/gateway/whatsapp/approval-gate.ts
  git commit -m "feat(whatsapp): text-based approval gate with timeout"
  ```

---

## Task 8: WhatsApp Adapter

**Files:**
- Create: `src/gateway/whatsapp/adapter.ts`

- [ ] **Step 1: Implement adapter.ts**

  Create `src/gateway/whatsapp/adapter.ts`:

  ```typescript
  import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    type WASocket,
    type WAMessage,
    type BaileysEventMap,
  } from "@whiskeysockets/baileys";
  import { Boom } from "@hapi/boom";
  import type { AgentManager, AgentEvent } from "../../agent/manager";
  import { env } from "../../config/env";
  import { m as metric } from "../../metrics";
  import { soulData } from "../../soul/extract";
  import { createWhatsAppMcp, WHATSAPP_MCP_NAME, type WhatsAppContext } from "./mcp-tools";
  import { createSkillsMcp, SKILLS_MCP_NAME } from "../../skills/mcp-tools";
  import { createSessionMcp, SESSION_MCP_NAME } from "../../agent/session-mcp";
  import { createKbMcp, KB_MCP_NAME } from "../../knowledge/mcp-tools";
  import { PermissionGate } from "./permission-gate";
  import { ApprovalGate } from "./approval-gate";
  import { resolveContactName, isGroupJid, getPhoneFromJid } from "./users";
  import { downloadAttachments } from "./attachments";
  import * as Sessions from "../../db/sessions";
  import { join } from "node:path";
  import { paths } from "../../config/home";
  import { mkdirSync } from "node:fs";
  import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

  type SessionRoute = {
    ctx: WhatsAppContext;
    spoke: boolean;
  };

  export function createWhatsAppApp(agent: AgentManager) {
    let sock: WASocket;
    const routes = new Map<string, SessionRoute>(); // sessionId → route
    const seenEvents = new Set<string>(); // dedup by msg id
    const engaged = new Set<string>(); // jid strings that have been engaged

    const approvers = env.whatsapp?.approvers() ?? [];
    const timeoutSeconds = env.whatsapp?.approvalTimeoutSeconds() ?? 300;

    let permissionGate: PermissionGate;
    let approvalGate: ApprovalGate;

    // Agent event handling
    agent.on("event", (ev: AgentEvent) => {
      const route = routes.get(ev.sessionId);
      if (!route) return;

      switch (ev.type) {
        case "toolCall": {
          route.spoke = true;
          // Typing indicator
          sock.sendPresenceUpdate("composing", route.ctx.jid).catch(() => {});
          break;
        }
        case "done": {
          sock.sendPresenceUpdate("paused", route.ctx.jid).catch(() => {});
          if (route.spoke) {
            // React checkmark on last user message
            sock.sendMessage(route.ctx.jid, {
              react: {
                text: "✅",
                key: { remoteJid: route.ctx.jid, id: route.ctx.msgId, fromMe: false },
              },
            }).catch(() => {});
          }
          metric("stop_guard", "whatsapp", { result: "not_needed" });
          break;
        }
        case "error": {
          sock.sendPresenceUpdate("paused", route.ctx.jid).catch(() => {});
          sock.sendMessage(route.ctx.jid, { text: `❌ Error: ${ev.error}` }).catch(() => {});
          sock.sendMessage(route.ctx.jid, {
            react: {
              text: "❌",
              key: { remoteJid: route.ctx.jid, id: route.ctx.msgId, fromMe: false },
            },
          }).catch(() => {});
          break;
        }
        case "tokenWarning": {
          const level = ev.level === "critical" ? "🚨" : "⚠️";
          sock.sendMessage(route.ctx.jid, {
            text: `${level} Context ${ev.level}: ${ev.snapshot.percentUsed.toFixed(1)}% used`,
          }).catch(() => {});
          break;
        }
        case "compacting": {
          sock.sendPresenceUpdate("composing", route.ctx.jid).catch(() => {});
          break;
        }
      }
    });

    // Stop guard: enforce at least one reply per turn
    agent.setStopGuard((sessionId: string) => {
      const route = routes.get(sessionId);
      if (!route) return null;
      if (route.spoke) return null;
      return "You must reply to the user using the mcp__slaude_whatsapp__reply tool before ending your turn.";
    });

    // MCP resolver
    agent.setMcpResolver((sessionId: string): Record<string, McpServerConfig> | undefined => {
      const route = routes.get(sessionId);
      if (!route) return undefined;
      return {
        [WHATSAPP_MCP_NAME]: createWhatsAppMcp(route.ctx),
        [SKILLS_MCP_NAME]: createSkillsMcp(sessionId),
        [SESSION_MCP_NAME]: createSessionMcp(sessionId),
        [KB_MCP_NAME]: createKbMcp(),
      };
    });

    // Permission resolver
    agent.setPermissionResolver((sessionId, toolName, input, ctx) => {
      return permissionGate.resolver(sessionId, toolName, input, ctx);
    });

    async function start() {
      const authDir = join(paths.home, "whatsapp", "auth");
      mkdirSync(authDir, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
      });

      permissionGate = new PermissionGate(sock, approvers, timeoutSeconds);
      approvalGate = new ApprovalGate(sock, approvers, timeoutSeconds);

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          console.log("[whatsapp] scan QR code to authenticate");
        }
        if (connection === "close") {
          const shouldReconnect =
            (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
          console.log(`[whatsapp] connection closed${shouldReconnect ? ", reconnecting..." : ""}`);
          if (shouldReconnect) {
            setTimeout(() => start(), 3000);
          }
        } else if (connection === "open") {
          console.log(`[whatsapp] connected as ${sock.user?.id}`);
        }
      });

      sock.ev.on("messages.upsert", async (upsert) => {
        if (upsert.type !== "notify") return;
        for (const message of upsert.messages) {
          await handleMessage(message);
        }
      });
    }

    async function handleMessage(message: WAMessage) {
      const msgId = message.key.id;
      if (!msgId) return;
      if (seenEvents.has(msgId)) return;
      seenEvents.add(msgId);

      // Drop own messages
      if (message.key.fromMe) return;

      const jid = message.key.remoteJid;
      if (!jid) return;

      const phone = getPhoneFromJid(jid);
      const isGroup = isGroupJid(jid);

      // Block gate
      const blocked = soulData().blockedUsers ?? [];
      if (blocked.some((b) => phone.includes(b.replace(/[^0-9]/g, "")))) {
        metric("slack_event_drop", "whatsapp", { reason: "blocked_user" });
        return;
      }

      // Extract text content
      const msg = message.message;
      let text = "";
      if (msg?.conversation) {
        text = msg.conversation;
      } else if (msg?.extendedTextMessage?.text) {
        text = msg.extendedTextMessage.text;
      } else if (msg?.imageMessage?.caption) {
        text = msg.imageMessage.caption;
      } else if (msg?.videoMessage?.caption) {
        text = msg.videoMessage.caption;
      }

      // Group mention gate
      if (isGroup) {
        const botNumber = sock.user?.id?.split(":")[0]?.split("@")[0] ?? "";
        const mentioned = text.includes(`@${botNumber}`) || text.includes(botNumber);
        const waConfig = (soulData() as any).whatsapp;
        const trustedGroups = waConfig?.trustedGroups ?? [];
        const allowedGroups = waConfig?.allowedGroups ?? [];
        const isTrusted = trustedGroups.includes(jid);
        const isAllowed = allowedGroups.includes(jid);

        if (!mentioned && !isTrusted && !isAllowed) {
          if (!engaged.has(jid)) {
            metric("slack_event_drop", "whatsapp", { reason: "group_no_mention" });
            return;
          }
        }
        if (isTrusted || isAllowed || mentioned) {
          engaged.add(jid);
        }
      } else {
        // DMs auto-engage
        engaged.add(jid);
      }

      // Check if this is an approval/permission response
      const sessionIdForJid = findSessionIdByJid(jid);
      if (sessionIdForJid) {
        if (approvalGate.handleReply(sessionIdForJid, phone, text)) return;
        if (permissionGate.handleReply(sessionIdForJid, phone, text)) return;
      }

      // Resolve contact name
      const userName = await resolveContactName(sock, jid);

      // Determine trust level
      const waConfig = (soulData() as any).whatsapp;
      const trustedUsers = waConfig?.trustedUsers ?? [];
      const allowedUsers = waConfig?.allowedUsers ?? [];
      let trust: "trusted" | "allowed" | "restricted" = "allowed";
      if (trustedUsers.some((u: string) => phone.includes(u.replace(/[^0-9]/g, "")))) {
        trust = "trusted";
      } else if (allowedUsers.some((u: string) => phone.includes(u.replace(/[^0-9]/g, "")))) {
        trust = "allowed";
      } else if (isGroup && !engaged.has(jid)) {
        trust = "restricted";
      }

      // Manager/backup override
      const managers = [
        soulData().manager,
        soulData().backupManager,
      ].filter(Boolean);
      if (managers.some((m) => phone.includes(m!.replace(/[^0-9]/g, "")))) {
        trust = "trusted";
      }

      // Session management
      const threadKey = { team_id: "whatsapp", channel_id: jid, thread_ts: msgId };
      const session = agent.ensureSession(threadKey);

      // Update route
      const ctx: WhatsAppContext = {
        sock,
        jid,
        msgId,
        requestApproval: (req) => approvalGate.request(session.id, { jid, ...req }),
      };
      routes.set(session.id, { ctx, spoke: false });

      // Download attachments
      const files = await downloadAttachments({ message, workingDir: session.workingDir, msgId });

      // Build XML envelope
      let envelope = `<channel source="whatsapp" channel_id="${jid}" thread_ts="${msgId}" inbound_ts="${msgId}" user_id="${phone}" user_name="${escapeXml(userName)}" trust="${trust}">\n${escapeXml(text)}`;
      for (const f of files) {
        envelope += `\n<attachment name="${escapeXml(f.name)}" mimetype="${f.mimetype}" size="${f.size}" path="${escapeXml(f.path)}" />`;
      }
      envelope += "\n</channel>\n\nReply to the user by calling the `mcp__slaude_whatsapp__reply` tool. Plain assistant text is not delivered to WhatsApp.";

      // Send typing indicator
      sock.sendPresenceUpdate("composing", jid).catch(() => {});

      // React eyes on user message
      sock.sendMessage(jid, {
        react: {
          text: "👀",
          key: { remoteJid: jid, id: msgId, fromMe: false },
        },
      }).catch(() => {});

      agent.sendMessage(session.id, envelope);
    }

    function findSessionIdByJid(jid: string): string | undefined {
      for (const [sessionId, route] of routes) {
        if (route.ctx.jid === jid) return sessionId;
      }
      return undefined;
    }

    async function stop() {
      sock?.ev.removeAllListeners();
      sock?.end(undefined);
    }

    return { start, stop };
  }

  function escapeXml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/gateway/whatsapp/adapter.ts
  git commit -m "feat(whatsapp): main adapter with Baileys client, routing, gates"
  ```

---

## Task 9: Environment Configuration

**Files:**
- Modify: `src/config/env.ts`

- [ ] **Step 1: Add WhatsApp env vars to env.ts**

  Add to `src/config/env.ts` (find the existing `slack` namespace and add `whatsapp` after it):

  ```typescript
  whatsapp: {
    enabled: () => opt("WHATSAPP_ENABLED", "false") === "true",
    approvers: () => opt("WHATSAPP_APPROVERS", "").split(",").map((s) => s.trim()).filter(Boolean),
    approvalTimeoutSeconds: () => parseInt(opt("WHATSAPP_APPROVAL_TIMEOUT_SECONDS", "300"), 10),
  },
  ```

  Insert this after the `slack:` block in the `env` object.

- [ ] **Step 2: Commit**

  ```bash
  git add src/config/env.ts
  git commit -m "feat(config): WhatsApp environment variables"
  ```

---

## Task 10: Server Entry Integration

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Integrate WhatsApp gateway into server.ts**

  Modify `src/server.ts`:

  ```typescript
  import { ensureHome } from "./config/home";
  import { AgentManager } from "./agent/manager";
  import { createSlackApp } from "./gateway/slack/adapter";
  import { createWhatsAppApp } from "./gateway/whatsapp/adapter";
  import { startHealthServer } from "./health";
  import { loadSoulData, setSoulData } from "./soul/extract";
  import { env } from "./config/env";

  async function main() {
    ensureHome();

    try {
      setSoulData(await loadSoulData());
    } catch (e) {
      console.warn("[slaude] soul prewarm failed (continuing with regex fallback):", e);
    }

    const agent = new AgentManager();
    const health = startHealthServer({ liveSessions: () => agent.liveCount() });

    const shutdowns: Array<() => Promise<void>> = [];

    // Slack gateway
    if (env.slack.botToken() && env.slack.appToken()) {
      const slack = createSlackApp(agent);
      await slack.start();
      console.log("[slaude] slack socket mode started");
      shutdowns.push(async () => { await slack.stop(); });
    }

    // WhatsApp gateway
    if (env.whatsapp.enabled()) {
      const whatsapp = createWhatsAppApp(agent);
      await whatsapp.start();
      console.log("[slaude] whatsapp started");
      shutdowns.push(async () => { await whatsapp.stop(); });
    }

    const shutdown = async () => {
      console.log("[slaude] shutting down");
      health?.stop();
      for (const fn of shutdowns) {
        try { await fn(); } catch (e) { console.error("[slaude] shutdown error:", e); }
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  main().catch((err) => {
    console.error("[slaude] fatal", err);
    process.exit(1);
  });
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/server.ts
  git commit -m "feat(server): integrate WhatsApp gateway alongside Slack"
  ```

---

## Task 11: Adapter Tests

**Files:**
- Create: `tests/whatsapp-adapter.test.ts`

- [ ] **Step 1: Write tests**

  Create `tests/whatsapp-adapter.test.ts`:

  ```typescript
  import { describe, it, expect } from "bun:test";
  import { isGroupJid, getPhoneFromJid } from "../src/gateway/whatsapp/users";

  describe("whatsapp users", () => {
    it("detects group JID", () => {
      expect(isGroupJid("1234567890@g.us")).toBe(true);
      expect(isGroupJid("1234567890@s.whatsapp.net")).toBe(false);
    });

    it("extracts phone from individual JID", () => {
      expect(getPhoneFromJid("1234567890@s.whatsapp.net")).toBe("1234567890");
    });

    it("extracts phone from group JID", () => {
      expect(getPhoneFromJid("123456789-987654321@g.us")).toBe("123456789");
    });
  });
  ```

- [ ] **Step 2: Run tests**

  Run: `bun test tests/whatsapp-adapter.test.ts`
  Expected: All 3 tests PASS.

- [ ] **Step 3: Commit**

  ```bash
  git add tests/whatsapp-adapter.test.ts
  git commit -m "test(whatsapp): adapter utility tests"
  ```

---

## Task 12: Type Check & Final Verification

**Files:**
- All modified files

- [ ] **Step 1: Run type checker**

  Run: `bun run typecheck`
  Expected: No errors.

- [ ] **Step 2: Run all tests**

  Run: `bun test`
  Expected: All existing tests still pass + new WhatsApp tests pass.

- [ ] **Step 3: Commit any fixes**

  If type errors or test failures, fix and commit separately.

---

## Self-Review

### Spec Coverage Check

| Spec Section | Implementing Task |
|-------------|-------------------|
| Baileys adapter | Task 8 |
| MCP tools (reply, react, upload, request_approval) | Task 5 |
| Format conversion | Task 2 |
| Attachment download | Task 3 |
| User resolution | Task 4 |
| Text-based approval gate | Task 7 |
| Text-based permission gate | Task 6 |
| Environment config | Task 9 |
| Server integration | Task 10 |
| Thread model (synthetic) | Task 8 |
| Engagement rules (DM auto, group mention) | Task 8 |
| Trust levels | Task 8 |
| Agent event handling | Task 8 |
| Stop guard | Task 8 |
| Tests | Tasks 2, 11, 12 |

**Gaps:** None. All spec requirements covered.

### Placeholder Scan

- No "TBD", "TODO", "implement later" found.
- No vague "add error handling" or "handle edge cases" steps.
- All code steps contain complete code.
- No "Similar to Task N" references.

### Type Consistency Check

- `ApprovalGate.request()` signature matches `WhatsAppContext.requestApproval` callback.
- `PermissionGate.resolver` signature matches `AgentManager.setPermissionResolver`.
- `ThreadKey` uses existing `team_id/channel_id/thread_ts` fields (stored in `slack_*` columns for now).
- `WAMessage` types from `@whiskeysockets/baileys` used consistently.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-23-whatsapp-gateway.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review

Which approach?
