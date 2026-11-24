# Memory places RC2a (0.46.0-rc.46): plan

Make `on` real for the memory a person can read back, behind the flag, with a per-persona canary.
Spec: `docs/superpowers/specs/2026-11-24-memory-architecture.md` (section 7 holds the owner's decisions).
Out of scope here: transcripts, `thread_activity` and pass scopes, nightly review and lessons per place, thread-history dual read,
gather ordering, `read_channel` and `list_cron_jobs` narrowing, the move job, console.

- [x] 1. Scope under `on`: `resolveBrainScope` and `memoryScopeFor`, registry binding, the gate for a turn's own place, the canary env var (a851d3c0); gateway wiring of `placesOn` and a manager's DM place, mode `off` keeps reading a bound place (ce0a1bb1)
- [x] 2. `memory_save` targets `here`, `persona` (promote, manager card), `shared`, `profile`; provenance and `place: unknown` frontmatter; demote through `memory_delete` (2c3f6ced)
- [x] 3. Checklist, commitments and rules into the place (79b70c0d)
- [x] 4. Rollback and flag semantics, tested across on, off, on (code in a851d3c0 and ce0a1bb1, test baa63dc4; gather and think fixes found by it, 496df6e8)
- [x] 5. The property and surface tests (6d647336); the live-model scenario is written, not run (needs a model)
- [x] 6. Cron job place on the job row: stored at creation, resolved from the job (2e55e963)
- [x] 7. Docs and version: package.json rc.46, release notes, field note, configuration reference, runtime skill text for `memory_save`, this plan (this commit; the skill text is in 2c3f6ced)
