---
title: Personas as code
description: Keep personas in a git repository and sync them to a gateway deployment from CI.
---

# Personas as code

On Postgres (`SLAUDE_DB=pg`, a real server or PGLite) a git repository can be
the source of truth for personas: souls, Slack identity, model, user token and
MCP config. A CI job posts the repository's contents to the gateway; the
gateway stores them in Postgres; replicas and nodes read them from there. This
works in the gateway topology (`SLAUDE_ROLE=gateway` plus nodes); the
`/deploy` endpoint exists only there. A single `mono` process on Postgres or
PGLite can also hold managed personas, but it is managed through the panel, not
`/deploy` (see [Trust boundary](#trust-boundary)). Why it works this way is in the
[field note](../field-notes/2026-10-01-personas-as-code.md).

A deployment that has never been synced keeps working from the filesystem
(`$SLAUDE_HOME/SOUL.md` and `personas/`) exactly as before. The first
successful sync makes the tenant managed; from then on the database is its
only source for every persona field. Two operator-level files stay as
fallbacks for the *default* persona only, never merged with a managed value:
the global `.mcp.json` when the default persona's synced `mcp` is empty, and
`$SLAUDE_HOME/SOUL.md` after an `allowEmpty` retirement in `mono` (see below).
A per-persona directory (`personas/<name>/`) is never read for a managed
tenant. Sqlite deployments stay on the filesystem: `/deploy` and the panel's
persona routes answer 409 `persona sync requires Postgres` there.

## Repository layout

```
personas/
  default/             required: a non-empty sync must include it
    SOUL.md
    mcp.json           optional
  support-bot/         directory name = persona name, ^[a-z0-9][a-z0-9-]{0,62}$
    persona.yaml
    SOUL.md
    mcp.json           optional
```

`persona.yaml` (every key optional except `slackUserId` for a named persona):

```yaml
slackUserId: "UTESTUSER1"
model: "provider/model-name"
userToken: "${PERSONA_SUPPORT_BOT_XOXP}"
provider:                       # optional: this persona's own LLM credentials
  baseUrl: "https://llm.example.com"
  apiKey: "vault://secret/slaude/personas/support-bot#api_key"
kbSources:                      # optional: the knowledge bases it may read
  - kb-runbook
runsOn: "engineering"           # optional: the node label this persona runs on
```

`kbSources` lists the `kb-<label>` knowledge-base sources the persona may read.
Absent means every installed knowledge base; `[]` means none. It filters
retrieval and is not isolation. See [Knowledge scope](knowledge-scope.md).

`runsOn` names the node label whose nodes run this persona's turns: lower-case
letters, digits and `-`, at most 32 characters (`^[a-z0-9][a-z0-9-]{0,31}$`).
Absent means `default`, the label every unlabelled node and every legacy node
carries; filesystem and sqlite personas are always `default`. It is set in git
only: it is not a runtime override, so the panel cannot change where an agent
runs. A sync that names a label no live node carries is applied anyway and
reported as a warning in `warnings` (`no live node carries label '<label>'`):
the persona's turns wait on that label's queue until a node with the label
starts. `export` writes `runsOn` only when the persona's `config.json` already
has it.

`provider` holds references (`vault://…#field` or `env://PERSONA_*`), never a
credential; `baseUrl` may also be a literal `https` URL, and needs a credential
reference beside it. The set is atomic: a persona that sets `provider` never
receives a key from anywhere else. The gateway resolves them when it builds the
persona's runtime bundle. See
[Provider credentials](provider-credentials.md). A persona that sets
`provider.baseUrl` without `model`, or a named persona with no `model`, gets a
sync warning. `export` never writes `provider` (filesystem personas have
none); add it to `persona.yaml` by hand.

`personas/default/` is required. A sync without it is refused with 422,
because the default persona's soul would otherwise have to come from disk,
which would mix two sources. The default persona needs no `slackUserId`.

## Placeholders

`${VAR}` is resolved by the gateway from its own environment at sync time, in
`userToken` and in `mcp` (any string, at any depth). It is not resolved in soul
text, which is content and may document a template. Names must be UPPER_CASE
(`[A-Z0-9_]`) and start with `PERSONA_`. Any other name, for example
`${SLAUDE_MASTER_KEY}`, is a 422 naming the variable: the gateway's environment
also holds its own secrets, and a persona repository must not be able to copy
one into a stored persona. An unset or empty variable fails the sync, and any
other `${...}` in those fields (for example `${lower}`) is a 422 naming the
field, never the value. Secrets therefore live in the gateway's environment,
never in git. `render --check` applies the same rules.

## Gateway setup

Set `SLAUDE_DEPLOY_TOKEN` on the gateway only, never on nodes and never on a
`mono` process (`/deploy` is not mounted there). It is trimmed
and must be at least 32 characters after trimming. If it is unset, blank or
shorter, the `/deploy` endpoint does not exist: every path and method returns
404. It is separate from `SLAUDE_NODE_TOKEN` on purpose: every node holds the
node token, and the deploy token must not be held by anything that can run a
turn. A deploy (or preview) token equal to the node token is treated as unset,
with one warning in the gateway log.

Set the `PERSONA_*` variables your repository references in the same
environment: the gateway's. Never put them in an environment file that nodes
also load: a node does not need them, and every node runs agent turns.

### Trust boundary

The guarantee that a turn cannot call `/deploy` or read another persona's
token holds for the gateway topology only. There the agent runs on a node, a
separate process that never held those values. Every SDK child slaude starts
(the agent turn, the ingest pass and the `kb_think` synthesis) is also started
without `SLAUDE_DEPLOY_TOKEN`, `SLAUDE_DEPLOY_PREVIEW_TOKEN`, any `PERSONA_*`
variable, `SLAUDE_MASTER_KEY`, `SLAUDE_NODE_TOKEN` or `SLAUDE_JOB_SECRET`, as
defence in depth.

In `mono` the agent child runs as the same OS user as the slaude process and is
its descendant, so it can read that process's environment (for example
`/proc/<pid>/environ`) whatever the scrub does. `mono` is therefore one trust
domain, as it already was: it kept each persona's user token on its own disk.
So `/deploy` is gateway-only, and `PERSONA_*` and the deploy tokens belong on
gateways only. A `mono` deployment is still manageable through the panel, which
uses an OIDC superadmin session rather than an environment credential.

For pull-request jobs, also set `SLAUDE_DEPLOY_PREVIEW_TOKEN` (same trim and
32-character floor, and it must differ from the deploy token or it counts as
unset). It is accepted only with `?dryRun=1`; presented on an apply it gets the
same 401 as a wrong token. A PR workflow can run on unreviewed code, so it must
never hold a credential that can apply. The deploy token still works for both.
A dry run makes no model call: it reports what would change without extracting
any soul.

## The endpoint

```
POST /deploy/v1/tenants/<tenant>/personas[?dryRun=1]
Authorization: Bearer <SLAUDE_DEPLOY_TOKEN, or SLAUDE_DEPLOY_PREVIEW_TOKEN with dryRun=1>
```

The tenant is `default` for a single-workspace deployment; it must match
`^[a-z0-9][a-z0-9-]{0,62}$` or the route is 404. Body:

```json
{
  "version": 1,
  "revision": "<commit sha>",
  "committedAt": "2026-10-01T09:00:00Z",
  "allowEmpty": false,
  "personas": [{ "name": "default", "soul": "...", "model": "...", "mcp": {} }]
}
```

The body is capped at 4 MiB; a larger one is 413 and nothing is applied.
`personas render` builds this body from the repository. The response reports
`created`, `updated`, `unchanged`, `tombstoned`, `overridesWiped`,
`ignoredFields` and `warnings` (provider/model pairing, a `runsOn` label no
live node carries, and `kbSources` ids that match no installed knowledge base,
by persona name).
Migrations 0014 (`personas.provider_json`), 0016 (`personas.runs_on`) and 0017
(`personas.kb_sources`) apply at boot by default. With `SLAUDE_MIGRATE_ON_BOOT=0`
and a migration not applied, a gateway whose tenant is already managed fails at
boot with a database error about the missing column; one whose tenant is not
managed yet refuses its first sync with 503 naming the migration. With
`?dryRun=1` nothing is written and nothing is published, and the report is
what a real sync of the same body would produce, including how many runtime
overrides it would wipe.

Behaviour to know:

- `version` is the payload format; absent means 1, and `personas render` always
  writes the highest version any field needs: 3 when any persona sets
  `kbSources`, else 2 when any persona sets `provider` or `runsOn`, otherwise 1.
  A payload without those fields still deploys to an older gateway, and one
  with them is refused by a gateway that would ignore them. A payload whose `version` is newer than the gateway supports is
  refused with 422 before anything is applied: upgrade the gateway first.
- A field the gateway does not know (at the top level or on a persona) is
  ignored, never stored, and listed in `ignoredFields` as `futureKnob` or
  `persona.<name>.<field>`. The gateway also logs a warning naming the fields.
  Only names are reported, never values. Set `SLAUDE_DEPLOY_STRICT=1` on the
  gateway to make an unknown field a 422 instead; it is off by default so a
  pipeline can be upgraded ahead of its gateway. `personas render --check`
  reports unknown `persona.yaml` keys on stderr.

- A sync whose `committedAt` is older than the live revision is refused with
  409, before any model call. Rerunning an old CI job is safe.
- A persona removed from the repository is tombstoned, not deleted. Its Slack
  identity stops routing; the rows stay. A message mentioning it, or a reply
  in a thread that belonged to it, is dropped with a log line naming the
  persona (`[slack-rx] drop ... retired persona=<name>`). It is never answered
  by the default persona: a warm session of it is closed when the registry
  reloads (its in-flight turn is aborted), a new session for it fails to boot,
  and each of its cron jobs skips its occurrences while the persona is retired
  (`last_result: skipped: persona not live`). The jobs are not paused:
  re-adding the persona in git brings them back by themselves at their next
  due time. Anything that still asks for it — a Slack client, a brain-slice
  gate — is refused rather than given the default persona's.
- An empty `personas` array is refused unless `allowEmpty: true`, which
  retires every persona, `default` included. What happens next depends on the
  topology. In `mono` the default persona reverts to the on-disk `SOUL.md` and
  keeps answering. In the gateway topology **every turn stops, the default
  persona's included**: the tenant is still managed and has no live persona,
  so a node's runtime bundle request is 404 and no turn can boot. Sync a set
  that includes `default` to recover.
- Each soul is run through a strict structured extraction (a model call). If
  extraction fails the sync fails with 502 and nothing is written. A dry run
  skips extraction.
  The result is cached by soul text in `$SLAUDE_SOUL_CACHE_DIR` (default
  `$SLAUDE_HOME/cache`). On gateways point it at pod-local storage, as
  `deploy/k8s-scale` does with an `emptyDir`: `$SLAUDE_HOME` is shared with
  nodes, and a cache file written there by an agent turn could otherwise plant
  approvers. `docker-compose.scale.yaml` gives the gateway a `tmpfs` for it. A
  cache hit whose Slack ids do not all appear in the soul text is discarded and
  re-extracted, and when `SLAUDE_MASTER_KEY` is set (it is on every gateway)
  each entry is signed with a key derived from it, over the soul text's full
  sha256 and the extracted data, so an unsigned or altered entry is also a
  miss.
- Every sync wipes all runtime overrides for the tenant.

## Validate on pull requests

```sh
bun run personas render ./ --check
```

`render <dir>` prints the payload; `--check` prints nothing and exits non-zero
on any problem. It runs the same validation the gateway does, including
placeholder syntax, with every variable assumed set. Use `--revision <sha>` and
`--committed-at <iso>` to override the defaults (`GITHUB_SHA` and now). The flags
can come before or after the directory.

## Exporting a running deployment into a repository

```sh
bun run personas export --out ./persona-repo
```

Reads `$SLAUDE_HOME` and writes the layout above. User tokens become
`${PERSONA_<NAME>_XOXP}` and every MCP header or env value that is not already a
`${PERSONA_...}` placeholder becomes `${PERSONA_<NAME>_<SERVER>_<KEY>}`
(upper-cased, other characters as `_`); the variable names to set on the gateway
are printed. Export accepts only the MCP shapes it knows how to make safe, and
refuses or flags everything else. It refuses, naming the persona, server and
key but never the value:

- any key it does not know: at the top level anything but `mcpServers` and
  `privateServices`, in a server anything but `type`, `url`, `command`, `args`,
  `headers` and `env` (for example `apiKey` or an `oauth` block). Move such a
  value into `headers` or `env` first;
- `headers` or `env` that is not an object, a non-string value inside one, or
  `args` that is not a list;
- an MCP `url` containing userinfo, a query string or a fragment (move the
  secret into a header first);
- a token shape in a `url` path, the `command` string or any arg: a Slack or
  GitHub token prefix, an `sk-` key, an AWS access key id, `Bearer`, a JWT, or
  any run of 32 or more letters, digits, `_` or `-`. In `command` and `args`
  also `key=`, `token=`, `secret=`, `password=`, `passwd=`, or a flag like
  `--api-token` followed by a value;
- two keys that would produce the same variable name.

A harmless value can match a token shape (a long path segment, for example);
edit it before exporting. Other stdio `args` cannot be told apart from
secrets, so export succeeds and prints a warning listing the servers to review
before you commit. A persona directory whose name is not a valid persona name
fails the export.

## Runtime overrides

For quick experiments without a commit, the panel API (`SLAUDE_PANEL=1`)
exposes the routes below. They always act on the tenant `default`.

- `GET /panel/api/personas`: git versus live per field, for every persona
  including tombstoned ones (each entry says `tombstoned: true|false`). Any
  authenticated operator can read it. Tokens appear only as present or absent;
  soul text and model are shown, plus `runsOn` and a `kb.mode` summary
  (`all`, `none` or `list`).
- `GET /panel/api/personas/<name>`: one persona's definition, references and
  presence only (see [the control panel's persona page](panel.md)). Any
  authenticated operator; `404` for an unknown name.
- `PUT /panel/api/personas/<name>/overrides/<field>` with `{ "value": ... }`
  and `DELETE` of the same path. Superadmin only. `<field>` is `soul`, `model`
  or `mcp`; nothing else can be overridden.
- `POST /panel/api/personas`: onboard a persona that is not in git (body:
  `name`, `soul`, `slackUserId`, optional `model`, `userToken`, `mcp`).
  Superadmin only.

Constraints: all of these are refused with 409 before the tenant's first sync.
An override on a persona that does not exist is 404. A runtime `mcp` (override
or onboard) may contain only HTTP servers (`type: "http"`, a `url`, optional
`headers`); a server with `command` or `args`, or any other type, is 422. A
persona onboarded this way is not in git, and the next sync tombstones it unless
you add it to the repository. The next sync also wipes every override: git
wins.

## Model

A persona's `model` (from git, or a runtime override) is the default model of
its sessions. The order is:

1. a per-thread choice: `/model <id>` in the thread, or the panel's session
   model;
2. the persona's effective model;
3. `SLAUDE_MODEL`.

On a managed tenant a new session follows its persona's model, and picks up a
changed one the next time it boots. On a node a sync or override reloads warm
sessions after their turn in flight; in `mono` a warm session keeps its model
(and soul) until it idles out or is reloaded.
Sessions created before the tenant was managed, or before this behaviour
existed, keep the model they were created with until `/model` changes it.

## Known gaps

- **Connectable and mounted MCP servers can differ.** The `/mcp connect` list
  and the portal integrations list still read the global `.mcp.json` for a
  managed persona, while the persona's turns mount its synced `mcp`.
- **Export does not catch every token in an MCP URL.** It does not detect a
  token in a URL's host, or in a URL path segment shorter than 32 characters.
  Review MCP URLs before committing an export.
- **Per-persona `mcp` is not consumed on nodes.** In `mono` on Postgres a
  managed persona's external MCP servers come from its effective `mcp`
  (nothing when it has none; the default persona falls back to the global
  `.mcp.json`). Nodes do not mount external MCP servers from persona config:
  syncing or overriding `mcp` records it and has no effect on a node's turns.
  The runtime bundle a node fetches always carries `mcpJson: null`, for every
  tenant, so resolved header and env values never leave the gateway.
- **In `mono`, a named persona's channel mandate is the default persona's.**
  Nodes take each persona's channel mandate from its own structured soul; the
  `mono` process still uses the default persona's channel overrides for every
  persona.
- **Required before merge, not yet run:** the sync's compare-and-set against a
  real Postgres, and the k8s-local cluster proof
  (`deploy/k8s-local/verify-ha.sh`, the "personas as code" section, including
  its warm-session soul-change step).
- The existing `/v1` node token is not trimmed or length-checked the way the
  deploy token is. Use a long random value.

## Complete CI example (GitHub Actions)

Dry run on pull requests with the preview token; apply on push to `main` with
the deploy token, from a job bound to a protected GitHub Environment. Store the
gateway URL as a repository variable `GATEWAY_URL`, the preview token as a
repository secret `DEPLOY_PREVIEW_TOKEN`, and the deploy token as a secret
`DEPLOY_TOKEN` of an environment named `personas-production` (Settings →
Environments) that allows only the `main` branch and requires a reviewer. A
pull request's workflow is taken from the pull request's own branch, so whatever
it can read, an unreviewed change can use; an environment secret is released
only to a job that the environment's rules allow.

```yaml
name: personas
on:
  pull_request:
    paths: ["personas/**"]
  push:
    branches: [main]
    paths: ["personas/**"]

jobs:
  preview:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: git clone --depth 1 https://github.com/example-org/slaude.git /tmp/slaude && cd /tmp/slaude && bun install
      - name: Validate
        run: bun /tmp/slaude/src/cli/personas.ts render . --check
      - name: Render
        run: |
          bun /tmp/slaude/src/cli/personas.ts render . \
            --revision "${{ github.sha }}" \
            --committed-at "$(git log -1 --format=%cI)" > payload.json
      - name: Dry run
        run: |
          curl --fail-with-body -sS -X POST "${{ vars.GATEWAY_URL }}/deploy/v1/tenants/default/personas?dryRun=1" \
            -H "Authorization: Bearer ${{ secrets.DEPLOY_PREVIEW_TOKEN }}" \
            -H "Content-Type: application/json" \
            --data @payload.json | tee report.json

  apply:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: personas-production
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: git clone --depth 1 https://github.com/example-org/slaude.git /tmp/slaude && cd /tmp/slaude && bun install
      - name: Render
        run: |
          bun /tmp/slaude/src/cli/personas.ts render . \
            --revision "${{ github.sha }}" \
            --committed-at "$(git log -1 --format=%cI)" > payload.json
      - name: Apply
        run: |
          curl --fail-with-body -sS -X POST "${{ vars.GATEWAY_URL }}/deploy/v1/tenants/default/personas" \
            -H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}" \
            -H "Content-Type: application/json" \
            --data @payload.json
```

Pull requests from forks receive no repository secrets, so their dry run sends
an empty bearer and gets 401; run the preview from a branch in the repository,
or treat the fork's `render --check` as the gate. The dry-run report in
`report.json` can be posted to the pull request with any comment action. `curl --fail-with-body` makes a 401, 409 (stale), 422 (invalid)
or 502 (extraction failed) fail the job and still prints the error body, which
names the variable, persona or revision at fault and never a secret value.
