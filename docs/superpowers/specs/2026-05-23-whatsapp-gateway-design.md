# WhatsApp Gateway Design

## Overview

Add a WhatsApp gateway to slaude as a new chat transport, parallel to the existing Slack gateway. One deploy = one persona = one WhatsApp number. Uses Baileys (WhatsApp Web protocol) for direct WebSocket connection — no Meta Business verification required.

## Goals

- WhatsApp users can DM the slaude agent and get responses
- Group chat support with @mention engagement
- Same session management, skills, knowledge base, and permission model as Slack
- Shared AgentManager — transport-agnostic core

## Non-Goals

- Meta Business API support (deferred)
- WhatsApp-specific features (status/stories, calls, payments)
- Multi-number per deploy

## Architecture

### Directory Structure

```
src/gateway/
├── slack/              (existing)
└── whatsapp/
    ├── adapter.ts      # Baileys client, message routing, session binding
    ├── mcp-tools.ts    # reply, react, upload, request_approval
    ├── format.ts       # Markdown → WhatsApp formatting
    ├── attachments.ts  # Media download
    ├── approval-gate.ts # Text-based approval flow
    └── users.ts        # Contact JID → name resolution
```

### Thread Model

WhatsApp has no native threads. Synthetic thread per conversation:
- `team_id`: always `"whatsapp"`
- `channel_id`: chat JID (`1234567890@s.whatsapp.net` or `group-id@g.us`)
- `thread_ts`: message ID of first inbound message in the conversation (creates session anchor)
- All subsequent messages in same chat map to same session

### Engagement Rules

- **DMs**: auto-engage all direct messages
- **Group chats**: require @mention (message text contains agent's registered phone number or configured alias) OR admin-configured `allowedGroups` in SOUL.md
- **Block list**: SOUL.md `blockedUsers` (phone numbers) enforced at gate

### Message Flow

```
Baileys "messages.upsert" event
  → adapter.onMessage()
    → dedup by message ID (Baileys msg.key.id)
    → drop own messages (msg.key.fromMe)
    → block gate (phone number in blockedUsers)
    → group mention gate (if group and not mentioned)
    → attachment download (parallel)
    → ensureSession({ team_id: "whatsapp", channel_id: jid, thread_ts: anchor_msg_id })
    → build XML envelope
    → agent.sendMessage(sessionId, envelope)
```

### XML Envelope

```xml
<channel source="whatsapp" channel_id="1234567890@s.whatsapp.net" thread_ts="msg-id-here" inbound_ts="msg-id-here" user_id="1234567890" user_name="Contact Name" trust="trusted|allowed|restricted">
{user text}
<attachment name="photo.jpg" mimetype="image/jpeg" size="12345" path="/tmp/..." />
</channel>

Reply by calling `mcp__slaude_whatsapp__reply` tool.
```

### Trust Levels

- `trusted`: DM from contact in `trustedUsers` SOUL.md field, or group in `trustedGroups`
- `allowed`: DM from non-blocked contact, or group in `allowedGroups`
- `restricted`: Blocked or unlisted — manager/backup manager only

### MCP Server: `slaude_whatsapp`

Tools exposed to agent:

| Tool | Description |
|------|-------------|
| `reply` | Send text message to chat |
| `react` | Send emoji reaction to a message |
| `upload` | Send media file to chat |
| `request_approval` | Request human approval for a plan |

### Agent Event Handling

| Event | WhatsApp Action |
|-------|-----------------|
| `toolCall` | Typing indicator on |
| `done` | Typing off, ✅ reaction to last user message |
| `error` | ❌ reaction + error text reply |
| `tokenWarning` | Text warning message |
| `compacting` | Typing indicator + "Compacting memory..." |

### Approval Flow

WhatsApp lacks rich interactive buttons. Two options:

1. **Text commands** (MVP): Agent sends plan summary. Approver replies with `approve` or `deny`. Timeout auto-deny after N minutes.
2. **Poll buttons** (Future): Use WhatsApp interactive messages (button/poll) if available via Baileys.

MVP uses text commands. Approval gate listens for next message from approver in same chat.

### Permission Gate

Same two-layer model as Slack:
1. SDK-driven per-tool approval: Agent asks user via text — "Allow `tool_name`? Reply: allow / always / deny"
2. High-level task approval: Agent calls `request_approval` with plan summary

### Format Conversion

WhatsApp supports limited formatting:
- Bold: `*text*`
- Italic: `_text_`
- Strikethrough: `~text~`
- Code: `` `text` ``
- Code block: triple backticks

`format.ts` converts standard markdown to WhatsApp subset. Code blocks preserved. Links kept as plain URLs (no hyperlinks in WhatsApp).

### Attachments

Baileys provides `downloadMediaMessage()` for inbound media. Files saved to temp dir, referenced in XML envelope. Outbound uploads via `sendMessage()` with `mimetype` and file buffer.

### Session Management

Same as Slack:
- `agent.ensureSession()` with thread key
- Idle timeout closes session
- Next message resumes with `resume`
- Working directory per session under `~/.slaude/workspaces/<sessionId>/`

### Environment Variables

```
WHATSAPP_ENABLED=true
WHATSAPP_APPROVERS=1234567890,0987654321
WHATSAPP_APPROVAL_TIMEOUT_SECONDS=300
```

### Server Entry

`server.ts` conditionally initializes gateways:

```typescript
const agent = new AgentManager();
if (env.slack?.enabled) {
  const slack = createSlackApp(agent);
  await slack.start();
}
if (env.whatsapp?.enabled) {
  const whatsapp = createWhatsAppApp(agent);
  await whatsapp.start();
}
```

### SOUL.md Extensions

New optional fields in SOUL.md schema:

```yaml
whatsapp:
  trustedUsers: ["1234567890"]
  allowedUsers: ["0987654321"]
  trustedGroups: ["group-id@g.us"]
  allowedGroups: ["group-id-2@g.us"]
```

If no `whatsapp` section, all non-blocked DMs are `allowed`, all groups require @mention.

## Testing Strategy

- Unit tests for `format.ts` (markdown → WhatsApp)
- Unit tests for `users.ts` (JID parsing)
- Integration test: mock Baileys events, verify session creation and reply routing
- Manual test: real WhatsApp number, verify DM and group chat flow

## Dependencies

- `@whiskeysockets/baileys` — WhatsApp Web protocol client
- `qrcode-terminal` — QR code display for auth
- `@adiwajshing/keyed-db` — Baileys dependency for message store

## Risks

1. **WhatsApp rate limiting / bans**: Baileys is unofficial. Excessive automation can trigger bans. Mitigation: conservative message rate, human-like delays.
2. **Baileys breaking changes**: WhatsApp updates protocol. Mitigation: pin version, monitor upstream.
3. **No persistent thread history**: Unlike Slack threads, WhatsApp conversations are flat. Session history lives in slaude DB.

## Future Work

- Meta Business API adapter (for enterprise/production)
- WhatsApp interactive message buttons (polls, lists)
- Broadcast list support
- Status/story read (not a priority)
