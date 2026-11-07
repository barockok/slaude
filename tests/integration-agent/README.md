# Agent-run integration scenarios: agent platform

These files are instructions for an AI agent (with a shell, a browser driven by
Playwright, and this repository) to verify the agent platform work end to end
against a local dev stack, and to report pass or fail per step. They cover
admission and stored grants, per-persona access, permission card
authorisation, the approval audit trail, audit retention, the mandate read
model, the memory console, the console and portal pages, and the memory tool
aliases.

The design they verify is `docs/superpowers/specs/2026-11-07-agent-platform-design.md`;
the work plan is `docs/superpowers/plans/2026-11-07-agent-platform.md`.

Nothing here runs in CI. The unit and gateway tests named in each scenario
(`bun test ...`) are the fast, deterministic floor; these scenarios add the
real process, the real database, the real wire (fake Slack) and the real
browser on top.

## Who runs this and how to report

An AI agent runs one scenario file at a time, top to bottom. For every numbered
step it records what it expected, what it observed, and a verdict:

- `PASS`: the observation matches the expectation exactly.
- `FAIL`: it does not. Quote the difference.
- `BLOCKED`: the step could not be run (a prerequisite failed, a TODO in the
  file, a missing tool). Say what blocked it.

Report one markdown table per scenario, then the evidence:

```markdown
### 02-stored-grants (environment: A, sim)

| Step | Expected | Observed | Verdict |
|---|---|---|---|
| 1 | unit floor: `0 fail` | `42 pass, 0 fail` | PASS |
| 2 | `✓ .../02-member-grant-unlisted.yaml`, `1/1 transcripts passed` | `1/1 transcripts passed` | PASS |
| 3 | `drop ch=C0RANDOM user=U0BOB persona=default: not granted here` | line present | PASS |

Evidence:
- step 1: command output (last 5 lines)
- step 7: screenshot `$IT/shots/02-step7-access-tab.png`
```

Rules for evidence: paste the command and the relevant lines of its output
(not whole logs); for UI steps save a screenshot under `$IT/shots/` named
`<scenario>-step<N>-<what>.png` and give the path; for database steps paste the
query and its rows. Never paste a token, cookie value, master key or password
into the report.

At the end, add a summary line per scenario: `N PASS, N FAIL, N BLOCKED`, and
a list of every FAIL with a one-line suspected cause.

## Safety rules

- Never run any of this against a production deployment, a shared staging
  deployment, or a real Slack workspace. Every Slack id here is a placeholder
  served by the fake Slack in `e2e/fake-slack` or by the sim transport.
- Never point `SLAUDE_HOME` at a real home (`~/.slaude`). Every environment
  below uses a fresh directory under the scratch directory `$IT`. The sim's
  shared mode (`bun run sim` with no arguments) reads the real `~/.slaude`
  config: do not use it for these scenarios.
- Never use a real model key. The mock LLM ignores credentials; set
  `ANTHROPIC_API_KEY=mock-key`.
- Only placeholder ids and names: users `UMGR`, `UBACKUP`, `UAPPR`, `UOPSLEAD`,
  `UALICE`, `UBOB`, `UCAROL`, `UDAVE`; channels `CTEAM`, `COPS`, `CPUB`,
  `CRANDOM`; personas `default` and `scout`; emails `lead@example.com`,
  `alice@example.com`. The sim has its own fixed ids (below).
- Do not edit files under `src/`. If a step fails, report it; do not fix it in
  the same run.
