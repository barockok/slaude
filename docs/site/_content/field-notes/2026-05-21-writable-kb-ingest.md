# 2026-05-21 — Writable KB + /ingest

- Manifest gains two top-level fields: `slaude_skills` (push target for runtime-authored skills) and `slaude_knowledge` (single writable KB target). `skills[]` / `knowledge[]` are now strictly read-only; `sync_manifest` push-or-pulls them accordingly. `SLAUDE_SKILLS_REPO` env var kept as fallback for back-compat.
- `/ingest` slash command (manager + approvers only) runs a dedicated SDK sub-query against `~/.slaude/knowledge/<label>/` with the KB's README.md as schema. The sub-query reads `raw/`, updates `wiki/`, and pushes at end. No Slack output during the sub-query (no `mcp__slaude_slack__*` tools surfaced; `permissionMode: bypassPermissions` since gate is upstream at `/ingest`).
- Lock file gains `slaude_knowledge.raw_sha` + `slaude_knowledge.wiki_sha` (split). Normal `sync_manifest` calls push only `raw/`; ingest pushes both. Lets us detect "raw captured but un-ingested" state via `raw_sha > wiki_sha`.
- Mutex: sqlite `kb_ingest_jobs` table with UNIQUE partial index on `status='running'` — at most one ingest at a time. Heartbeat every 30s; stale jobs (no heartbeat for 10min) auto-marked `crashed` on next `tryAcquire` call.
- Crash policy: on next `/ingest`, stale-reap promotes any old `running` job to `crashed`. No branch/stash gymnastics — operator sees the failure surface and re-runs.
