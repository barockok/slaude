# Memory places RC1 (0.46.0-rc.45): plan

Shadow release: build the machinery and measure, change no turn's reads or writes, plus the wake-to-`shared` fix.
Spec: `docs/superpowers/specs/2026-11-24-memory-architecture.md` (section 7 holds the owner's decisions).

- [ ] 0. Flag `SLAUDE_MEMORY_BOUNDARIES` (off|shadow|on, default shadow; on behaves as shadow in RC1)
- [ ] 1. Registry table `memory_scopes` (migration 0054, sqlite mirror, repo module)
- [ ] 2. Place resolver `src/memory/place.ts`, `StoreKind` place
- [ ] 3. Required `place` on `ScopeInput` and `GateInput`
- [ ] 4. Shadow measurement counters at the write points
- [ ] 5. SQL-layer assertion in `buildScopedCtxAuth`
- [ ] 6. Wake to `shared`: create automatic, modify refused
- [ ] 7. Guard tests (full-source, surface table, property)
- [ ] 8. Docs and version (rc.45, release notes, field note, configuration reference)
- [ ] 9. This plan, ticked with commit hashes