- Clean up (each scenario's Cleanup section, then "Teardown" below).

## Prerequisites

- macOS or Linux, `bun` (the version in `package.json` `packageManager`, or
  current), `node` 22 or later (the mock LLM runs on Node, not Bun),
  `docker` (Postgres and Keycloak), `sqlite3`, `curl`, `jq`, `openssl`.
- `bun install` done in the repository.
- A browser driven by Playwright (the `playwright-cli` skill, the Playwright
  MCP, or a short `@playwright/test` script). Chromium is fine. Viewports used:
  1440x900 and 390x844, deviceScaleFactor 1.
- Shell variables used everywhere below:

```sh
export REPO="$(git rev-parse --show-toplevel)"   # run from inside the repository
export IT="${TMPDIR:-/tmp}/slaude-it-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$IT/shots"
```

## Environments, in order of preference

Each scenario says which environment it needs. Prefer the cheapest one that
covers the step.

### A. Sim gateway (no network, no model, seconds per run)

The sim (`bun run sim run <yaml>`) boots the real gateway (`createGateway`)
on an in-memory Slack transport with a stub agent, in an isolated temporary
`$SLAUDE_HOME`. Admission, drops, slash commands and approval cards run
through production code. What it cannot do: tool permission cards (the stub
agent never asks for a tool), named personas, the console, the brain.

Sim fixed ids (from `src/gateway/sim/roles.ts` and `soul-fixture.ts`): manager
`U0MGR`, backup `U0BACKUP`, approver `U0APP`, member `U0ALICE`, outsider
`U0BOB`; trusted channel `C0TEAM`, allowed `C0PUB`, unlisted `C0RANDOM`, DM
`D0SIM`; team `T0SIM`. A layer picks the channel (`dm`, `trusted`, `allowed`,
`restricted`); `as` picks the user. The stub agent replies `ack: done`
(behaviour `reply`) or posts an approval card for `deploy prod` (behaviour
`request_approval`).

Persist the sim's database so it can be seeded and inspected: `SLAUDE_DB_PATH`
is honoured in the isolated mode, and the transcripts for these scenarios are
in `tests/integration-agent/sim/`.

```sh
cd "$REPO"
export SLAUDE_BRAIN_DISABLED=1          # faster; the sim scenarios need no brain
export SLAUDE_DB_PATH="$IT/sim.sqlite"

# Creates the schema (agent_grants, audit_events, ...). Expect: 1/1 transcripts passed
bun run sim run tests/integration-agent/sim/00-bootstrap.yaml

# Helpers used by the scenarios.
NOW="CAST(strftime('%s','now') AS INTEGER)*1000"
sim_reset() {   # the sim reuses message ts values across runs: clear dedup and sessions first
  sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM seen_events; DELETE FROM sessions;"
}
sim_run() { sim_reset; bun run sim run "tests/integration-agent/sim/$1"; }
grant() {       # grant <id> <subject_kind> <subject_id> <role> <deny 0|1> <dm_only 0|1> [expires_at SQL expr]
  sqlite3 "$SLAUDE_DB_PATH" "INSERT INTO agent_grants
    (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at, expires_at, note)
    VALUES ('$1', 'default', '$2', '$3', '$4', $5, $6, 'it-agent', $NOW, ${7:-NULL}, 'integration test');"
}
```

A passing transcript prints `✓ <file>` and the run ends with
`N/N transcripts passed`; a failing one prints `✗ <file>` and the reason. The
gateway's `[slack-rx] drop ...` log lines are printed to the same output. An
admitted channel message usually also prints a second line
`[slack-rx] drop ch=... ts=... — dedup (already seen)`: the sim delivers the
mention as two events and the second is deduplicated. That line is expected.

### B. Dev stack (real process, Postgres, fake Slack, mock LLM, Keycloak)

One `mono` gateway process in Slack HTTP mode (`bun run start`), talking to
the fake Slack (`e2e/fake-slack`) instead of Slack, to the mock LLM
(`e2e/mock-llm`) instead of a model, to Postgres in Docker, with the console
and portal signed in through the Keycloak dev realm (`docker-compose.dev.yml`).
This is the only environment with real tool permission cards, named personas,
the console API and pages, and the brain.

This stack has been assembled from the code and the READMEs of its parts; the
first run of it is itself a smoke test. If a setup step fails, report the
whole scenario as BLOCKED with the failing command and its output.

Ports: gateway 8080 (panel, portal, `/slack/*`, `/metrics`), fake Slack 9091,
mock LLM 9092, Keycloak 8081, Postgres 55432.

B1. Postgres and Keycloak. Environment B uses Postgres, so first clear the
sim's database path if environment A exported it in this shell:

```sh
unset SLAUDE_DB_PATH
docker run -d --name slaude-it-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=slaude \
  -p 55432:5432 postgres:16
cd "$REPO" && docker compose -f docker-compose.dev.yml up -d keycloak
# Wait until Keycloak serves the realm (can take a minute):
until curl -fsS http://localhost:8081/realms/slaude-dev/.well-known/openid-configuration \
  | jq -e '.authorization_endpoint and .token_endpoint' >/dev/null; do sleep 3; done
```

The realm (`dev/keycloak/slaude-dev-realm.json`) has users `lead` and `alice`
(password `dev`, emails `lead@example.com` and `alice@example.com`) and
registers only the panel callback. For portal steps, add the portal callback
once (Keycloak admin user `admin`, password `admin`, from the compose file):

```sh
KC="docker compose -f $REPO/docker-compose.dev.yml exec -T keycloak /opt/keycloak/bin/kcadm.sh"
$KC config credentials --server http://localhost:8081 --realm master --user admin --password admin
CID=$($KC get clients -r slaude-dev -q clientId=slaude-panel --fields id | jq -r '.[0].id')
$KC update "clients/$CID" -r slaude-dev \
  -s 'redirectUris=["http://localhost:8080/panel/auth/callback","http://localhost:8080/portal/auth/callback"]'
```

B2. Mock LLM and fake Slack (each in its own background shell; keep the logs):

```sh
cd "$REPO"
bun build e2e/mock-llm/main.ts --target=node --outfile "$IT/mock-llm.mjs"
PORT=9092 node "$IT/mock-llm.mjs" > "$IT/mock-llm.log" 2>&1 &
PORT=9091 FAKE_SLACK_TEAM_ID=TDEV FAKE_SLACK_RETRY_DELAYS=0,1000,2000 \
  bun e2e/fake-slack/main.ts > "$IT/fake-slack.log" 2>&1 &
curl -fsS http://127.0.0.1:9091/healthz   # expect: ok
```

The mock LLM answers by tag in the user message: `[[mock:echo]] hello` makes
the agent reply `[<persona>] [[mock:echo]] hello` (the persona comes from the
`Persona-ID:` line of the soul) through the surface reply tool;
`[[mock:multi-tool n=1 tool=Bash]]` makes it call Bash once (a tool permission
card) and then answer `done after 1 tools` as plain text (which slaude does
not post as a reply: plain assistant text never reaches the thread);
`args=<base64url JSON>` sets the tool input. See `e2e/mock-llm/README.md`.
`GET http://127.0.0.1:9092/__mock/journal` lists what it was asked (a JSON
array, newest last).

B3. Fake Slack world (users, apps, channels). Every id is a placeholder:

```sh
F=http://127.0.0.1:9091/__fake
post() { curl -fsS -X POST "$F/$1" -H 'content-type: application/json' -d "$2"; echo; }
for u in UMGR:manager UBACKUP:backup UAPPR:approver UOPSLEAD:opslead UALICE:alice UBOB:bob UCAROL:carol UDAVE:dave; do
  post users "{\"id\":\"${u%%:*}\",\"name\":\"${u##*:}\"}"
done
post apps '{"apiAppId":"ADEFAULT","name":"agent","botUserId":"UAGENT","botToken":"fake-bot-default","signingSecret":"fake-signing-default"}'
post apps '{"apiAppId":"ASCOUT","name":"scout","botUserId":"USCOUT","botToken":"fake-bot-scout","signingSecret":"fake-signing-scout"}'
ALL='["UMGR","UBACKUP","UAPPR","UOPSLEAD","UALICE","UBOB","UCAROL","UDAVE","UAGENT","USCOUT"]'
for c in CTEAM:team COPS:ops CPUB:public CRANDOM:random; do
  post channels "{\"id\":\"${c%%:*}\",\"name\":\"${c##*:}\",\"members\":$ALL}"
done
for u in UMGR UBACKUP UAPPR UALICE UBOB UDAVE; do
  post channels "{\"id\":\"D$u\",\"name\":\"dm-$u\",\"isIm\":true,\"members\":[\"$u\",\"UAGENT\"]}"
done
```

DM channel ids are `D` + the user id (`DUALICE` is Alice's DM with the default
agent).

B4. Home, souls and the soul cache. The gateway would extract the structured
soul (manager, channels, approvers) with a model call; the mock LLM cannot
answer it, so the cache entry is written ahead, through the same writer, as
`e2e/harness/in-pod/seed-persona.ts` does. Every id in the structured data
must appear verbatim in the soul text (the cache grounding check).

```sh
export SLAUDE_HOME="$IT/home"
export SLAUDE_MASTER_KEY="$(openssl rand -base64 32)"   # the seed and the gateway must share it
mkdir -p "$SLAUDE_HOME/personas/scout"
cat > "$SLAUDE_HOME/SOUL.md" <<'EOF'
# SOUL

Persona-ID: default

## Identity
Integration test agent. A placeholder persona for agent-run checks.

## Mandate
Answer questions from the team about the integration test environment.

## Reporting
- Manager: <@UMGR>
- Backup manager: <@UBACKUP>

## Approvers
- <@UAPPR>: anything ; catchall

## Trusted channels
- CTEAM
- COPS

## Allowed channels
- CPUB

## DM allowlist
- <@UDAVE>

## Blocked users
- <@UCAROL>

## Approval timeout
- Auto-deny after 60 seconds

## Channel <#COPS>
### Mandate
- Watch the ops channel and summarise incidents.
### Approvers
- <@UOPSLEAD>: anything ; catchall

## Proactive
- Enabled: yes
- Watch: tracker
- Highest: ignore
EOF
printf '{"slackUserId":"USCOUT"}\n' > "$SLAUDE_HOME/personas/scout/config.json"
cat > "$SLAUDE_HOME/personas/scout/SOUL.md" <<'EOF'
# SOUL

Persona-ID: scout

## Identity
Scout, a second placeholder agent with no access settings of its own.
EOF

cat > "$IT/seed-soul.ts" <<EOF
import { loadSoul } from "$REPO/src/soul/loader.ts";
import { SoulDataSchema } from "$REPO/src/soul/data.ts";
import { writeSoulCacheEntry, soulCachePath } from "$REPO/src/soul/extract.ts";
const text = loadSoul();
const data = SoulDataSchema.parse({
  identity: { name: "Integration test agent" },
  manager: { userId: "UMGR" },
  backupManager: { userId: "UBACKUP" },
  approvers: [{ userId: "UAPPR", scope: "anything", catchall: true }],
  trustedChannels: ["CTEAM", "COPS"],
  allowedChannels: ["CPUB"],
  dmAllowedUsers: ["UDAVE"],
  blockedUsers: ["UCAROL"],
  approvalTimeoutSeconds: 60,
  mandate: "Answer questions from the team about the integration test environment.",
  channelOverrides: [{
    channel: "COPS",
    mandate: "Watch the ops channel and summarise incidents.",
    approvers: [{ userId: "UOPSLEAD", scope: "anything", catchall: true }],
  }],
});
const file = writeSoulCacheEntry(text, data);
if (!file || file !== soulCachePath(text)) { console.error("[seed-soul] cache entry not written"); process.exit(1); }
console.log("[seed-soul] wrote " + file);
process.exit(0);
EOF
bun "$IT/seed-soul.ts"     # expect: [seed-soul] wrote <path under $SLAUDE_HOME/cache>
```

The scout persona is a filesystem persona: in phase 1 it has no structured
soul of its own, so every access unit falls back to the default persona's
(spec, "Structured soul per persona"). Scenario 03 relies on that.

B5. Gateway environment and app registration:

```sh
export SLAUDE_DB=pg SLAUDE_PG_URL=postgres://postgres:dev@127.0.0.1:55432/slaude
export SLAUDE_SLACK_MODE=http SLAUDE_HTTP_PORT=8080
export SLAUDE_SLACK_API_URL=http://127.0.0.1:9091/api/
export ANTHROPIC_BASE_URL=http://127.0.0.1:9092 ANTHROPIC_API_KEY=mock-key
export SLAUDE_PANEL=1 SLAUDE_PORTAL=1
export SLAUDE_PANEL_OIDC_ISSUER=http://localhost:8081/realms/slaude-dev
export SLAUDE_PANEL_OIDC_CLIENT_ID=slaude-panel SLAUDE_PANEL_OIDC_CLIENT_SECRET=dev-secret
export SLAUDE_PANEL_PUBLIC_URL=http://localhost:8080
export SLAUDE_PANEL_SECRET='dev-secret-dev-secret-dev-secret!'
export SLAUDE_PANEL_SUPERADMIN=lead@example.com SLAUDE_PANEL_OPERATORS=alice@example.com
cd "$REPO"
bun run web:build                       # the console and portal are served from their dist folders
bun run slack-app add --api-app-id ADEFAULT --team-id TDEV --bot-token fake-bot-default \
  --signing-secret fake-signing-default --bot-user-id UAGENT --persona default
bun run slack-app add --api-app-id ASCOUT --team-id TDEV --bot-token fake-bot-scout \
  --signing-secret fake-signing-scout --bot-user-id USCOUT --persona scout
bun run start > "$IT/gateway.log" 2>&1 &
until curl -fsS http://127.0.0.1:8080/healthz >/dev/null; do sleep 1; done
grep -E '\[db\] pg|/panel control panel mounted|slack http mode started|multi-persona mode' "$IT/gateway.log"
```

Expect, in `gateway.log`: `[db] pg (bun-sql) ready`, `[persona] multi-persona mode: scout`
(or a list containing `scout`), `[slaude] /panel control panel mounted (role=mono)`,
`[slaude] slack http mode started`. The two `slack-app add` commands need the
database migrated: if they fail with a missing table, start the gateway once
first (it migrates on boot), stop it, register the apps, start it again.

Helpers for talking to the gateway through the fake Slack:

```sh
GW=http://127.0.0.1:8080
say() {   # say <app> <user> <channel> <text> [threadTs]; channel messages are sent as @mentions
  local mention=true; [[ "$3" == D* ]] && mention=false
  local thread=""; [ -n "${5:-}" ] && thread=",\"threadTs\":\"$5\""
  curl -fsS -X POST "$F/send" -H 'content-type: application/json' -d \
    "{\"app\":\"$1\",\"user\":\"$2\",\"channel\":\"$3\",\"text\":$(jq -Rn --arg t "$4" '$t'),\"target\":\"$GW\",\"mention\":$mention$thread}"
  echo
}
msgs()   { curl -fsS "$F/messages?channel=$1" | jq '.messages'; }
thread() { curl -fsS "$F/thread?channel=$1&threadTs=$2" | jq '.messages'; }
click()  {  # click <app> <user> <channel> <messageTs> <actionId>
  curl -fsS -X POST "$F/click" -H 'content-type: application/json' -d \
    "{\"app\":\"$1\",\"user\":\"$2\",\"channel\":\"$3\",\"messageTs\":\"$4\",\"actionId\":\"$5\",\"target\":\"$GW\"}"
  echo
}
ephemerals() { curl -fsS "$F/calls?method=response_url" | jq '[.calls[].detail.body]'; }
psqlq() { docker exec -i slaude-it-pg psql -U postgres -d slaude -At -F ' | ' -c "$1"; }
# The journal keeps counts, not message contents (`messages` is a number; see
# e2e/mock-llm/README.md). jmark prints the newest row's `seq`; take it just
# before the `say` that starts a multi-tool turn: M=$(jmark).
jmark() { curl -fsS http://127.0.0.1:9092/__mock/journal | jq '[.[].seq] | max // 0'; }
# toolran <mark>: how many multi-tool requests after the mark carry more
# messages than the first one did. A tool result adds messages to the next
# request, so 1 or more means the tool call came back to the model and the turn
# got past its gate. Without a mark it reads the whole journal (clear it first).
toolran() {
  curl -fsS http://127.0.0.1:9092/__mock/journal \
    | jq --argjson m "${1:-0}" '[.[] | select(.tag == "multi-tool" and .seq > $m) | .messages] as $a
        | if ($a | length) < 2 then 0 else [$a[1:][] | select(. > $a[0])] | length end'
}
```

`say` answers with the posted message's `ts` (`.message.ts`), which is the
thread for replies. Turns run on the real Claude CLI against the mock, so
replies take a few seconds: poll `thread` (or `msgs`) up to 30 s before
calling a step FAIL.

### C. Console dev stub (UI only, no gateway)

For layout, theme and navigation checks that need no real data:

```sh
cd "$REPO" && VITE_STUB=1 bun run panel:dev     # prints the local URL, normally http://localhost:5173/panel/
```

URL switches (read once at load, then kept for the tab's lifetime in
`sessionStorage`; open a new tab to change them): `?as=operator` (an operator
instead of a superadmin), `?stubEmpty=1` (no agents, grants or audit events),
`?stubFail=<text>` (500 for API paths containing the text), `?stubHang=<text>`
(never answer, so skeletons stay), `?stubDelay=<ms>`, `?stubMono=1` (no node
pools, no lock backend). Source: `src/web/console/dev/stub.ts`.

## Inspecting the database

Sim (sqlite, the file at `$SLAUDE_DB_PATH`):

```sh
sqlite3 -header "$SLAUDE_DB_PATH" "SELECT id, persona, subject_kind, subject_id, role, deny, dm_only, expires_at FROM agent_grants;"
sqlite3 -header "$SLAUDE_DB_PATH" "SELECT id, action, actor_kind, actor_id, decision, persona, target_kind, target_id, channel_id, summary, details FROM audit_events ORDER BY id;"
sqlite3 -header "$SLAUDE_DB_PATH" "SELECT id, kind, status, resolved_by, payload FROM pending_gates ORDER BY created_at;"
```

Dev stack (Postgres in Docker; `tenant_id` exists on Postgres only):

```sh
psqlq "SELECT id, tenant_id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, expires_at FROM agent_grants ORDER BY created_at;"
psqlq "SELECT id, action, actor_kind, actor_id, decision, persona, target_kind, target_id, summary, details::text FROM audit_events ORDER BY id DESC LIMIT 20;"
psqlq "SELECT id, kind, status, resolved_by, payload::text FROM pending_gates ORDER BY created_at DESC LIMIT 5;"
```

`audit_events.id` is the zero-padded epoch ms (13 digits), a dash and 12 hex
characters; it sorts by time and is the list cursor. `decision` is one of
`allow`, `always`, `deny`, `expired`, `cancelled`, `refused` or empty. Every
audit row is also printed once to the gateway's stdout as a JSON line with
`"evt":"audit"`, so `grep '"evt":"audit"' "$IT/gateway.log"` shows the same
events.

Metrics (dev stack): `curl -fsS $GW/metrics | grep -E 'slaude_(slack_drops_total|audit_write_failures_total|grants_read_failures_total)'`.

## Signing in to the console in dev

Environment B only. Open `http://localhost:8080/panel/`. Signed out, the
console redirects to `/panel/auth/login`, which redirects to Keycloak. On the
Keycloak page fill the username and password fields and submit:

- superadmin: `lead` / `dev` (`lead@example.com`)
- operator: `alice` / `dev` (`alice@example.com`)

Keycloak returns to `/panel/auth/callback` and then to the console. The
console's session cookies are `Secure`; Chromium treats `http://localhost` as
a secure context, so they work there. Use `localhost`, not `127.0.0.1`, in the
browser. To switch user, use the account menu (top right, the button labelled
`Account: <name>`) and choose `Sign out`, then sign in again; Keycloak may
remember the previous login, in which case open
`http://localhost:8081/realms/slaude-dev/protocol/openid-connect/logout` first.

Calling the console API from the signed-in page (the cookie rides along; every
mutating request needs the anti-CSRF header `x-panel-csrf: 1`):

```js
// in the page context (Playwright page.evaluate)
await fetch("/panel/api/agents/default/grants", {
  method: "POST",
  headers: { "content-type": "application/json", "x-panel-csrf": "1" },
  body: JSON.stringify({ subjectKind: "user", subjectId: "UBOB", role: "member" }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
```

The portal (`http://localhost:8080/portal/`) signs in the same way through
`/portal/auth/login`, once the portal callback is registered (B1). Its
mutating requests need `x-portal-csrf: 1`.

## Teardown

```sh
kill %1 %2 %3 2>/dev/null   # or kill the gateway, fake Slack and mock LLM by pid
docker rm -f slaude-it-pg
cd "$REPO" && docker compose -f docker-compose.dev.yml down
rm -rf "$IT"                # after the report is written and screenshots are no longer needed
```

## Scenario index

| File | Covers | Environments |
|---|---|---|
| [01-admission-default-parity.md](01-admission-default-parity.md) | No stored grants: trusted and allowed channels admit anyone; unlisted channels and DMs admit only manager, backup and the DM allowlist; blocked users drop | A, B |
| [02-stored-grants.md](02-stored-grants.md) | Member, dm-only, deny, expired and workspace grants; grant audit rows; operator 403 | A, B |
| [03-named-persona-acl.md](03-named-persona-acl.md) | A named persona's access falls back per unit; grants are per persona; admin commands by role | B, unit tests |
| [04-permission-card-authorisation.md](04-permission-card-authorisation.md) | Requester or approver decides a tool card; bystander refused; cron turn needs an approver | B, unit tests |
| [05-approval-audit-trail.md](05-approval-audit-trail.md) | Approval decided, refused, expired rows; redaction; Approvals and audit page | A, B |
| [06-audit-retention.md](06-audit-retention.md) | `SLAUDE_AUDIT_RETENTION_DAYS` purge on the housekeeping interval | A |
| [07-mandates-view.md](07-mandates-view.md) | Mandates tab against SOUL.md and cron rows; approvers | B |
| [08-memory-console.md](08-memory-console.md) | Memory stores; private stores for superadmin only; `memory.page.viewed` | B |
| [09-console-and-portal-smoke.md](09-console-and-portal-smoke.md) | Every page, light and dark, 1440 and 390 px, sign out, portal My agents | C, B |
| [10-memory-tool-aliases.md](10-memory-tool-aliases.md) | `memory_*` names and `kb_*` aliases; auto-allow alias expansion | B, unit tests (after the rebrand task lands) |
