# 2026-05-29 — /1on1 mode (per-thread engagement lock)

**What:** `/1on1` locks a thread so slaude listens only to the initiator + manager/backup;
others are silently dropped (reason `one_on_one`). `/1on1 off` (initiator or manager)
releases. Persistent in sqlite (`one_on_one_locks`), survives restart.

**Design:** Dedicated store + accessor (`db/one-on-one.ts`), mirroring the ignore system.
The gate sits in `handleMessage` after the channel-mode gate (so it overrides "anyone can
chat" in trusted/allowed channels) and before slash parsing (so a non-allowed user can't
`/1on1 off` to hijack a lock). Approval buttons are untouched — they go through
`ApprovalGate`'s action handler, independent of chat engagement, so approvers still approve.

**Verification:** unit tests for the store + slash parser; three simulation transcripts
(`one-on-one-lock`, `one-on-one-authz`, `one-on-one-manager-release`) drive the real gate
with no Slack. This surfaced a sim-infra gap: `send()` made every message its own thread, so
a per-thread lock never applied to a second sender. Fixed with an opt-in `thread:` field on
send steps that pins messages to one shared `thread_ts` (models a real Slack thread);
omitting it preserves the prior per-send-thread behavior.

**Deferred:** duration/auto-expiry, cross-thread per-user 1on1, a dedicated sim preset.
