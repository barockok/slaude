# 2026-05-21 — Dependency Manifest Design

- **Dependency manifest design spec drafted** (`docs/superpowers/specs/2026-05-21-dependency-manifest-design.md`). Declarative `slaude.json` + `slaude.lock` for three dependency surfaces: CC plugins (marketplace git), skills (git repo per skill), knowledge bases (Karpathy-style markdown wikis). MCP deliberately excluded — stays in `mcp.json`.
- **Architecture decisions locked in**:
  - **Source model**: git URLs only (tag/branch/sha). No registry for v1. Plugin entry shape: `{marketplace, plugin, ref}` — explicit plugin field, no URL-fragment parsing.
  - **CC plugin compat**: full — `plugin.json` at root, slaude fans out skills/commands/agents/hooks. Slaude doesn't reimplement plugin loading; CC's native loader in `$CLAUDE_CONFIG_DIR/plugins/cache/…` picks everything up.
  - **Install lifecycle**: build-time `slaude install` runs inside Dockerfile before runtime stage. Image ships self-contained. `--frozen` flag guarantees no network at image build. `--update` re-resolves branch refs.
  - **KB model**: LLM-wiki framework (Karpathy-style). Each KB is a cloned markdown wiki; the LLM navigates with Read/Grep/Glob. `slaude_kb` in-process MCP exposes `list_kbs` + `open_kb` (read-only, auto-allowed). No embeddings, no chunking — wiki author owns structure.
  - **Install layout**: plugins → `$CLAUDE_CONFIG_DIR/plugins/cache/<marketplace>/<plugin>/<version>/`, skills → `$SLAUDE_HOME/skills/<slug>/`, KBs → `$SLAUDE_HOME/knowledge/<label>/`. All baked into image, not PVC-mounted (operator files like `slaude.json`/`slaude.lock`/`mcp.json`/`SOUL.md` live on PVC).
  - **Marketplace resolution**: two shapes — self-contained (plugin subdirs in same repo) and index-only (`source.repo` + `source.ref` per plugin, second clone). Self-contained wins on collision.
  - **Lockfile**: sha-pinned. Dedupes marketplaces by `(marketplace, ref)`. Plugin versions come from `marketplace.json`, not git ref.
- **New runtime code needed**: `src/cli/install.ts` (installer), `src/knowledge/loader.ts` + `src/knowledge/mcp-tools.ts` (KB MCP). Plugins and skills need zero runtime changes — CC native loader + existing `discoverSkills()`.
- **Non-goals**: no MCP in manifest, no runtime resolver, no registry/index, no SOUL.md or memory in manifest, no KB embedding stack in slaude.
