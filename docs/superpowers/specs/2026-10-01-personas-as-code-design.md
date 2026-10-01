# Personas as code

**Date:** 2026-10-01
**Supersedes:** §4.2 of `2026-09-17-control-plane-and-onboarding-design.md`
**Completes:** the unfinished half of §4.3 of the same spec (nodes consuming the
runtime bundle)

## 1. Intent

An agent's identity is managed the way ArgoCD and Helm manage a workload.

The operator's own words: persona and MCP configuration live as code — json/yaml
in a repository — and the only durable way to change them is through that
repository, with a pipeline syncing it to the gateway. The gateway can also be
overridden at runtime, for a quick proof of concept, an adjustment, or onboarding
an agent fast. Nodes cannot change any of it.

Three properties follow, and the rest of this document serves them:

- **Git is the only thing that lasts.** Every sync converges the gateway back to
  the repository, discarding runtime changes — ArgoCD's `selfHeal`.
- **Runtime changes are possible and visible, but temporary.** They exist to try
  something, never to be the place something lives.
- **Nodes are read-only consumers.** They hold no write path and no credential
  that could create one.

## 2. Scope

**In:** for each persona — name, Slack user id, the `xoxp` user token, the soul
(text and its structured extraction), the per-persona `mcp.json`, and the model
default.

**Out:**

- **Skills.** Skill evolution has the agent writing `SKILL.md` files at runtime
  (`src/skills/mcp-tools.ts`), which is the same file-ownership problem that kept
  credentials out of the database in phase 3. Skills stay exactly as they are.
- **`slaude.json`.** It declares plugins, skills and knowledge bases by git ref,
  and syncing it would mean cloning and installing code at runtime — a different
  problem with a supply-chain surface. It stays build-time and gets its own
  design.
- **Multi-tenancy.** The API carries a tenant segment for forward compatibility,
  but nothing resolves a tenant other than `default` and this design does not
  change that (CLAUDE.md: "defer indefinitely").
- **A panel UI for overrides.** The API is enough to override at runtime; a UI can
  sit on it later.

### 2.1 Why the soul can move when credentials could not

The earlier assessment of this work said phase 3's tension — the agent child
owns the file at runtime — applied to `SOUL.md` too. It does not. Slaude reads
the soul itself (`loadSoul` in `src/soul/loader.ts`) and injects the text into
the SDK's `systemPrompt.append` (`src/agent/manager.ts`). The CLI child never
opens the file, so nothing on a node needs it to exist.

That puts the line where the original control-plane design drew it: **what the
agent writes stays on the volume; what it only reads is served by the gateway.**
Skills are written. Everything in scope is only read.

## 3. Decisions

| Question | Decision |
| --- | --- |
| Source of truth | The git repository. The database is the gateway's materialised copy plus a runtime layer. |
| What a sync does to an override | **Wipes it.** Every sync restores git exactly. |
| A runtime-onboarded persona at the next sync | **Tombstoned**, not deleted. |
| Who initiates a sync | **The pipeline pushes.** The gateway never holds git credentials. |
| How desired state and overrides are stored | **Two layers** — a desired layer written only by sync, an override layer written only at runtime. |
| Secrets in the repository | **Never.** `${VAR}` placeholders, resolved from the gateway's environment at sync. |
| What a sync carries | **The whole set**, never a patch. "Absent" must mean absent for pruning to work. |

## 4. Data model

The `personas` table is Postgres-only — sqlite has no such table. This is
therefore a feature of the gateway topology. `mono` on sqlite keeps reading the
filesystem and is unchanged.

**`personas` — the desired layer.** Written by sync, and by a runtime onboard
for `origin = 'runtime'` rows only; a runtime write never touches a `git` row. The
existing table (`0001_tenancy.sql`) gains:

| Column | Purpose |
| --- | --- |
| `slack_user_id` | The persona's Slack identity. |
| `user_token` | The `xoxp` token, AES-256-GCM via `src/db/crypto.ts`. Plaintext in `config.json` today. |
| `origin` | `'git'` or `'runtime'`. |
| `source_revision` | The git sha that last wrote the row. |
| `tombstoned_at` | Set when a sync omits the persona; cleared when one re-adds it. |

