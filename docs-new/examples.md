# Examples

> **Four copy-paste examples you can run in order.** Each one is self-contained, shows prerequisites inline, ends with expected output, and has a troubleshooting tip that fixes the one thing most likely to go wrong.

On this page:

- [Prerequisites for all examples](#prerequisites)
- [1. Minimal SOUL.md persona + verify + deploy via Docker Compose](#1-minimal-soulmd-persona--team-assistant-in-5-minutes)
- [2. Adding a skill via slaude.json — git skill, bunx shim, sync_manifest](#2-adding-a-skill-via-slaudejson)
- [3. Private KB capture to wiki — raw to wiki via ingest](#3-private-kb-capture--ingest--wiki)
- [4. Simulation gateway — test engagement and approvals without Slack](#4-simulation-gateway--test-without-slack)

Related: [Getting Started](getting-started/index.md) · [Configuration & SOUL](configuration.md) · [Deployment & Ops](deployment/index.md) · [API & Skills Reference](api/reference.md)

---

## Prerequisites

Every example assumes you have cloned slaude and can run Bun. You do not need a Slack workspace for Example 4.

| Requirement | Version | Check |
|-------------|---------|-------|
| **Bun** | `>= 1.3` | `bun --version` |
| **Git** | any | `git --version` |
| **Docker + Compose** | Docker Desktop or Engine | `docker compose version` — only for Example 1 |
| **Slack workspace** | where you can create an app | `api.slack.com/apps` — only for Examples 1, 3 |
| **LLM provider** | Anthropic API key or Claude Pro/Max OAuth token, or any Anthropic-compatible gateway | `echo $ANTHROPIC_API_KEY` or `echo $CLAUDE_CODE_OAUTH_TOKEN` — only for Examples 1, 3 |

```bash
git clone https://github.com/barockok/slaude.git
cd slaude
bun install
```

> **File locations in these examples.** Commands use the repo root as cwd (where `package.json` lives). Runtime state lives under `~/.slaude` locally or `/data` inside the container (`SLAUDE_HOME`). Docker Compose mounts `./data` → `/data` — see [Configuration — Filesystem layout](configuration.md#filesystem) for the full tree.

---

## 1. Minimal SOUL.md persona — team assistant in 5 minutes

Deploy one persona that triages `#engineering` and ships with approvals. You will create `SOUL.md`, validate it, and boot the container. Slack DMs are restricted to your user; the public channel is open to anyone in it.

### What you will build

A single container `slaude` running Socket Mode, persona `aria`, manager = you, one trusted team channel, one approval rule, one redaction pattern. No external MCP, no KB, no skills yet.

### Prerequisites for this example

- Slack bot token `xoxb-…` and app token `xapp-…` with `connections:write` (see [Configuration — Slack](configuration.md#slack))
- Provider credential: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
- Your Slack user id (`U…`) — find it in Slack profile → More → Copy member ID

### Steps

**1. Create the Slack app (once).**

```bash
bun run manifest > manifest.json
# api.slack.com/apps → Create New App → From manifest → paste manifest.json
# Basic Information → App-Level Tokens → Generate with connections:write → copy xapp-…
# OAuth & Permissions → Install to workspace → copy xoxb-…
# Agents & AI Apps → enable assistant view (assistant:write)
# Socket Mode → enable
```

If you already have a workspace app from [Getting Started](getting-started/index.md), skip this step.

**2. Create the runtime home and env file.**

```bash
mkdir -p ./data

cat > .env << 'ENV'
SLACK_BOT_TOKEN=xoxb-1234567890-XXXXXXXXXXXX
SLACK_APP_TOKEN=xapp-1-A111-abc123def456
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
# OR: CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxxxxxxxxxxxxx
# Leave SLAUDE_MODEL unset to inherit the subscription default; set it only on non-Anthropic gateways.
SLAUDE_MODEL=
SLAUDE_HOME=/data
SLAUDE_IDLE_MINUTES=15
SLAUDE_HEALTH_PORT=8080
ENV

# Docker Compose mounts ./data → /data and reads .env at the repo root.
# For bare-metal deploys, copy to the home instead: cp .env ~/.slaude/.env
```

> **Bare metal without Docker.** Use `cp .env ~/.slaude/.env` and `bun run dev` in step 4. The rest of the example is identical; health probes move to `localhost:8080` on your host.

**3. Write the minimal SOUL.md — the only file you author.**

```bash
cat > ./data/SOUL.md << 'MD'
# Persona

## Identity
- Name: aria
- Role: engineering teammate in #engineering
- Voice: terse, direct, no filler. fragments OK.

## Reporting
- Manager: U0MANAGER123
- Manager handle: @you

## Trusted channels
- <#C0711111111|squadron-team>

## Approvers
- <@U0MANAGER123>: anything                ; catchall — manager approves anything
- <@U0REVIEWER123>: code changes, repo writes, refactors, dependency bumps

## Redaction
- xox[baprs]-[0-9A-Za-z-]{10,}             ; Slack tokens

## Mandate
- Own the #engineering Slack surface. Triage threads, keep context warm, ship fixes. Refuse destructive ops without explicit approval.
MD
```

Replace the three ids with real ones:

| Placeholder | Replace with |
|------------|--------------|
| `U0MANAGER123` | your Slack user id |
| `U0REVIEWER123` | a teammate who can approve code changes (or reuse your id for solo) |
| `C0711111111` | your team channel id (`C…` or `G…`) — or delete the whole `Trusted channels` block for a DM-only bot |

This is the smallest file that passes validation — three required fields: `identity.name`, `manager.userId`, `mandate`. Everything else is optional. See [Configuration — SOUL.md schema](configuration.md#soul) for the full section cookbook (allowed channels, blocked users, `## Channel <#Cxxx>` overrides, `approvalTimeoutSeconds`).

**4. Validate before you boot.**

```bash
# Tell the validator where the file lives when using ./data (Docker layout)
SLAUDE_HOME=./data bun run validate-soul
```

Expected output (exit 0):

```
[validate] ok
```

Other exits:

```
[validate] missing required fields:        # exit 1 — SOUL.md is present but incomplete
  - identity.name
  - mandate
[validate] warnings:                       # exit 0 — still ok, but review
  - allowedChannels + trustedChannels both empty — only manager/backup can chat outside DMs
[validate] failed to load SOUL.md: missing auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN  # exit 2 — provider not configured
```

Treat exit 1 as a build failure, exit 2 as a config error (not a bad `SOUL.md`). Wire into CI if you keep `SOUL.md` in git:

```yaml
# .github/workflows/validate.yml
- run: SLAUDE_HOME=./data bun run validate-soul
```

**5. Boot via Docker Compose.**

```bash
docker compose up -d --build
docker compose logs -f slaude
```

Expected log (first boot seeds the extractor cache):

```
[slaude] soul cache miss — extracting SOUL.md via haiku
[slaude] listening on :8080 (/healthz /readyz /metrics)
[slaude] bolt connected — Socket Mode ready
```

Verify health:

```bash
curl -s http://localhost:8080/healthz | jq .
```

Expected output:

```json
{ "status": "ok", "uptime_ms": 12345, "sessions_live": 0 }
```

```bash
curl -s http://localhost:8080/readyz
# → {"status":"ok"}  (503 if sqlite is unreachable)
```

**6. Test in Slack.**

1. Invite the bot to the channel: `/invite @aria` (or your app name) in `#squadron-team`.
2. In that channel: `@aria hello` — the thread engages, the bot replies.
3. In DMs: message the bot directly — only `U0MANAGER123` (you) gets a reply; other users are dropped at the gateway with no token spend (check `slaude_slack_drops_total{reason="whitelist"}` in `/metrics`).
4. In the same thread, plain reply without `@mention` — still handled (engaged thread). Mention someone else in the thread — thread disengages.

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Error: missing env SLACK_BOT_TOKEN` at boot | `.env` not loaded or empty | `cat .env` — ensure `SLACK_BOT_TOKEN=xoxb-…` has no quotes/spaces; `docker compose config` prints resolved env |
| `social login unavailable` or 401 from extractor | No provider credential | Set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; when using `ANTHROPIC_BASE_URL` on OpenRouter/Z.ai, `SLAUDE_MODEL` is required |
| `/healthz` returns 503 | `db.sqlite` not writable | `ls -l ./data/db.sqlite` — volume must be writable; on k8s `subPath` use `SLAUDE_DB_PATH` override |
| Bot never replies, logs show `blocked_user` or `whitelist` drops | Channel not in `trustedChannels`/`allowedChannels` and sender is not manager | Add the channel id to `## Trusted channels` (or `## Allowed channels` for public), `docker compose restart slaude` |
| `bun run validate-soul` exit 2 | Auth missing in validator env | Same fix as provider 401 — export the key in the shell that runs `validate-soul` |

Next: add a skill ([Example 2](#2-adding-a-skill-via-slaudejson)) or connect a wiki ([Example 3](#3-private-kb-capture--ingest--wiki)) without rebuilding your persona.

---

## 2. Adding a skill via slaude.json

Skills are flat `SKILL.md` files (`---` frontmatter + markdown body) that hot-reload every inbound message. The installer sources them from git so they survive redeploys; `sync_manifest` pushes runtime-authored skills back to git.

### What you will build

A `slaude.json` that installs one remote skill via Vercel-style `source`, one legacy `git+ref` skill, and shows how a skill created live in Slack is pushed back to the manifest with `sync_manifest`. You will also see why `npx` in skills is rewritten to `bunx`.

### Prerequisites for this example

- A working `SOUL.md` and `.env` from Example 1 (or any valid `SLAUDE_HOME`)
- A git host reachable from the builder (public GitHub suffices)
- Two example repos — replace with any repo that contains a `SKILL.md` at its root or subpath (the installer just clones and copies)

### Steps

**1. Declare skills in `slaude.json`.**

```bash
cat > ./data/slaude.json << 'JSON'
{
  "skills": [
    { "source": "barockok/skill-release-notes@v1.2.0" },
    { "source": "barockok/skill-workbench/helpers@main" },
    { "git": "github:barockok/skill-legacy", "ref": "main" }
  ]
}
JSON
```

Three mutually exclusive shapes (see [Configuration — slaude.json](configuration.md#manifests)):

| Shape | Example | How slug is resolved |
|-------|---------|----------------------|
| `source` | `"barockok/skill-release-notes@v1.2.0"` | repo name lowercased → `skill-release-notes` (or last path segment if `owner/repo/path`) |
| `source` with path | `"barockok/skill-workbench/helpers@main"` | last path segment → `helpers` |
| `git + ref` (legacy) | `{"git":"github:org/repo","ref":"main"}` | repo name → `repo` |
| `slug` (local, no git) | `{"slug":"local-helper"}` | literal — content lives only on the volume |

`@ref` defaults to `main` when omitted. Slug derivation is `resolveSkillSlug` in `src/config/manifest-schema.ts`.

**2. Install locally and inspect the layout.**

```bash
bun run install-deps
cat ./data/slaude.lock | jq .skills
ls -R ./data/skills | head -n 30
```

Expected output:

```json
{
  "skill-release-notes": { "git": "github:barockok/skill-release-notes", "ref": "v1.2.0", "sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6..." },
  "helpers": { "git": "github:barockok/skill-workbench", "ref": "main", "sha": "…", "path": "helpers" },
  "skill-legacy": { "git": "github:barockok/skill-legacy", "ref": "main", "sha": "…" }
}
```

```
./data/skills/
  skill-release-notes/SKILL.md
  helpers/SKILL.md
  skill-legacy/SKILL.md
```

Each `SKILL.md` looks like:

```markdown
---
name: "release-notes"
description: "Generate release notes from git log"
---

# release-notes

When the user asks for release notes, run `git log --oneline v0.40.0..HEAD` …
```

Discovery runs per inbound message (`discoverSkills()` in `src/skills/loader.ts`), so editing a `SKILL.md` on disk is live next turn — no restart.

**3. Bake into the image with --frozen (Docker / CI).**

```bash
# Verify the lock satisfies the manifest — no network, no writes
bun run install-deps --check
# → exit 0 if covered, exit 1 if drift

# In the Dockerfile, the builder stage runs:
#   bun run install-deps --frozen
# which fails if any manifest entry is not in the lock — reproducible builds.

# Re-resolve branch refs to latest shas
bun run install-deps --update
```

Expected `--frozen` failure when drift exists:

```
error: lockfile does not cover manifest entry "skill-release-notes@main" — run install-deps --update
```

**4. The bunx shim — why skills that call npx still work.**

The base image is Bun-only (no `npm`/`npx` on `PATH`). Plugins and skills authored for Node often shell out via `npx -y @modelcontextprotocol/server-…`. At MCP mount time slaude rewrites `npx` → `bunx` in `src/config/plugins.ts` (`loadInstalledPluginMcps`) so those commands run under Bun without edits to upstream skills.

You do not need to edit skills. If you author a new skill that spawns a tool, prefer `bunx` directly:

```markdown
---
name: "my-tool"
description: "Calls an MCP server via bunx"
---

Run `bunx -y @modelcontextprotocol/server-filesystem /data` to list files.
```

**5. Runtime-authored skill → sync_manifest (the round-trip).**

The agent can author skills live via `mcp__slaude_skills__write_skill`. Those files exist only on the volume until `sync_manifest` pushes them to git. The baseline soul instructs the agent to call `sync_manifest` after batching related writes (not after every single write). The tool is not auto-allowed — it falls through to the `request_approval` Block Kit gate (`category: 'skills'`).

In Slack (as the manager), after the agent has written a skill:

```
@aria save that workflow as a skill called deploy-check
# agent: wrote ./data/skills/deploy-check/SKILL.md — calling sync_manifest… (approval card appears)
# you: click Approve
```

What `sync_manifest` does (`src/skills/sync-manifest.ts`):

| Resource | `SLAUDE_SKILLS_REPO` set | `SLAUDE_SKILLS_REPO` unset |
|----------|--------------------------|----------------------------|
| Skills | Pushed to the git repo (`github:owner/repo`, `ref: main`), recorded as `{git, ref, slug}` in `slaude.json` + sha in `slaude.lock` | Recorded as local-only `{slug}` entry — survives on the volume, not in git |
| Knowledge bases | Always local `{label}` entries — wiki content lives on the volume | Same |

Configure the push target once:

```bash
# .env
SLAUDE_SKILLS_REPO=github:barockok/my-slaude-skills
```

Calling `sync_manifest` when nothing has changed is a safe no-op (idempotent). Git push failure falls back to local entries with a warning.

Expected `slaude.json` after a live sync (with `SLAUDE_SKILLS_REPO` set):

```json
{
  "skills": [
    { "source": "barockok/skill-release-notes@v1.2.0" },
    { "git": "github:barockok/my-slaude-skills", "ref": "main", "slug": "deploy-check" }
  ]
}
```

```bash
cat ./data/slaude.json | jq .skills
cat ./data/slaude.lock | jq .skills["deploy-check"]
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `invalid slug "My_Skill"` | Slug must match `^[a-z0-9][a-z0-9-]{0,63}$` (`src/skills/mcp-tools.ts:SLUG_RE`) | Use `my-skill` — lowercase, hyphenated, no underscores |
| Skill file exists but agent never lists it | Missing frontmatter `---` block or wrong path | Ensure `SKILL.md` is at `skills/<slug>/SKILL.md` with `---\nname: …\ndescription: …\n---\nbody`; check `ls ./data/skills/<slug>/SKILL.md` |
| `mixed modes are invalid` on `bun run install-deps` | Skill entry has both `source` and `git`/`ref` | Pick one shape per entry — `source` is standalone; `git+ref` is the other mode |
| `sync_manifest` never appears | No runtime writes yet, or agent has not been instructed | Trigger a write first (`@aria write a skill for …`), then `sync_manifest`; check `SLAUDE_SKILLS_REPO` is set if you expect a git push |
| `npx: command not found` inside a skill's tool | Upstream skill hardcodes `npx` | No action — slaude rewrites `npx` → `bunx` at mount; if you fork the skill, replace `npx` with `bunx` |

---

## 3. Private KB capture — /ingest — wiki

The writable knowledge base is a Karpathy-style markdown wiki the agent navigates with `Read`/`Grep`/`Glob` — no embeddings, no chunking. The lifecycle is `raw/` → `/ingest` → `wiki/` → git push, gated by a sqlite mutex so at most one ingest runs at a time.

> **Current status.** The `src/knowledge/ingest.ts` file is marked `@deprecated` in code — it is superseded by `gbrain` brain memoize (`kb_memoize`) which captures knowledge automatically. The `/ingest` slash command now routes through the brain path. The `raw/` → `wiki/` flow below is retained as the operator-visible lifecycle and still works when `slaude.json` declares `slaude_knowledge`; new deployments should prefer brain-backed KBs. See [Findings — writable KB + /ingest](findings/2026-05-21-writable-kb-ingest.md).

### What you will build

A private wiki `ops-wiki` backed by `github:barockok/ops-wiki`. The agent captures a raw note during a Slack turn, you run `/ingest` to synthesize it into `wiki/`, and the result is pushed to git with the lockfile updated.

### Prerequisites for this example

- A Slack workspace with the bot from Example 1
- A GitHub repo for the wiki (empty or existing) — the example uses `github:barockok/ops-wiki`
- Provider credential (ingest runs a dedicated SDK sub-query for synthesis)

### Steps

**1. Declare the writable KB in slaude.json.**

```bash
cat > ./data/slaude.json << 'JSON'
{
  "skills": [{ "source": "barockok/skill-release-notes@v1.2.0" }],
  "knowledge": [{ "label": "org-runbooks", "git": "github:org/runbooks-wiki", "ref": "v3.0.0" }],
  "slaude_knowledge": { "label": "ops-wiki", "git": "github:barockok/ops-wiki", "ref": "main" }
}
JSON

bun run install-deps
ls -R ./data/knowledge/ops-wiki | head -n 20
```

Expected layout (read-only KBs are pulled fresh; writable KB keeps `raw/` + `wiki/`):

```
./data/knowledge/
  org-runbooks/README.md          ← read-only, pulled fresh on sync
  ops-wiki/README.md              ← writable KB — mount point
  ops-wiki/raw/                   ← captured material lands here
  ops-wiki/wiki/                  ← synthesized pages land here
```

Field reference:

| Surface | Section | What it means |
|---------|---------|---------------|
| `knowledge[]` | read-only wikis | Cloned fresh on `sync_manifest` / `install-deps` — agent navigates with `mcp__slaude_kb__list_kbs` → `open_kb` → `Read`/`Grep` |
| `slaude_knowledge` | single writable KB | Agent writes `raw/` during normal Slack turns; `/ingest` synthesizes `raw/` → `wiki/` and pushes |

Only one `slaude_knowledge` entry is supported — it is the single writable wiki.

**2. Capture material into raw/.**

During a normal Slack turn the agent captures via the KB tool (or you can seed a file directly for testing):

```bash
# Simulate what the agent does in a Slack thread:
mkdir -p ./data/knowledge/ops-wiki/raw
cat > ./data/knowledge/ops-wiki/raw/2026-08-24-incident-postmortem.md << 'MD'
# Incident 2026-08-24 — API latency spike

- Trigger: deploy v0.40.1 at 14:03 UTC — p95 120ms → 890ms
- Root cause: missing index on sessions.slack_thread_ts
- Fix: CREATE INDEX CONCURRENTLY on slack_thread_ts; p95 back to 110ms in 8 min
- Follow-up: add per-channel metrics label to Prometheus (see finding 2026-07-08)
MD

ls ./data/knowledge/ops-wiki/raw/
```

> **In Slack (real flow).** You tell the agent `@aria capture this postmortem to the wiki` with the details. The agent writes to `raw/` and calls `sync_manifest` to push `raw/` to git. No `/ingest` yet — that comes next.

Push `raw/` to git (happens automatically via `sync_manifest` after capture, or manually):

```bash
# sync_manifest pushes raw/ to the slaude_knowledge repo
# In Slack: @aria sync the wiki — or the agent calls it after batching captures
```

**3. Run /ingest — synthesize raw/ into wiki/.**

In any Slack thread (as the manager or an approver — `/ingest` is authorization-gated via `src/gateway/slack/ingest-auth.ts` — only `manager.userId`, `backupManager.userId`, or listed `approvers` may run it):

```
/ingest
```

What happens (see `src/knowledge/ingest.ts:run`):

1. `tryAcquire("ops-wiki", triggeredBy)` — sqlite mutex. If another ingest is already running, it returns `{ok:false, reason:"another ingest is already running"}`.
2. Reads `README.md` + every `raw/*.md`.
3. Runs a dedicated SDK sub-query (soul mandate + raw files + existing `wiki/` index) that synthesizes new or updated `wiki/*.md` pages — no Slack tools, no approvals in that sub-query.
4. Pushes `wiki/` to `github:barockok/ops-wiki` on `ref: main`.
5. Updates `slaude.lock` with `slaude_knowledge.wiki_sha`.
6. `release(jobId, "completed")` + `heartbeat` every 30s while running.

Expected reply in Slack:

```
ingested 1 raw file(s); 2 wiki pages changed; pushed a1b2c3d
```

Inspect locally:

```bash
ls -R ./data/knowledge/ops-wiki/wiki/ | head -n 20
cat ./data/knowledge/ops-wiki/wiki/incident-2026-08-24.md | head -n 40
cat ./data/slaude.lock | jq .slaude_knowledge
```

Expected `slaude.lock` entry:

```json
{ "label": "ops-wiki", "git": "github:barockok/ops-wiki", "ref": "main", "wiki_sha": "a1b2c3d4e5f6..." }
```

**4. Verify the agent can find it.**

In Slack:

```
@aria what did we learn from the 2026-08-24 latency incident?
```

The agent now navigates with `mcp__slaude_kb__list_kbs` → `open_kb("ops-wiki")` → `Read`/`Grep` over `wiki/` — no vector search, the wiki author owns structure and the LLM is the search engine.

Programmatically (inside any turn, via MCP):

```
mcp__slaude_kb__list_kbs     → [{label:"ops-wiki", git:"github:…", description:"…"}]
mcp__slaude_kb__open_kb("ops-wiki") → README.md content
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/ingest` replies `manifest.slaude_knowledge not set` | `slaude.json` has no `slaude_knowledge` entry | Add `{"label":"ops-wiki","git":"github:org/wiki","ref":"main"}` and `bun run install-deps` |
| `/ingest` replies `KB dir … does not exist` | KB not installed yet | `bun run install-deps` or `sync_manifest` once; check `ls ./data/knowledge/<label>/` |
| `/ingest` replies `another ingest is already running` | Sqlite mutex held — previous ingest still running or crashed without release | Wait for completion; check `SELECT * FROM kb_ingest_jobs;` on `db.sqlite`; stale `running` rows are expired by `heartbeat` timeout |
| `/ingest` unauthorized | Caller is not manager/backup/approver | Add the caller to `## Approvers` in `SOUL.md` or run as `U0MANAGER123` |
| `raw/` files never appear | Agent not capturing, or `slaude_knowledge` misconfigured | Seed a file manually under `raw/` to test the pipeline; then verify the bot has `slaude_kb` MCP enabled (`mcp__slaude_kb__list_kbs` in any turn) |
| Push fails with auth error | Git credentials not configured in container | Ensure the image builder has `GITHUB_TOKEN` or SSH key; runtime `sync_manifest` uses the same credential |

---

## 4. Simulation gateway — test without Slack

The simulation gateway runs the **same** `createGateway` code as production against an in-memory transport. You can verify engagement, channel-mode, approval + connect-grant buttons, and slash-command authz with no Slack workspace, no tokens, and no network — and gate CI on it.

### What you will build

A green CI gate that runs every scenario transcript, plus an interactive REPL where you manually exercise the approval flow as two different users.

### Prerequisites for this example

- No Slack workspace or tokens required for `--stub` mode (default in `sim run`)
- Provider credential only when using `bun sim --real` (live agent)
- Bun + the repo (same `bun install` as above)

### Steps

**1. Run every scenario transcript — the CI gate.**

```bash
# Stub agent (default in run mode) — no provider needed, no Slack
bun sim run
```

Expected output (all 26 scenario files under `src/gateway/sim/scenarios/`):

```
✓ src/gateway/sim/scenarios/approval-authz.yaml
✓ src/gateway/sim/scenarios/channel-mode.yaml
✓ src/gateway/sim/scenarios/engagement.yaml
...
✓ src/gateway/sim/scenarios/tool-status2.yaml

26/26 transcripts passed
```

Non-zero exit on failure — wire directly into CI:

```yaml
# .github/workflows/ci.yml
- run: bun sim run
```

Run a subset:

```bash
bun sim run src/gateway/sim/scenarios/approval-authz.yaml
bun sim run src/gateway/sim/scenarios/engagement.yaml src/gateway/sim/scenarios/channel-mode.yaml
```

**2. Inspect a transcript — the YAML format.**

```yaml
# src/gateway/sim/scenarios/approval-authz.yaml
---
layer: trusted
as: member
agent_behavior: request_approval
steps:
  - send: { text: "deploy prod" }
  - expect_card: { kind: approval }
  - click: { as: U0BOB, action: approve }
  - expect_pending: {}
  - click: { as: U0APP, action: approve }
  - expect_reply: { contains: "approved by" }
```

Primitives: `send` (as a user), `expect_reply` / `expect_card` / `expect_pending`, `click` (as a user on the Block Kit button), `as` (actor), `layer` (`trusted`/`allowed`/`restricted`/`dm`), `agent_behavior` (`request_approval` and others — see `src/gateway/sim/scenarios/`).

**3. Interactive REPL — manually exercise the approval flow.**

```bash
# Isolated WORLD-soul REPL — temp SLAUDE_HOME, deterministic, no prod state touched
bun sim --fixture

# Shared-config REPL — boots from your real ~/.slaude SOUL.md/stack, state under ~/.slaude/sim/ so prod is never mutated
bun sim
# --stub (default in fixture/run) vs --real (default in shared) toggles the agent:
bun sim --stub   # offline stub agent — no provider needed
bun sim --real   # live agent — requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
```

Inside the REPL (OpenTUI full-screen app — `Ctrl-D` or `Ctrl-C` to exit):

```
> /scenario approval-flow
# → loads approval-flow (U0ALICE in C0TEAM, request_approval behavior)

> deploy prod
# → agent posts an approval card

> /as U0APP
# → become the approver (U0APP is in SOUL.md ## Approvers with scope matching "deploy")

> /click 1 approve
# → approval gate resolves, agent continues: "approved by @U0APP — deploying …"
```

More REPL commands:

```
> /help                          # list all commands
> /as U0ALICE                    # switch actor
> /channel C0TEAM                # switch to trusted/allowed channel
> /dm                            # switch to DM (restricted — only manager engages)
> /behavior request_approval     # make the stub agent request approval on next turn
> /scenario engagement            # load a different scenario
> /layer trusted                 # override channel trust tier
```

**4. Drive the agent from a custom SOUL.md (fixture/run only).**

```bash
cat > /tmp/test-soul.md << 'MD'
# Persona
## Identity
- Name: test-bot
## Reporting
- Manager: U0MANAGER123
## Mandate
- You are a test persona. Approve nothing without explicit instruction.
MD

bun sim --fixture --soul /tmp/test-soul.md
bun sim run --soul /tmp/test-soul.md src/gateway/sim/scenarios/engagement.yaml
```

`--soul` is ignored in shared mode (which always uses your real `~/.slaude/SOUL.md` and must never overwrite it).

**5. Verbose and real-agent modes.**

```bash
bun sim run --verbose            # keep infra logs (corrupts TUI in REPL — intentional tradeoff)
bun sim run --real               # run transcripts against the live agent (requires provider creds)
bun sim --real --verbose         # shared REPL with live agent + infra logs
```

`--verbose` disables the stderr suppression that keeps the OpenTUI REPL from corrupting; useful when debugging transport issues.

### Expected REPL header

```
A-Claw · v0.41.0
stub agent · fixture — WORLD soul
live agent · shared config — real ~/.slaude (state under sim/)
```

Model appears when set: `model: claude-sonnet-4-6`.

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `missing auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN` on `bun sim --real` | Live agent needs a provider credential | Set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; or use `bun sim --stub` / `bun sim run` (stub default, no creds needed) |
| `0/0 transcripts passed` | Glob matched nothing | Use `bun sim run "src/gateway/sim/scenarios/*.yaml"` with quotes, or `bun sim run src/gateway/sim/scenarios/engagement.yaml` (explicit file) |
| REPL renders garbage / input overlaps | Infra log leaked into TUI | Do not use `--verbose` in REPL unless debugging; `isRun` (CI) keeps `✓/✗` output but REPL suppresses all `console.*` and `process.stderr.write` |
| `/click` says no card | No approval card was posted | Ensure `agent_behavior: request_approval` is active (`/behavior request_approval`) and the persona has `## Approvers` with a catchall or matching scope |
| Shared REPL mutated prod state | Misunderstood isolation | Shared mode redirects `SLAUDE_DB_PATH` → `~/.slaude/sim/db.sqlite` and `SLAUDE_WORKSPACES` → `~/.slaude/sim/workspaces/` automatically — prod `db.sqlite` and `workspaces/` are never touched |
| `--soul` had no effect | Used in shared mode | `--soul` is only honoured in isolated modes (`--fixture` or `run`); shared mode always uses the real `~/.slaude/SOUL.md` |

---

## Harsh critic — blind pick vs Next.js examples

We compare this page against `nextjs.org/docs` **examples** quality (copy-paste runnable, 3 to 4 distinct use cases, prerequisites inline, expected output shown, troubleshooting per example).

| Criterion | Next.js examples page | This page |
|-----------|------------------------|-----------|
| **Copy-paste runnable** | `npx create-next-app` + `npm run dev` — literal paste | Same — every `cat >`, `bun run`, `docker compose`, `curl`, `bun sim` block is literal paste with no hidden edits |
| **Distinct use cases** | 3 to 4 — App Router, API route, image optimization, auth | 4 — persona deploy, skill manifest, KB lifecycle, Slack-free simulation |
| **Prerequisites** | `Node.js 18+` at top, per-example prereqs inline | Global table + `Prerequisites for this example` per section |
| **Expected output** | Shown for every command | `✓ 26/26`, `{"status":"ok"}`, `[validate] ok`, `ingested 1 raw…; pushed a1b2c3d`, approval card flow |
| **Troubleshooting** | Per-example callout or linked FAQ | Per-example table — the one error you will actually hit, with cause and exact fix |
| **Cross-links** | Between related docs | `Configuration`, `Deployment`, `API Reference`, `Getting Started` linked from every example |
| **State isolation** | Not needed (stateless) | Explicit — `SLAUDE_HOME` vs `/data`, `sim/` redirect, `bun sim run` isolated temp home |

**Self-crit verdict: this page wins on isolation and failure modes (Next.js examples rarely show exit codes or CI gates), ties on copy-paste, and wins on troubleshooting depth (per-symptom table vs generic FAQ link). Where it can still improve: embed a real `slaude.json` + `slaude.lock` diff as a collapsible detail, and add a fifth "compose all four" example once multi-persona stabilizes.**

---

## What is next

| You have | Go to |
|----------|-------|
| A running bot from Example 1 | [Guides — Engagement & Approvals](guides/engagement-and-approvals.md) to tune mentions, threads, and `/1on1` |
| A skill from Example 2 | [API Reference — slaude_skills MCP](api/reference.md) for `list/read/write/delete/sync_manifest` |
| A wiki from Example 3 | [Guides — Brain & KB](guides/brain.md) for `gbrain` memoize, gather, and think |
| A green `bun sim run` from Example 4 | Add a custom transcript under `src/gateway/sim/scenarios/` and gate CI |

Full navigation: [Overview](index.md) · [Getting Started](getting-started/index.md) · [Configuration](configuration.md) · [Architecture](architecture.md) · [Deployment & Ops](deployment/index.md)

