import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type WAMessage,
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
        metric.stopGuardBlockedTotal.inc({ transport: "whatsapp" });
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
          text: `${level} Context ${ev.level}: ${ev.snapshot.pctUsed.toFixed(1)}% used`,
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
      [SKILLS_MCP_NAME]: createSkillsMcp(),
      [SESSION_MCP_NAME]: createSessionMcp({
        getSnapshot: () => agent.getTokenSnapshot(sessionId),
      }),
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

    // Block gate — blockedUsers are Slack IDs, not phone numbers.
    // For WhatsApp, skip Slack-ID-based block gate; operators should use
    // the approvers env var or future SOUL.md whatsapp section.
    // (We keep the metric call shape consistent with Slack.)

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
          metric.slackDropsTotal.inc({ reason: "group_no_mention" });
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

    // Manager/backup override — SOUL.md manager fields are Slack IDs.
    // For WhatsApp we rely on the trustedUsers/allowedUsers config instead.

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
    const files = await downloadAttachments({ message, workingDir: session.working_dir, msgId });

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
    if (sock) {
      (sock.ev as any).removeAllListeners();
      (sock as any).end(new Error("shutdown"));
    }
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