**`persona_overrides` — the runtime layer.** New. One row per overridden field:
`(tenant_id, persona_name, field, value, set_by, set_at)`, primary key
`(tenant_id, persona_name, field)`. Values that may hold secrets — `mcp`, whose
headers can — are encrypted like the desired layer. A `soul` override stores the
text and its structured extraction together, so the two can never disagree.

**`persona_sync_state` — one row per tenant.** New. The live `revision`, its
`committed_at`, `synced_at`, the identity that synced, and an `override_version`
counter bumped by every override write.

**Effective state** is the desired row with any override rows laid over it. One
function computes it, and nothing else reads either layer directly — that
function is the seam the gateway, the runtime bundle and the panel API all go
through.

### 4.1 A sync, in one transaction

1. Compare-and-set on `persona_sync_state`: proceed only if the payload's
   `committedAt` is not older than the live one.
2. Upsert every persona in the payload into `personas`, setting
   `source_revision` and clearing `tombstoned_at`.
3. Tombstone every persona the payload omits — including runtime-origin ones.
4. Delete every override row for the tenant.
5. Record the new revision and reset `override_version`.

### 4.2 Tombstones

A tombstoned persona takes no new work: inbound events to its Slack identity are
dropped with a log line, its cron jobs do not fire, and turns already running
finish. Its rows — sessions, cron jobs, `mcp_credentials` owned by it — are left
alone, so re-adding the persona in git restores it whole. Deleting instead would
let one merge silently drop someone's in-flight conversation and orphan the
agent's own credentials.

## 5. Surface

### 5.1 Sync — deploy token only

```
POST /deploy/v1/tenants/:tenant/personas[?dryRun=1]
Authorization: Bearer <SLAUDE_DEPLOY_TOKEN>
```

A separate prefix and a separate token from `/v1`, because `/v1` authenticates
with `SLAUDE_NODE_TOKEN` and **every node holds that token**. Sharing either the
prefix or the token would leave nodes one misrouted handler away from rewriting
identity. With no deploy token configured the endpoint returns 404. The token is
compared in constant time.

```json
{
  "revision": "<git sha>",
  "committedAt": "<ISO 8601>",
  "allowEmpty": false,
  "personas": [
    {
      "name": "ana",
      "slackUserId": "UTESTUSER1",
      "userToken": "${ANA_XOXP}",
      "model": "<model id>",
      "soul": "<SOUL.md text>",
      "mcp": { "mcpServers": { } }
    }
  ]
}
```

A successful response reports what happened: created, updated, unchanged,
tombstoned, and overrides wiped.

**`dryRun=1`** computes that same report and applies nothing. It is ArgoCD's
diff: CI can post it on the pull request, so a merge that prunes an agent or
discards a live override is visible before it lands.

### 5.2 Repository layout and the render CLI

The repository mirrors today's directory, so moving an existing deployment is a
copy. The default persona — today `$SLAUDE_HOME/SOUL.md` — is `personas/default/`,
and is the one persona that may omit `slackUserId`, because it speaks as the bot
itself:

```
personas/
  <name>/
    persona.yaml     # slackUserId, userToken: ${VAR}, model
    SOUL.md
    mcp.json
```

- **`slaude personas render <dir>`** produces the sync payload and runs the same
  validation the gateway does. CI calls it, so a malformed file fails the pull
  request, not the deploy. `--check` validates without printing.
- **`slaude personas export [--out <dir>]`** writes an existing
  `$SLAUDE_HOME/personas` out in repository layout, replacing any token found in
  `config.json` with a `${VAR}` placeholder and listing the variables it
  introduced. Seeding a repository from a running deployment is one command and
  never puts a secret in git.

### 5.3 Runtime overrides — panel superadmin only

