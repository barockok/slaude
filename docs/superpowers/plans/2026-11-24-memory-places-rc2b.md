# Memory places RC2b (0.46.0-rc.47): plan

Move what the agent records about conversations, and what it learns from them, into places, behind the flag.
Spec: `docs/superpowers/specs/2026-11-24-memory-architecture.md` (section 7 holds the owner's decisions). Follows `-rc2a.md`.
Everything is active only under `env.memory.placesOn(persona)`; with `off` or `shadow` behaviour is rc.46's and each changed function has a test that says so.

- [x] 1. Transcripts move to the place under `on` (`memoryScopeFor`, per-turn sync, a non-manager in a public channel); thread history read place first then persona slice (c5309b44)
- [x] 2. Pass scopes: `PassScope` place, `thread_activity.scope` `place:<source>`, quiet-moment summaries beside the page (b55888d1); nightly review once per place from the registry (37cb0aeb)
- [x] 3. Lessons generalised: line validator (0e3d311c); upkeep collects proposals per place, no search tool, validated write, ungeneralisable proposals stay (8c3d0329)
- [x] 3b. Retrieval: `gather` place first, locality ties, `source_kind` (0062b1bd); per-turn block slices (per-turn block f18ba261)
- [x] 4. Narrower tools: `read_channel`, `list_cron_jobs`, `memory_about` with place sources (1bf6a222)
- [x] 5. Move job: `slaude memory-places move [--apply]` on the fake brain (97cb4a99)
- [x] 6. Docs and version: package.json rc.47, release notes, field note, configuration reference, this plan (this commit)
