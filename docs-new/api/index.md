# API & Skills Reference

> Complete surface for the slaude agent runtime: in-process MCP tools, Slack↔mrkdwn conversion, external MCP wiring, the `slaude.json` dependency manifest, writable knowledge bases, and the simulation gateway. Every tool is tabled with typed params and runnable examples.

## Contents

- [In-process MCP servers](#in-process-mcp-servers)
  - [`slaude_surface` — conversation surface](#slaude_surface--conversation-surface)
  - [`slaude_slack` — Slack context helpers](#slaude_slack--slack-context-helpers)
  - [`slaude_runtime` — control plane](#slaude_runtime--control-plane)
  - [`slaude_skills` — skill evolution](#slaude_skills--skill-evolution)
  - [`slaude_kb` — knowledge brain](#slaude_kb--knowledge-brain)
  - [`slaude_connect` — brokered OAuth](#slaude_connect--brokered-oauth)
- [Markdown to mrkdwn conversion](#markdown-to-mrkdwn-conversion)
- [External MCP servers](#external-mcp-servers)
- [Dependency manifest — `slaude.json` + `slaude.lock`](#dependency-manifest--slaudejson--slaudelock)
- [Writable KB — `raw/` to `wiki/` via `/ingest`](#writable-kb--raw-to-wiki-via-ingest)
- [Simulation gateway — running without Slack](#simulation-gateway--running-without-slack)

---

## In-process MCP servers

All in-process servers are mounted via `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`. Tool names are namespaced by the server name. For example `mcp__slaude_surface__reply` calls `reply` on the `slaude_surface` server. The legacy `mcp__slaude_slack__reply` alias still resolves for one release but is deprecated — prefer `slaude_surface`.

Capabilities are derived from the `Surface` abstraction (`src/gateway/core/surface.ts`). A capability like `edit` or `react` is only mounted when the underlying Surface declares it. Tests can call `surfaceTools(surface, opts)` without standing up the SDK server.

### `slaude_surface` — conversation surface

Source: `src/gateway/core/surface-mcp.ts` · SDK name `slaude_surface`

| Tool | Params | Description |
|------|--------|-------------|
| `reply` | `text: string` | Send a message to the current conversation. Markdown is converted to mrkdwn + redacted. Returns `posted ref=<id>` for later `edit`. This is the only way to show output to the user — plain assistant text is not displayed. |
| `get_history` | `limit?: number`, `include_replies?: boolean` *(default true)* | Read recent messages from the current conversation. Returns `{ messages, has_more }` JSON. |
| `request_approval` | `summary: string`, `tools?: string[]`, `files?: string[]`, `risks?: string`, `category?: string` | Ask the manager/approver to approve a plan before destructive work. Blocks until the user responds. Returns `approved by <@U…>` or `denied`. |
| `edit` | `ref: string`, `text: string` | Edit a previous `reply`. Requires `edit` capability. `ref` is the value returned by `reply`. |
| `react` | `name: string` *(emoji without colons)*, `ref?: string` | Add an emoji reaction. Defaults to the latest inbound user message. Requires `react` capability. Idempotent on `already_reacted`. |
| `unreact` | `name: string`, `ref?: string` | Remove a reaction previously added by the agent. |
| `upload` | `path: string` *(absolute, inside session cwd)*, `title?: string`, `initial_comment?: string`, `alt_text?: string` | Upload a local file into the current thread. `initial_comment` is rendered as mrkdwn above the file. Returns `uploaded file_id=…`. Requires `upload` capability. |
| `typing` | `on: boolean` | Show or clear the typing indicator. Requires `typing` capability. |
| `set_one_on_one` | `action: "open" \| "off"`, `scope?: string` | Adjust an already-active `/1on1` session for this thread. `open` admits guests with an optional behavioral scope; `off` releases. Cannot initiate 1on1 — use the slash command. |
| `set_mention_only` | `active: boolean` | Toggle mention-only mode for this thread. `true` = only respond when @-mentioned. |
| `soul_override` | `field: "trust" \| "allow" \| "dm" \| "block"`, `action: "add" \| "remove" \| "list" \| "clear"`, `value?: string` | Manager-only runtime ACL override. Takes effect next message and shadows `SOUL.md`. Gated on the live initiator id matching `manager.userId`. |

Example — reply and edit:

```ts
// inside an agent turn
await call("mcp__slaude_surface__reply", { text: "Deployed `api@2.4.1` to staging." })
// → { content: [{ type: "text", text: "posted ref=msg_01H..." }] }

await call("mcp__slaude_surface__edit", { ref: "msg_01H...", text: "Deployed `api@2.4.1` — smoke OK." })
```

Example — gated destructive work:

```ts
const r = await call("mcp__slaude_surface__request_approval", {
  summary: "Run DB migration add_users_email_idx on prod (migration 023).",
  tools: ["Bash", "Write"],
  files: ["migrations/023_add_idx.sql"],
  risks: "Locks users table for ~30s; reversible via rollback.",
  category: "db"
})
// → "approved by <@U01MANAGER>"  or  "denied by <@U01MANAGER> (not now)"
if (!r.content[0].text.startsWith("approved")) throw new Error("blocked")
```

---

### `slaude_slack` — Slack context helpers

Source: `src/gateway/slack/mcp-tools.ts` · SDK name `slaude_slack`

`reply` remains as a deprecated alias to `slaude_surface.reply`. The remaining tools read Slack identity without posting:

| Tool | Params | Description |
|------|--------|-------------|
| `reply` *(deprecated)* | `text: string` | Alias to `slaude_surface.reply`. Remove next release. |
| `get_user_profile` | `user_id: string` *(e.g. `U123ABC`)* | Fetch `users.info` — name, real_name, display_name, title, email, phone, status, timezone, pronouns, is_admin/is_owner/is_bot. Use to personalize and avoid asking for known info. |
| `get_channel_info` | — | Fetch `conversations.info` for the current channel — name, topic, purpose, `num_members`, `is_private`/`is_archived`/`is_im`, etc. |
| `list_users_in_channel` | `limit?: number` *(1–1000, default 200)* | List `conversations.members` user ids in the current channel. Resolve via `get_user_profile`. Returns `{ members, has_more }`. |
| `search_messages` | `query: string`, `count?: number` *(1–20, default 10)* | Workspace-wide `search.messages`. Supports Slack query syntax: `from:@alice`, `in:#engineering`, `after:2024-01-01`, `has:link`. Returns `{ total, matches: [{ ts, channel, user, text, permalink, score }] }`. |

```ts
await call("mcp__slaude_slack__get_user_profile", { user_id: "U08F1ABCD" })
// → { id, name: "alice", real_name: "Alice Doe", title: "Staff Eng", tz: "Asia/Jakarta", ... }

await call("mcp__slaude_slack__search_messages", { query: "from:@alice deploy after:2026-06-01", count: 5 })
```

---

### `slaude_runtime` — control plane

Source: `src/gateway/slack/mcp-tools.ts` · SDK name `slaude_runtime`

Housekeeping that never posts user-visible output. Most tools require manager or approver; channel overrides are respected (global `approvers` replaced per `## Channel <#C…>` block; `manager`/`backup` always honored).

| Tool | Params | Description |
|------|--------|-------------|
| `ignore_thread` | `duration: string`, `reason: string` | Silence this thread. `duration` is `5m`/`1h`/`permanent` (max 24h). |
| `unignore_thread` | — | Resume a previously ignored thread. |
| `ignore_user` | `user_id: string`, `duration: string`, `reason: string` | Silence a user globally. |
| `unignore_user` | `user_id: string` | Remove a user ignore. |
| `list_cron_jobs` | — | List active cron jobs — `id` prefix, 5-field UTC cron expr, `target`, `whenActive`, `nextRun`. |
| `add_cron_job` | `cron_expr: string`, `prompt: string`, `target?: "thread" \| "channel"`, `when_active?: "fire" \| "skip"` | Schedule a recurring prompt. `cron_expr` is UTC 5-field (`0 9 * * 1-5` = weekdays 09:00). Default `target=thread`, `when_active=fire`. |
| `edit_cron_job` | `job_id: string`, `cron_expr?: string`, `prompt?: string`, `target?: "thread"\|"channel"`, `when_active?: "fire"\|"skip"` | Patch an existing job; `job_id` accepts 8-char prefix. |
| `pause_cron_job` | `job_id: string` | Pause without deleting; stays listed. |
| `resume_cron_job` | `job_id: string` | Resume and recompute `nextRun` from stored expr. |
| `remove_cron_job` | `job_id: string` | Soft-deactivate; history retained. |
| `trigger_ingest` | — | Run the `raw/`→`wiki/` ingest now (can be slow). |
| `reload_session` | `prompt?: string` | Gracefully reload the session so new MCPs/plugins/skills are picked up. If `prompt` is given it is auto-injected on the fresh session. |

```ts
await call("mcp__slaude_runtime__add_cron_job", {
  cron_expr: "0 9 * * 1-5",
  prompt: "Post the daily incidents digest from #incidents.",
  target: "channel",
  when_active: "skip"
})
// → "Cron job created (`a1b2c3d4`) [channel, when_active=skip]. Next run: 2026-08-25T09:00:00.000Z"

await call("mcp__slaude_runtime__list_cron_jobs", {})
// → "*Active cron jobs*\n• `a1b2c3d4` `0 9 * * 1-5` [channel] → Post the daily… (next: …)"
```

---

### `slaude_skills` — skill evolution

Source: `src/skills/mcp-tools.ts` · SDK name `slaude_skills` · Hot-reload per inbound message via `discoverSkills()`

Skills are `~/.slaude/skills/<slug>/SKILL.md` (YAML frontmatter `name` + `description`, then markdown body). Body supports `${SLAUDE_SKILL_DIR}`, `${SLAUDE_SESSION_ID}`, `${SLAUDE_SKILL_ARGS}`. Persona overlays shadow the base skill: reads merge base+overlay, writes go to the persona overlay only.

| Tool | Params | Description |
|------|--------|-------------|
| `list_skills` | — | List installed skills as `/-slug — Name: description`. Prefer refining over duplicating. |
| `read_skill` | `slug: string` | Read the full `SKILL.md` for the slug. Read before refining. |
| `write_skill` | `slug: string` *(slug `[a-z0-9][a-z0-9-]{0,63}` invoked as `/slug`)*, `name: string`, `description: string`, `body: string` | Create or overwrite `SKILL.md`. `body` is markdown executed on `/slug`. |
| `delete_skill` | `slug: string` | Delete the skill dir. Irreversible. Persona can only delete its overlay. |
| `sync_manifest` | — | Sync runtime-created skills and KBs back to `slaude.json` + `slaude.lock`. If `SLAUDE_SKILLS_REPO` / `manifest.slaude_skills` is configured, pushes to git; otherwise records as local entries. Returns `{ synced_skills, synced_kbs, pulled_kbs, warnings, skills_in_git }`. Call sparingly — after creating multiple skills/KBs. |

Helpers exported for testing:

```ts
import { resolveSkillDir, buildSkillMd, skillOps } from "./src/skills/mcp-tools"

resolveSkillDir("release-notes")          // → ~/.slaude/skills/release-notes
resolveSkillDir("release-notes", "alice") // → ~/.slaude/personas/alice/skills/release-notes
buildSkillMd("Release Notes", "Cut release notes", "# Do the thing")
skillOps.list()            // Skill[]
skillOps.read("deploy")    // string (SKILL.md)
skillOps.write("deploy", "Deploy", "Run deploy", "# steps…")
skillOps.delete("deploy")
```

Example — evolve a skill at runtime:

```ts
await call("mcp__slaude_skills__read_skill", { slug: "release-notes" })
await call("mcp__slaude_skills__write_skill", {
  slug: "release-notes",
  name: "Release Notes",
  description: "Cut release notes grouped by Features/Fixes/Docs.",
  body: "# Release Notes\n\n1. Group commits by …\n2. Link findings docs.\n\nArgs: ${SLAUDE_SKILL_ARGS}"
})
await call("mcp__slaude_skills__sync_manifest", {})
// → { synced_skills: ["release-notes"], synced_kbs: [], skills_in_git: true }
```

Skill file format:

```markdown
---
name: "Release Notes"
description: "Cut release notes grouped by Features/Fixes/Docs."
---
# Release Notes

1. Collect commits since last tag.
2. Group by Features / Fixes / Docs / Internal.
3. Explain why, not just subject. Link findings.

Invoke as: /release-notes v0.28.0
Args available as ${SLAUDE_SKILL_ARGS}
```

---

### `slaude_kb` — knowledge brain

Source: `src/knowledge/mcp-tools.ts` · SDK name `slaude_kb` · Backed by gbrain (local or remote OAuth MCP)

Per-source `gather()` fan-out prevents bulk corpora from drowning curated pages. Scope-aware: each call carries a `BrainScope` (`agent-<id>` private slice + `shared`).

| Tool | Params | Description |
|------|--------|-------------|
| `list_kbs` | — | List installed KBs — `{ label, description, path, index_file }[]`. |
| `search_kbs` | `query: string`, `limit?: number` *(default 5)* | Ranked KB search by tag/label/description token score. Call before acting on service/domain queries to discover curated documentation. |
| `kb_think` | `question: string` | Synthesized answer with `[Source: slug]` citations and explicit gaps. Prefer over `kb_search` when you need an answer. Includes per-source cross-check + rescue synthesis when initial gather returns 0. |
| `kb_search` | `query: string`, `limit?: number` *(default 20)* | Raw ranked chunks `{ slug, score, snippet }` via per-source gather (not pooled gbrain search). |
| `kb_get_page` | `slug: string` | Read a single brain page by slug (`people/alice`). |
| `kb_list_pages` | `type?: string`, `tag?: string`, `limit?: number` *(default 50)* | List pages optionally filtered by type/tag. |
| `kb_graph` | `slug: string` | Outgoing `[[wikilinks]]` and backlinks for a page. |
| `kb_memoize` | `pages: { slug: string, content: string, summary: string }[]` *(1–N, max `KB_MEMOIZE_MAX_PAGES` per call)*, `target?: "mine" \| "shared"` | Write/update pages. Default `mine` = private agent slice, no approval. `shared` = team KB, requires manager approval (gated via `gatedBrainCall`). Content is markdown with optional YAML frontmatter; `[[wikilinks]]` become graph edges. |
| `kb_delete_page` | `slug: string`, `reason: string` | Soft-delete (recoverable). Gated, requires approval. |

Examples:

```ts
// Discover relevant KB before answering
await call("mcp__slaude_kb__search_kbs", { query: "service-a grafana alerts" })
// → ranked KBs with label "service-a"

// Answer with citations
await call("mcp__slaude_kb__kb_think", { question: "How does service-a handle on-call rotation?" })
// → synthesized answer + [Source: service-a/oncall.md] + Gaps: …

// Bulk curated write — mine vs shared
await call("mcp__slaude_kb__kb_memoize", {
  pages: [
    { slug: "people/alice", content: "# Alice\nBackend, on-call DRI.\n", summary: "Add Alice profile" },
    { slug: "decisions/2026-06-14-x", content: "# Decision …", summary: "Record x decision" }
  ],
  target: "mine" // private slice, no approval card
})

await call("mcp__slaude_kb__kb_memoize", {
  pages: [{ slug: "runbooks/service-a-deploy", content: "# Deploy …", summary: "Publish deploy runbook" }],
  target: "shared" // team KB — approval gate
})

// Graph
await call("mcp__slaude_kb__kb_graph", { slug: "service-a/oncall" })
// → { out: ["people/alice", "pagerduty/rotation"], backlinks: ["incidents/2026-05-01"] }
```

---

### `slaude_connect` — brokered OAuth

Source: `src/gateway/slack/mcp-tools.ts` · SDK name `slaude_connect` · Backed by `ConnectDeps.connect(server)`

Single-tool broker for external MCP OAuth. The agent declares intent; the gateway owns the flow (signed-state loopback + out-of-band authorize URL + redaction on settle). The URL never passes through the model and no paste-back is needed. Scope-gated: private services in a `/1on1` run as the initiator; the shared identity is manager-only.

| Tool | Params | Description |
|------|--------|-------------|
| `connect_mcp` | `server: string` *(name shown by `/mcp`)* | Start the deterministic connect engine for `server`. Posts the authorize link into the thread out-of-band and captures the result automatically. Returns a short status line for the agent to relay. |

```ts
await call("mcp__slaude_connect__connect_mcp", { server: "workbench" })
// → "Started OAuth for workbench — authorize link is in the thread."
// (link is posted by the gateway, not returned to the model)
```

Related slash commands: `/mcp` (list), `/mcp connect <server>` (same engine, surface-aware), `/mcp disconnect`.

---

## Markdown to mrkdwn conversion

Source: `src/gateway/slack/format.ts` · `mdToMrkdwn(md: string) => string`

Slack `mrkdwn` is not CommonMark. Slaude converts what LLMs emit (markdown) to what Slack renders (mrkdwn) before `chat.postMessage`/`chat.update`/`files.uploadV2`. The converter also chunks oversized payloads (`SLACK_MAX_TEXT = 39000`).

| Markdown | mrkdwn | Notes |
|----------|--------|-------|
| `**bold**` or `__bold__` | `*bold*` | Inner padding trimmed; Slack ignores `* x *`. Carried via sentinels so emphasis rules do not re-nest. |
| `*italic*` or `_italic_` | `_italic_` | Single-star italic requires non-`*` on both sides. `***X***` → `_*X*_`. |
| `~~strike~~` | `~strike~` | |
| `[text](url)` | `<url\|text>` | Optional title ` "…"` stripped. |
| `https://example.com/path` (bare) | `<https://example.com/path\|example.com>` | Host-only label; skipped when already `[t](url)` or `<url\|t>` or `<url>`; skipped inside code. |
| `#` / `##` / `###` heading | `*heading*` (bold line) | Trailing `#` stripped. |
| `` `code` `` | `` `code` `` | Preserved verbatim (carved before emphasis). |
| ` ```lang …``` ` | ` ```…``` ` | Language hint dropped; block carved before emphasis. |
| `* item` / `- item` at line start | `• item` | Bullet canonicalized. |
| Markdown table | Monospace code block | Column-padded with `  ` gutters; emphasis stripped inside code context. |

Processing order (load-bearing for correctness):

1. Table pass — `| a | b |` blocks rendered via `renderTable` first so pipes do not interfere with emphasis.
2. Carve fenced blocks → `C1` sentinel.
3. Carve inline spans → `C2` sentinel.
4. Bare-URL labeling — `https://…` → `[host](url)` *(skipped inside `<url>`/already-linked)*.
5. Carve URLs (`<https://…>` and remaining bare) → `C5` sentinel so `_`/`*` inside URLs never triggers emphasis.
6. Link rewrite `[t](url)` → `<url|t>`.
7. Heading → `*…*`.
8. `***X***` / `**X***` triple-star normalization.
9. Italic, then bold (separate sentinel phases).
10. Strikethrough, bullet rewrite.
11. Restore sentinels (`*` for bold, original code blocks/spans/URLs).

Edge fixes:

- URLs are carved before emphasis so `_` in `https://example.com/a_b` does not become italic.
- Bare URLs are host-labeled so long links do not eat the 39k budget visually.
- `C3…C4` sentinel pair avoids mistaking converted links for emphasis.

Table rendering:

```ts
mdToMrkdwn(`
| Name  | Owner |
|-------|-------|
| deploy | alice |
| oncall | bob   |
`)
// → "\n```\nName    Owner\n------  -----\ndeploy  alice\noncall  bob  \n```\n"
```

Chunking:

```ts
import { chunkText, SLACK_MAX_TEXT } from "./src/gateway/slack/format"
chunkText(longReply) // → string[] each ≤ 39000 chars; caller posts sequentially
```

---

## External MCP servers

External servers are user- or operator-configured extensions that the slaude gateway merges into the agent's tool list alongside the in-process servers. They run outside slaude and speak the MCP protocol over stdio, SSE, or streamable HTTP.

### `mcp.json` shape

Location: `~/.slaude/mcp.json` (also `~/.slaude/.mcp.json` via `src/config/mcp.ts`; plugins contribute `.mcp.json` per plugin dir — see `src/config/plugins.ts` with `npx`→`bunx` shim). Top-level key `mcpServers`:

```json
{
  "mcpServers": {
    "workbench": {
      "command": "node",
      "args": ["./dist/server.js"],
      "env": { "WORKBENCH_TOKEN": "${WORKBENCH_TOKEN}" }
    },
    "linear": {
      "type": "sse",
      "url": "https://mcp.linear.app/sse",
      "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" }
    },
    "graph": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${EXAMPLE_TOKEN}" }
    }
  }
}
```

### Transports

| Type | Config shape | When to use |
|------|--------------|-------------|
| `stdio` | `{ command: string, args?: string[], env?: Record<string,string> }` *(omit `type` or set `type:"stdio"`)* | Local subprocess. Plugin `.mcp.json` entries that use `npx <pkg>` are auto-rewritten to `bunx` under slaude's bun-only image. |
| `sse` | `{ type: "sse", url: string, headers?: Record<string,string> }` | Legacy server-sent events transport. |
| `http` / `streamable-http` | `{ type: "http", url: string, headers?: Record<string,string> }` | Streamable HTTP (preferred for hosted MCP). `type:"streamableHttp"` is also accepted where the SDK normalizes it. |

Minimal stdio example:

```json
{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] } } }
```

Minimal hosted example:

```json
{ "mcpServers": { "linear": { "type": "sse", "url": "https://mcp.linear.app/sse" } } }
```

### First-call approval gate

External MCP tools are not auto-authorized. The gateway enforces a first-call approval gate per server: the first time the agent attempts to call any tool from an external server in a session, slaude posts an approval card in Slack. The turn blocks on `request_approval` semantics (same approver resolution as the in-process `request_approval` — per-channel override if present, manager/backup always retained). Subsequent calls in the same session proceed without re-approval. Revoke by restarting the session or via `/mcp disconnect`.

Flow:

```
agent → call external tool (e.g. linear.createIssue)
      → gateway intercepts first call → posts approval card in thread
      → waits for manager/approver to approve/deny
      → on approve: tool executes; future calls skip gate
      → on deny: tool returns isError with denial reason
```

Per-channel nuance: if `SOUL.md` contains a `## Channel <#C…>` override, its `approvers` list replaces the global list for that channel. Manager and backup remain fallbacks so the gate is never lockout-prone. Runtime overrides via `soul_override` take effect next message.

OAuth helper for external MCPs: prefer `mcp__slaude_connect__connect_mcp` (or `/mcp connect <server>`) over pasting URLs. The gateway's shared loopback handles signed state, URL-safe posting, and scope gating; the authorize URL is redacted on settle (`docs/findings/2026-06-19-…md`).

---

## Dependency manifest — `slaude.json` + `slaude.lock`

The manifest is the declarative source of truth for everything the agent can grow: plugins, skills, and knowledge bases. It mirrors `package.json`/`package-lock.json`.

### `slaude.json`

Location: `~/.slaude/slaude.json` (validated by `src/config/manifest-schema.ts`). All arrays are optional; absent → empty.

```json
{
  "plugins": [
    { "marketplace": "github:owner/repo", "plugin": "my-plugin", "ref": "v1.2.0" }
  ],
  "skills": [
    { "git": "github:owner/skills", "ref": "main", "slug": "release-notes", "path": "release-notes" },
    { "source": "owner/repo/skill-path@main" },
    { "slug": "local-only-skill" }
  ],
  "knowledge": [
    { "label": "service-a", "git": "github:owner/docs", "ref": "main", "path": "docs/service-a" },
    { "label": "local-kb" }
  ],
  "slaude_skills": { "git": "github:owner/skills", "ref": "main" },
  "slaude_knowledge": { "label": "team-wiki", "git": "github:owner/wiki", "ref": "main" }
}
```

Field reference:

| Field | Shape | Description |
|-------|-------|-------------|
| `plugins[]` | `{ marketplace: github:…, plugin: string, ref: string }` | Claude Code plugins. Installer writes `installed_plugins.json` and `settings` patches; `src/config/plugins.ts` transpiles them into SDK `Options.plugins` and merges each plugin's `.mcp.json` into `Options.mcpServers`. |
| `skills[]` | `SkillEntry` — one of: `source` (Vercel-style `owner/repo[/path][@ref]`), `git+ref+slug(+path)` (git-backed), or `slug` (local) | Local entries live at `~/.slaude/skills/<slug>/`. Mixed `source`+`git`/`ref` is invalid. `resolveSkillSlug` / `resolveSkillSource` normalize both forms. |
| `knowledge[]` | `{ label: string, git?: string, ref?: string, path?: string }` *(git/ref paired)* | Git-backed entries support sparse checkout when `path` is set (only that subpath is promoted to `~/.slaude/knowledge/<label>/`). `path` missing → full clone. Local entries have no `git`/`ref`. |
| `slaude_skills` | `{ git: string, ref: string }` | Push target for `sync_manifest` when new skills/KBs should land in git instead of as local entries. Falls back to `SLAUDE_SKILLS_REPO` env. |
| `slaude_knowledge` | `{ label, git, ref }` | Writable KB remote: raw back-sync target (see next section). |

### `slaude.lock`

Location: `~/.slaude/slaude.lock`. Generated by `slaude install`. Shape:

```json
{
  "version": 1,
  "generated_at": "2026-08-23T00:00:00.000Z",
  "marketplaces": { "github:owner/repo": { "sha": "abc…" } },
  "skills": { "release-notes": { "git": "github:owner/skills", "ref": "main", "sha": "abc…", "path": "release-notes" } },
  "knowledge": { "service-a": { "git": "github:owner/docs", "ref": "main", "sha": "abc…", "path": "docs/service-a" } },
  "slaude_knowledge": { "label": "team-wiki", "git": "github:owner/wiki", "ref": "main", "raw_sha": "…", "wiki_sha": "…" }
}
```

Each value records the content-addressed `sha` of the cloned commit so installs are reproducible.

### `slaude install`

Source: `src/cli/install.ts` · Usage `bun src/cli/install.ts [--update] [--frozen] [--check]` · Exit codes `0 ok / 1 --check drift / 2 schema error / 3 git/net / 4 marketplace`

| Flag | Effect |
|------|--------|
| *(none)* | Install per `slaude.json`; write/refresh `slaude.lock`. Uses stage-then-rename inside sibling `.tmp` dirs so container PVC subPath mounts do not hit `EXDEV`. |
| `--update` | Re-resolve refs to newest commit before locking (bump). |
| `--frozen` | Require `slaude.lock` to match `slaude.json` exactly; exit 1 on drift. Use in CI and production deploys. |
| `--check` | Like `--frozen` but read-only; never mutates. Suitable for a lint step. |

```sh
bun src/cli/install.ts              # install / refresh lock
bun src/cli/install.ts --frozen     # CI: fail if manifest drifted
bun src/cli/install.ts --update     # bump all refs
bun src/cli/install.ts --check      # lint without writing

SLAUDE_HOME=~/.slaude bun src/cli/install.ts --frozen
```

Marketplace/plugin lineage: installed plugins are tracked in `$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json`. Slaude's loader reads that file, emits `SdkPluginPath[]` for the SDK, and separately loads each plugin's `.mcp.json` because the 0.1.x CLI only forwards `--plugin-dir` for skills/commands, not MCP servers.

### `sync_manifest` push target

`mcp__slaude_skills__sync_manifest` (and `syncManifest()` in `src/skills/sync-manifest.ts`) reconciles the live filesystem (`~/.slaude/skills/*`, `~/.slaude/knowledge/*`) with the manifest:

1. Normalizes `source` entries to `git+ref+path`.
2. Pulls every git-backed `knowledge` entry (sparse when `path` present) and records its `sha` in `slaude.lock`.
3. If `slaude_knowledge` is configured and `raw/` changed, pushes `raw/` back to that remote and updates `raw_sha`.
4. Discovers unregistered skills/KBs. If a push target exists — `manifest.slaude_skills` or `SLAUDE_SKILLS_REPO` — clones the repo shallow, copies each new skill dir and each new KB's `knowledge/<label>/` tree, commits with `slaude@local`, pushes, and records `manifest.skills`/`manifest.knowledge` plus `lock.skills`/`lock.knowledge` as git-backed. If no target or push fails, records them as local `slug`/`label` entries and appends a warning.
5. Writes `slaude.json` + `slaude.lock` atomically via `*.tmp` + `renameSync`.

Configure the target once:

```json
// slaude.json
{ "slaude_skills": { "git": "github:acme/slaude-catalog", "ref": "main" } }
```

```sh
# or via env
SLAUDE_SKILLS_REPO=github:acme/slaude-catalog slaude start
```

After the agent evolves a skill, it should call `sync_manifest` so the next `slaude install --frozen` reproduces the new skill.

---

## Writable KB — `raw/` to `wiki/` via `/ingest`

Knowledge bases are wikis with a durable source→derived split. Operators edit the source; slaude derives the retrievable wiki.

```
~/.slaude/knowledge/<label>/
  raw/        # operator-authored markdown — the durable source of truth
  wiki/       # agent-derived, indexed pages — what kb_search/kb_think retrieve
  README.md   # KB description + tags used by search_kbs scoring
```

Source: `src/knowledge/ingest.ts` · `src/db/ingest-jobs.ts` (deprecated job row now superseded by brain, retained for reap logic) · `src/knowledge/loader.ts`

### `/ingest` flow

1. Trigger: `mcp__slaude_runtime__trigger_ingest`, `/ingest` slash command, or `runIngest({ triggeredBy })` programmatically. Requires manager/approver.
2. Ingest scans `raw/` across all installed KBs, chunks, and writes normalized pages into `wiki/` (and the gbrain store when enabled). The wiki is what `kb_*` tools serve.
3. After ingest completes, `brainSync` / `brainBackfill` propagate to the shared slice.

Manual invocation:

```ts
await call("mcp__slaude_runtime__trigger_ingest", {})
// → "Ingest complete — 12 files → 48 pages (2 warnings)"  or  "Ingest failed: …"
```

CLI equivalent where available:

```sh
# from inside the slaude session workspace
/ingest
```

### SQLite mutex

Concurrent ingests are unsafe. The mutex is a single-row guard in `db.sqlite` (`kb_ingest_jobs`):

```sql
CREATE TABLE kb_ingest_jobs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT CHECK(status IN ('running','completed','failed','crashed')),
  triggered_by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  UNIQUE(status) WHERE status='running'  -- at most one running job
);
```

API (`src/db/ingest-jobs.ts`):

| Function | Description |
|----------|-------------|
| `tryAcquire(label, triggeredBy): IngestJob \| null` | `INSERT … status='running'`; returns `null` on unique-violation (another ingest is running). Calls `reapStale()` first. |
| `heartbeat(id)` | Bump `heartbeat_at` for a running job; caller should heartbeat periodically for long ingests. |
| `release(id, "completed"\|"failed"\|"crashed")` | Mark terminal status. |
| `runningJob(): IngestJob \| null` | Current holder, if any. |
| `reapStale(): string[]` | Mark any `running` job whose `heartbeat_at < now - 10m` as `crashed`; returns their ids. `STALE_AFTER_MS = 10 * 60 * 1000`. |

Typical use:

```ts
import * as IngestJobs from "./src/db/ingest-jobs"

const job = IngestJobs.tryAcquire("team-wiki", triggeredByUserId)
if (!job) throw new Error("Ingest already running — try again shortly.")
try {
  const t = setInterval(() => IngestJobs.heartbeat(job.id), 30_000)
  await doIngest()
  clearInterval(t)
  IngestJobs.release(job.id, "completed")
} catch (e) {
  IngestJobs.release(job.id, "failed")
  throw e
}
```

> Note: `kb_ingest_jobs` is marked `@deprecated` in favor of gbrain's incremental `kb_memoize` path. New code should write via `kb_memoize` instead of bulk `/ingest`; the mutex row is retained until removal so in-flight `/ingest` calls remain safe.

---

## Simulation gateway — running without Slack

Slaude can be driven without a Slack workspace. The simulation gateway (`src/gateway/sim/`) is a headless Surface plus a TUI that speaks the same protocol as the Slack adapter, wired for tests, CI, and local verification. Findings docs `docs/findings/2026-05-29-simulation-gateway.md`, `2026-06-03-sim-interactive-real-agent.md`, and `2026-06-04-repl-claude-code-ux.md` document the evolution.

### What it is

- A `Surface` implementation backed by an in-memory transport (`src/gateway/sim/transport.ts`) instead of `@slack/bolt`.
- A deterministic engine (`engine.ts`) that replays scripted scenarios and a live harness (`--real`) that mounts the actual `AgentManager` loop.
- An OpenTUI REPL (`src/gateway/sim/tui/`) with a pinned bordered input box, live status, and gate-box grouping — superseding the earlier raw-mode TUI.

### Running

```sh
# Interactive REPL against the live agent (Slack-free) — mirrors `slaude start --sim`
bun src/gateway/sim/cli.ts --real

# Deterministic scenario run (CI)
bun src/gateway/sim/cli.ts --scenario onboarding

# With a fixture soul
bun src/gateway/sim/cli.ts --real --soul src/gateway/sim/soul-fixture.ts
```

Flags (`src/gateway/sim/cli.ts`):

| Flag | Description |
|------|-------------|
| `--real` | Mount the real `AgentManager` + SDK loop instead of the stub agent. Use to verify live tool wiring (`reply`/`react`/`request_approval`/`kb_*`/external MCP) without Slack. |
| `--scenario <name>` | Run a named deterministic scenario from `src/gateway/sim/scenarios/` or `scenarios-real/`. |
| `--soul <path>` | Load a fixture `SOUL.md` instead of `~/.slaude/SOUL.md`. |
| `--headless` | No TUI — pipe transcript to stdout; useful in CI. |

Preflight checks (`src/gateway/sim/preflight.ts`) validate Node/Bun version, `SOUL.md` presence, and `$SLAUDE_HOME` layout before the session starts. The transcript layer (`transcript.ts`) persists every turn to `~/.slaude/workspaces/<session>/transcript.jsonl` so a sim session can be re-opened exactly like a Slack thread.

### When to use it

- Verifying a new MCP server or skill without spamming a Slack channel.
- CI regression: `bun test` mounts the sim transport; scenarios assert tool call sequences and approval gates without network.
- Local soul iteration: edit `SOUL.md`, run `--real`, converse, tweak, repeat.

```ts
// src/gateway/sim/scenarios/onboarding.ts (sketch)
import { defineScenario } from "../engine"
export default defineScenario({
  name: "onboarding",
  steps: [
    { user: "hello, I'm Alice", expect: { tool: "get_user_profile" } },
    { user: "deploy service-a",  expect: { tool: "request_approval" } },
  ]
})
```

---

## See also

- `src/gateway/core/surface-mcp.ts` — Surface tool definitions + gating
- `src/gateway/slack/mcp-tools.ts` — Slack + runtime + connect MCPs
- `src/gateway/slack/format.ts` — `mdToMrkdwn` / `chunkText` / `renderTable`
- `src/skills/mcp-tools.ts` + `src/skills/sync-manifest.ts` — Skill evolution and manifest sync
- `src/knowledge/mcp-tools.ts` + `src/knowledge/gather.ts` + `src/knowledge/ingest.ts` — Brain tools, per-source gather, ingest
- `src/config/manifest-schema.ts` + `src/cli/install.ts` — Manifest schema and installer
- `src/config/plugins.ts` — Plugin → SDK loader + `npx`→`bunx` shim
- `src/db/ingest-jobs.ts` — SQLite ingest mutex
- `src/gateway/sim/` — Simulation gateway (transport, engine, TUI, scenarios)