```
GET    /panel/api/personas
PUT    /panel/api/personas/:name/overrides/:field
DELETE /panel/api/personas/:name/overrides/:field
POST   /panel/api/personas
```

- **`GET`** returns effective state and, per field, the git value, the live
  value, and whether it is overridden — plus the live revision. Tokens are
  reported as present or absent, never returned.
- **`PUT` / `DELETE`** an override. Overridable fields are `soul`, `model` and
  `mcp` only. Repointing an existing persona's `slackUserId` at runtime would
  change whose identity it speaks as; that goes through git.
- **`POST`** onboards a runtime-origin persona with every field, identity
  included. It is tombstoned at the next sync unless it has been added to git.

Two refusals keep the runtime layer consistent with §6.1:

- **Runtime writes require a tenant that has been synced at least once** (409
  otherwise). On a filesystem-mode tenant, an onboard would flip it to the
  database holding only the new persona, and every filesystem persona would
  vanish. Runtime changes are a layer over git, so there must be a git layer.
- **A runtime onboard may not take a name that git already uses** (409). Doing so
  would shadow a managed persona until the next sync silently reverted it.

Superadmin rather than operator, matching `/panel/api/reload`: an override acts
on the whole fleet. Every mutating route keeps the panel's existing anti-CSRF
check.

## 6. Read path

### 6.1 One source per tenant, never a merge

- A tenant that has **never been synced** reads the filesystem exactly as today.
  There is no flag and no migration step: existing deployments are unaffected
  until they run a pipeline.
- **The first successful sync flips the tenant to the database.** From then on
  the filesystem is ignored for every field in scope.

The two are deliberately never merged field by field. "Which source won for this
field" is not a question anyone should have to answer while debugging.

### 6.2 Gateway

`src/persona/registry.ts` stops being a process-memoised filesystem map and
becomes the effective-state read, behind an in-process cache. Routing, the
outbound Slack client and soul injection all go through it, unchanged in shape.

### 6.3 Nodes

The runtime bundle already carries the soul, the structured soul, MCP
configuration and the model (`src/gateway/api/tenants.ts`), and nodes ignore all
of it, reading the shared volume instead (`src/node/main.ts`). They switch to
the bundle, which the gateway builds from effective state. Nodes never read
either layer directly and have no write path to any of it.

**The `xoxp` token is not in the bundle.** No node code uses the outbound client
the token builds — posting goes through the gateway — so, as with phase 3's
access-token-only projection, it never leaves the gateway.

### 6.4 Propagation

A committed sync or override publishes the existing reload signal.

The bundle's entity tag is derived from **effective** state — the live revision
and `override_version` — not from the desired layer alone. Otherwise an override
leaves the tag unchanged, nodes revalidate, receive a not-modified, and keep the
old soul.

The soul is assembled into the system prompt when a session **boots**, not on
every turn, so clearing a node's bundle cache alone changes nothing for a warm
session. A thread could keep its old soul indefinitely. On the reload signal a
node therefore also reloads every live session for that tenant, using the same
`AgentManager.reload` the gateway already uses after an MCP connect. A turn
already running finishes on the soul it started with, and the next turn boots on
the new one. There is no mid-turn swap.

A node that misses the signal keeps a warm session's old soul until that session
next boots. Bundle fetches revalidate by entity tag, but a warm session does not
fetch. This is a known bound, not a defect: it is limited by session lifetime,
and the gateway-side registry has no equivalent gap (§7.3).

## 7. Failure modes

### 7.1 A sync applies completely or not at all

It runs in two phases so that the transaction stays short:

1. **Outside the transaction:** validate, resolve `${VAR}` placeholders, and
   extract the structured soul. Extraction calls a model
   (`src/soul/extract.ts`), so it runs only for souls whose sha has changed — an
   unchanged soul never costs a model call — and never while database locks are
   held.
2. **Inside one short transaction:** §4.1.

