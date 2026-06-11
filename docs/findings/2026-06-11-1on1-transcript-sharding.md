# /1on1 transcript sharding — resume breaks on lock flips (2026-06-11)

## Symptom

Resuming a /1on1 thread doesn't continue the conversation. Two distinct
failures depending on direction:

- **At `/1on1` lock:** session reboots (`agent.reload`) with `resume: <id>`,
  CLI answers "No conversation found with session ID", manager clears
  `claude_started`, thread cold-starts. All pre-lock context gone.
- **At `/1on1 off`:** reboot flips back to the agent config dir, where the
  **pre-lock** transcript still exists — resume "succeeds" silently with
  stale context. Every locked turn is missing. Worse than the lock case
  because nothing errors.

## Root cause

The CLI stores transcripts under `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl`.
The /1on1 per-initiator isolation (`resolveSessionConfigDir`, built so OAuth
MCP tokens resolve as the initiator — see
[2026-06-08 — /1on1 OAuth isolation](2026-06-08-oauth-config-dir-1on1.md))
flips `CLAUDE_CONFIG_DIR` to `$SLAUDE_HOME/oauth/<userId>`. Transcript
location rides along, so each lock-state flip points `resume` at a config
home that never saw the session.

The v0.20.1 session-id seeding fix is orthogonal: it aligns slaude's id with
the CLI's, but can't help when the transcript physically lives in a different
config home.

## Fix

`ensureInitiatorConfigDir` symlinks `projects/` from the initiator home to
the agent's (same pattern as the existing `plugins/` symlink). Isolation only
needs to cover credential stores (`.credentials.json`,
`mcp-needs-auth-cache.json`); transcripts must stay in one place.

Details:

- Agent `projects/` is `mkdir -p`'d before linking, so a thread that starts
  life locked still writes through the link into the agent home.
- A pre-existing **real** `projects/` dir in an initiator home (created by
  older versions during locked sessions) is left untouched — replacing it
  would orphan the transcripts inside. Those legacy threads stay sharded;
  new lock flips heal.

## Ops note

Live maria (0.19.4) also lacks the v0.20.1 seeding fix — on that deploy
resume misses 100% everywhere, /1on1 or not. Both fixes ship together
whenever the next image bump lands.
