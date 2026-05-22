# 2026-05-22 — Plugin loader chain (install → SDK → MCP)

Onboarding the first Claude Code marketplace plugin (`excalidraw-diagram`
from openskill) surfaced four bugs in the install → SDK → MCP pipeline.
Each fix unblocked the next failure mode. Documenting the chain so the
next plugin we onboard works end-to-end without surprises.

## The four landmines

### 1. EXDEV staging (v0.8.7)

`bun run install-deps` cloned each plugin/skill/KB into
`$SLAUDE_HOME/.tmp` and then `renameSync`'d the clone into its final
location. On bare boxes this is fine — `$SLAUDE_HOME` is one filesystem.
In the k8s deploy we subPath-mount `$SLAUDE_HOME/{.claude,skills,knowledge}`
as separate PVC volumes, so `.tmp/` ends up on the container's overlay fs
and renames cross device boundaries → `EXDEV: cross-device link not
permitted`.

Fix: stage inside a `.tmp/` *sibling of each destination subPath*
(`paths.claudeConfig/plugins/.tmp`, `paths.skills/.tmp`, `paths.knowledge/.tmp`).

### 2. SDK ignores `enabledPlugins` (v0.8.8)

After install-deps lands the plugin under `plugins/cache/<mp>/<plugin>/`
and writes the CC plugin metadata (`installed_plugins.json`,
`known_marketplaces.json`, `settings.json.enabledPlugins`), the running
SDK still doesn't expose the plugin's skills or MCPs. claude-agent-sdk
only reads those files if you opt in via `Options.settingSources:
['user']` — which would also pull operator CLAUDE.md and unrelated
settings.

Fix: read `installed_plugins.json` ourselves, translate each entry into
`{ type: 'local', path }`, and pass via `Options.plugins`. See
`src/config/plugins.ts:loadInstalledPluginPaths`.

### 3. `--plugin-dir` skips `.mcp.json` (v0.8.9)

`Options.plugins` serialises to `--plugin-dir <path>` on the child CLI.
The CLI's `cg5()` (session plugin loader) loads
skills/commands/hooks/agents/output-styles from each path — but does NOT
mount the plugin's `.mcp.json` MCP servers. Verified against the
literal `cli.js@2.0.77` shipped with the SDK: only `dg5()` (the path for
plugins enabled via settings) walks `.mcp.json`, and we deliberately
avoid that path.

Fix: read each installed plugin's `.mcp.json` ourselves and merge into
`Options.mcpServers`. See `loadInstalledPluginMcps`.

### 4. Bun image has no `npx` (v0.8.10)

`excalidraw-diagram/.mcp.json` launches its server via
`{ "command": "npx", "args": ["drawmode", "--stdio"] }` — the generic
Claude Code convention. The slaude base image is `oven/bun:1.3-debian`,
which ships `bunx` (and a `node` shim) but no `npx`. The stdio MCP
client fails to spawn, silently, and the tool just never appears.

Fix: transparently rewrite `command: "npx"` → `command: "bunx"` when
ingesting plugin MCPs (`shimStdioCommand` in `src/config/plugins.ts`).
`bunx` is API-compatible for the "download an npm package and run its
bin" case we care about.

## Net result

`slaude.json` declares one entry:

```json
{ "plugins": [{ "marketplace": "git@bitbucket.org:org/openskill.git",
                "plugin": "excalidraw-diagram", "ref": "main" }] }
```

On boot: `install-deps` clones the marketplace + plugin, writes CC
plugin metadata, and the agent session shows up with the
`excalidraw-diagram` skill + the `excalidraw` MCP server fully
connected (verified in UAT maria).

## Onboarding a new plugin

Add it to `slaude.json` plugins, restart the pod, done. If the plugin's
`.mcp.json` uses anything other than `npx` and we don't have the
toolchain in the base image (uv? deno?), either:

- install the toolchain in the deploy-hermes Dockerfile (we already do
  this for `uvx`/mcp-grafana), or
- add another shim entry in `shimStdioCommand`.