| Failure | Response |
| --- | --- |
| Unresolved `${VAR}` | **422**, naming the variable and never a value. No persona is stored with an empty token. |
| Soul extraction fails | **502**. Nothing applied; the previous revision stays live. |
| Invalid persona file | **422**. `render` should already have caught it in CI. |
| `committedAt` older than live | **409**, reporting the live revision. |
| Empty persona set without `allowEmpty` | **422**. An empty list is far likelier a broken render than an intent to retire every agent. |

### 7.2 Concurrency and retries

Two pipeline runs at once are serialised by the compare-and-set in §4.1 step 1.
Checking first and writing second would let both pass; the check and the write
are one statement, the same shape as `claimDue` in the cron scheduler.

A resent revision is accepted and **does** wipe overrides. A sync means
"converge to git", and converging twice is still converging. This is stated
explicitly because a CI retry will do exactly that.

### 7.3 Replicas and lost signals

A sync lands on one gateway replica; the others hear of it through the reload
signal. Correctness cannot depend on that signal arriving. Each cached lookup
revalidates against a cheap state version — the live revision and
`override_version`, one indexed read — so the signal only makes convergence
faster. A dropped message delays an update; it never leaves a replica serving a
stale identity indefinitely.

### 7.4 Overrides

Overriding `soul` runs extraction at override time; a failure refuses the
override.

## 8. Acceptance criteria

Each load-bearing claim names a mutation that must make its test fail, and the
headline claim is proven on the real cluster. Both rules come from this week: a
cross-replica test passed against a module-level `Map` because two gateways in
one process share state, and a harness reported an unreachable pod as a
delivery failure.

1. A sync makes effective state equal the payload, with variables resolved and
   souls extracted.
2. An override followed by a sync leaves no override.
3. A runtime-onboarded persona is tombstoned by the next sync; its sessions, cron
   jobs and credentials are untouched; re-adding it in git restores it whole.
4. The node token cannot reach the sync endpoint, and the deploy token cannot
   reach `/v1`. Tested in both directions.
5. An older `committedAt` returns 409. Two concurrent syncs: exactly one wins.
   *Mutation: split the check from the write.*
6. An unresolved variable returns 422 naming it; nothing is applied; its value
   appears in no response and no log.
7. An extraction failure applies nothing and leaves the previous revision live.
8. An empty persona set is refused without `allowEmpty`. *Mutation: remove the
   guard.*
9. A never-synced tenant reads the filesystem; the first sync flips it; no field
   ever mixes the two sources.
10. **Nodes run turns with the persona directory deleted from the shared
    volume**, on the k8s-local cluster.
11. The `xoxp` token is absent from the runtime bundle.
12. An override alone changes the bundle's entity tag. *Mutation: derive the tag
    from the desired layer only.*
13. A gateway replica that never receives the reload signal still converges.
14. `dryRun` applies nothing and reports what would be tombstoned and which
    overrides would be wiped.
15. `mono` on sqlite behaves exactly as before.
16. `export` followed by `render` reproduces the same payload, and `export`
    writes no secret.
17. A runtime write to a never-synced tenant is refused, and the tenant's
    filesystem personas keep working.
18. A runtime onboard using a name git already manages is refused.

## 9. Testing layers

- **Unit:** the effective-state merge.
- **Repository:** Postgres and PGLite — the table is Postgres-only, so there is
  no sqlite leg for it.
- **API:** the sync endpoint and the panel override routes, including both token
  separations.
- **CLI:** the `export` → `render` round trip.
- **Cluster:** an extension to `deploy/k8s-local/verify-ha.sh` that removes a
  persona's directory from the shared volume and runs a turn for it.

## 10. Notes for the plan

- The migration is `0011`; `0010` arrives with the paste-back connect-flow fix.
- `SLAUDE_DEPLOY_TOKEN` is new. The gateway does not require it to boot — without
  it the sync endpoint is simply absent — so deployments not using a pipeline are
  unaffected.
- The registry's consumers are `src/server.ts`, `src/agent/manager.ts`,
  `src/node/main.ts`, `src/gateway/core/config-reload.ts`,
  `src/gateway/core/gateway.ts` and `src/gateway/api/tenants.ts`.
