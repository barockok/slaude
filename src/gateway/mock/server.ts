import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage } from "./protocol";
import { SimTransport, type OutboundCard } from "../sim/transport";
import { statusLabel } from "../sim/render";

// 1. Configure environment & home paths before loading config modules
const home = process.env.SLAUDE_HOME ? resolve(process.env.SLAUDE_HOME) : join(homedir(), ".slaude");
process.env.SLAUDE_HOME = home;
process.env.SLAUDE_DB_PATH ??= join(home, "sim", "db.sqlite");
process.env.SLAUDE_WORKSPACES ??= join(home, "sim", "workspaces");
process.env.SLAUDE_HEALTH_PORT ??= "0";
process.env.SLACK_BOT_TOKEN ??= "xoxb-sim";

const { ensureHome } = await import("../../config/home");
ensureHome();
const { seedBundledSkills } = await import("../../skills/seed");
seedBundledSkills();

// Load root .env
const { loadDotenv } = await import("../../config/env");
loadDotenv(join(process.cwd(), ".env"));

// Preflight provider creds check
const { env } = await import("../../config/env");
const { missingCredsWarning } = await import("../sim/preflight");
const warn = missingCredsWarning({
  apiKey: env.provider.apiKey(),
  authToken: env.provider.authToken(),
  oauthToken: env.provider.oauthToken(),
});
if (warn) console.warn(`\n⚠️  ${warn}\n`);

// Prewarm structured soul
const { loadSoulData, setSoulData, soulData } = await import("../../soul/extract");
try {
  setSoulData(await loadSoulData());
  console.log("[soul] SOUL.md loaded and prewarmed");
} catch (e) {
  console.warn("[soul] prewarm warning (fallback to regex):", e);
}

const manager = soulData().manager?.userId ?? "U_MANAGER";
const botUserId = "U_SLAUDE";
const defaultChannel = "D0SIM";

// Create mock Slack transport
const transport = new SimTransport({
  users: { [manager]: "You (manager)" },
  botUserId,
});

// Create Agent Manager and Slaude Gateway
const { AgentManager } = await import("../../agent/manager");
const { createGateway } = await import("../core/gateway");
const agent = new AgentManager();
const gateway = createGateway(agent, transport);

await gateway.start();
console.log(`[slaude] gateway started with Mock Slack transport (acting as bot ${botUserId})`);

// Track connected WebSocket clients
const clients = new Set<ServerWebSocket<unknown>>();

// Broadcast card events (messages, gates, reactions) to all connected clients
transport.onCard((card: OutboundCard) => {
  console.log(`[slack:outbound] ${card.kind} channel=${card.channel} text=${JSON.stringify(card.text ?? "")}`);
  const payload: ServerMessage = { type: "card", card };
  const msg = JSON.stringify(payload);
  for (const client of clients) {
    try { client.send(msg); } catch {}
  }
});

// Broadcast live status (thinking, tool execution) to all connected clients
agent.on("event", (e: import("../../agent/manager").AgentEvent) => {
  if (e.type === "done" || e.type === "error") {
    console.log(`[mock:status] idle (${e.type})`);
    const payload: ServerMessage = { type: "status", status: null };
    const msg = JSON.stringify(payload);
    for (const client of clients) {
      try { client.send(msg); } catch {}
    }
    return;
  }
  const label = statusLabel(e);
  if (label !== null) {
    console.log(`[mock:status] ${label}`);
    const payload: ServerMessage = { type: "status", status: label };
    const msg = JSON.stringify(payload);
    for (const client of clients) {
      try { client.send(msg); } catch {}
    }
  }
});

const port = Number(process.env.SLAUDE_MOCK_PORT || 3040);

Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        botUserId,
        managerUserId: manager,
        channel: defaultChannel,
        outboundCount: transport.outbound.length,
      });
    }

    // History
    if (url.pathname === "/history") {
      return Response.json({ cards: transport.outbound });
    }

    // HTTP message ingress fallback
    if (url.pathname === "/message" && req.method === "POST") {
      return req.json().then(async (body: any) => {
        const rawText = String(body.text ?? "");
        const text = rawText.replace(/@bot\b/gi, `<@${botUserId}>`);
        const user = String(body.user ?? manager);
        const channel = String(body.channel ?? defaultChannel);
        console.log(`[slack:inbound] message from ${user} in ${channel}: ${text}`);
        void transport.feedMessage({
          channel,
          user,
          text,
          channel_type: channel === defaultChannel ? "im" : "channel",
        });
        return Response.json({ ok: true });
      });
    }

    // HTTP action ingress fallback
    if (url.pathname === "/action" && req.method === "POST") {
      return req.json().then(async (body: any) => {
        const actionId = String(body.actionId);
        const user = String(body.user ?? manager);
        console.log(`[slack:action] ${actionId} clicked by ${user}`);
        void transport.feedAction(actionId, user);
        return Response.json({ ok: true });
      });
    }

    return new Response("Slaude Mock Slack Server", { status: 200 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`[mock-slack] client connected (${clients.size} client(s) active)`);

      // Send initial state & recent cards
      const init: ServerMessage = {
        type: "init",
        botUserId,
        botName: soulData().identity?.role || "Agent",
        managerUserId: manager,
        channel: defaultChannel,
        cards: transport.outbound,
      };
      ws.send(JSON.stringify(init));
    },
    message(ws, raw) {
      try {
        const msg = JSON.parse(String(raw)) as ClientMessage;
        if (msg.type === "message") {
          const text = msg.text.replace(/@bot\b/gi, `<@${botUserId}>`);
          const channel = msg.channel ?? defaultChannel;
          console.log(`[slack:inbound] ${msg.user ?? manager}: ${text}`);
          void transport.feedMessage({
            channel,
            user: msg.user ?? manager,
            text,
            channel_type: channel === defaultChannel ? "im" : "channel",
          });
        } else if (msg.type === "action") {
          console.log(`[slack:action] ${msg.actionId} by ${msg.user ?? manager}`);
          void transport.feedAction(msg.actionId, msg.user ?? manager);
        }
      } catch (err) {
        console.error("[mock-slack] invalid message received from client:", err);
      }
    },
    close(ws) {
      clients.delete(ws);
      console.log(`[mock-slack] client disconnected (${clients.size} client(s) active)`);
    },
  },
});

console.log(`
┌────────────────────────────────────────────────────────┐
│  🚀 Slaude Mock Slack Server is RUNNING               │
│                                                        │
│  Port: http://localhost:${port}                           │
│  WebSocket: ws://localhost:${port}/ws                     │
│                                                        │
│  All Slaude runtime & tool logs stream right here.    │
│  Open another terminal and launch the Slack TUI:       │
│                                                        │
│    bun run slack:tui                                   │
└────────────────────────────────────────────────────────┘
`);
