# Memory places RC1 (0.46.0-rc.45): plan

Shadow release: build the machinery and measure, change no turn's reads or writes, plus the wake-to-`shared` fix.
Spec: `docs/superpowers/specs/2026-11-24-memory-architecture.md` (section 7 holds the owner's decisions).

- [x] 0. Flag `SLAUDE_MEMORY_BOUNDARIES` (off|shadow|on, default shadow; on behaves as shadow in RC1) (02178a88)
- [x] 1. Registry table `memory_scopes` (migration 0054, sqlite mirror, repo module) (d1830d51)
- [x] 2. Place resolver `src/memory/place.ts`, `StoreKind` place (77737923)
- [x] 3. Required `place` on `ScopeInput` and `GateInput` (1a5f1474)
- [x] 4. Shadow measurement counters at the write points (6632592c)
- [x] 5. SQL-layer assertion in `buildScopedCtxAuth` (683987b6; the `mb-` naming moved to `place-id.ts` in the same commit)
- [x] 6. Wake to `shared`: create automatic, modify refused (ca0bd246)
- [x] 7. Guard tests (full-source, surface table, property) (23ddd70d)
- [x] 8. Docs and version (rc.45, release notes, field note, configuration reference) (41554d2a)
- [x] 9. This plan, ticked with commit hashes
- Test fixes found by the full run: 58f2c676
