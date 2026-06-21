# WhatsApp gateway — rework direction (parked)

Status: **parked** 2026-06-21. Captures the agreed direction for reworking this
branch's WhatsApp gateway so it fits the current architecture. Not a full spec —
decomposition is still open. Resume from here before writing code.

## Why this exists

The original `wa-support` branch (PR #1, 2026-05-24) added a WhatsApp gateway as a
**parallel, Slack-shaped stack** — its own adapter, approval gate, permission gate
and MCP tools wired straight into `AgentManager`. Two things happened since:

1. **Scope.** `CLAUDE.md` still reads "Slack integration only". Adding a second
   chat surface is a deliberate direction change — accepted, but it means the
   North Star wording must be updated as part of the rework.
2. **Architecture drift.** The branch predates the **Surface abstraction**
   (`src/gateway/core/surface.ts`, finding 2026-06-03). A new surface should route
   agent→user output through `Surface`, not a duplicated Slack-shaped stack.

So the branch as-is is rework, not rebase: ~2820 lines written against an obsolete
shape, base `v0.8.11`, conflicts in `package.json` / `bun.lock` / `src/server.ts`.

## Key constraint discovered

`Surface` covers agent→user **output** only. The gateway **input** side is still
Slack-coupled: `Transport.client` is `WebClientLike` (Slack's `chat.postMessage`,
`reactions`, `conversations.replies`, `action`/`ack` Block Kit). `createGateway`
holds all the shared logic — engagement, dedup, soul gates, approval routing, MCP
wiring, cron. That logic is what we want to reuse; the Slack-shaped transport is
what we do not.

## Decisions (brainstorm 2026-06-21)

1. **Integration — extract shared core + WhatsApp Surface.** Pull the
   platform-neutral logic (engagement, soul gates, approval resolution, MCP wiring)
   out of the Slack gateway into shared helpers. WhatsApp gets a thin Baileys input
   loop + a real `Surface` implementation for output. Slack path stays unchanged.
   Rejected: full `Transport`/gateway generalization (largest blast radius, risks
   the working Slack path) and a `WebClientLike` shim over Baileys (action/ack /
   Block Kit / `conversations.replies` don't map — leaky tech-debt trap).

2. **v1 scope — DM + group @mention.** DMs auto-engage (like Slack DMs); group
   chats gated by @mention. Pulls in engagement-state, mention parsing, and group
   JID handling from the start.

3. **Gate capture — reply keyword + timeout.** No Block Kit on WhatsApp. The
   WhatsApp `Surface.requestApproval` posts a prompt ("reply APPROVE or DENY within
   Nm"), captures the next reply from an authorized approver, matches a keyword,
   resolves `ApprovalResult`; auto-deny on timeout. The shared core still decides
   **who** may approve (soul approvers); only the prompt/capture is surface-specific.

4. **Auth — pre-provisioned creds only (no in-app QR).** Operator pairs out of
   band and mounts the Baileys auth-state dir; the app refuses to boot the WhatsApp
   gateway without valid creds. Needs a small separate pairing tool / runbook.
   Rejected: in-process QR-to-logs (kept as the manual pairing-tool mechanism) and
   QR-via-Telegram (couples bring-up to the Telegram bridge).

5. **Decomposition — UNDECIDED.** Open question when resumed: phase it
   (PR-A = behavior-preserving extraction of the platform-neutral core from the
   Slack gateway, Slack suite stays green; PR-B = WhatsApp transport + Surface +
   gates + pairing on top) vs one combined spec/PR. Recommendation on the table was
   to phase, to de-risk the Slack-regression surface.

## Risk to record in the eventual spec

Baileys is the unofficial WhatsApp Web (reverse-engineered) protocol — account-ban
and ToS exposure, heavy dependency. Accept consciously; document in the spec.

## Resume checklist

- [ ] Settle decomposition (decision 5).
- [ ] Update `CLAUDE.md` North Star / Scope to admit a second surface.
- [ ] Spec → plan for PR-A (core extraction) if phasing.
- [ ] Spec → plan for PR-B (WhatsApp surface) — reuse extracted helpers, real
      `Surface`, keyword+timeout gate, pre-provisioned creds + pairing tool.
- [ ] Rebase / re-implement against current `main` (base was `v0.8.11`).
