---
title: Personas as code
description: Keep personas in a git repository and sync them to a gateway deployment from CI.
---

# Personas as code

In the gateway topology (`SLAUDE_DB=pg`, `SLAUDE_ROLE=gateway` plus nodes) a
git repository can be the source of truth for personas: souls, Slack identity,
model, user token and MCP config. A CI job posts the repository's contents to
the gateway; the gateway stores them in Postgres; replicas and nodes read them
from there. Why it works this way is in the
[field note](../field-notes/2026-10-01-personas-as-code.md).

A deployment that has never been synced keeps working from the filesystem
(`$SLAUDE_HOME/SOUL.md` and `personas/`) exactly as before. The first
successful sync makes the tenant managed; from then on the database is its
only source and the filesystem is not consulted for that tenant. Sqlite
deployments (`mono`) stay on the filesystem.

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
```

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

Set `SLAUDE_DEPLOY_TOKEN` on the gateway only, never on nodes. It is trimmed
and must be at least 32 characters after trimming. If it is unset, blank or
shorter, the `/deploy` endpoint does not exist: every path and method returns
404. It is separate from `SLAUDE_NODE_TOKEN` on purpose: every node holds the
node token, and the deploy token must not be held by anything that can run a
turn. A deploy (or preview) token equal to the node token is treated as unset,
with one warning in the gateway log. Set the `${VAR}` variables your repository references in the same
environment.

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
  "revision": "<commit sha>",
  "committedAt": "2026-10-01T09:00:00Z",
  "allowEmpty": false,
  "personas": [{ "name": "default", "soul": "...", "model": "...", "mcp": {} }]
}
```

`personas render` builds this body from the repository. The response reports
`created`, `updated`, `unchanged`, `tombstoned` and `overridesWiped`. With
`?dryRun=1` nothing is written and nothing is published, and the report is
what a real sync of the same body would produce, including how many runtime
overrides it would wipe.

Behaviour to know:

- A sync whose `committedAt` is older than the live revision is refused with
  409, before any model call. Rerunning an old CI job is safe.
- A persona removed from the repository is tombstoned, not deleted. Its Slack
  identity stops routing; the rows stay. A message mentioning it, or a reply
  in a thread that belonged to it, is dropped with a log line naming the
  persona (`[slack-rx] drop ... retired persona=<name>`). It is never answered
  by the default persona, and a session for it (for example a cron job) fails
  to boot rather than run as the default.
- An empty `personas` array is refused unless `allowEmpty: true`, which
  retires every persona (the default persona then reverts to the on-disk
  `SOUL.md`).
- Each soul is run through a strict structured extraction (a model call). If
  extraction fails the sync fails with 502 and nothing is written.
  The result is cached by soul text in `$SLAUDE_SOUL_CACHE_DIR` (default
  `$SLAUDE_HOME/cache`). On gateways point it at pod-local storage, as
  `deploy/k8s-scale` does with an `emptyDir`: `$SLAUDE_HOME` is shared with
  nodes, and a cache file written there by an agent turn could otherwise plant
  approvers. A cache hit whose Slack ids do not all appear in the soul text is
  discarded and re-extracted.
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
are printed. Export never writes a secret to the repository. It
refuses, naming the persona and server but not the value:

- an MCP `url` containing userinfo, a query string or a fragment (move the
  secret into a header first);
- a non-string `headers` or `env` value;
- two keys that would produce the same variable name;
- stdio `args` that look like a credential (`key=`, `token=`, `secret=`,
  `password=`, `bearer `, or a flag like `--api-token` followed by a value).

Other stdio `args` cannot be told apart from secrets, so export succeeds and
prints a warning listing the servers to review before you commit. A persona
directory whose name is not a valid persona name fails the export.

## Runtime overrides

For quick experiments without a commit, the panel API (`SLAUDE_PANEL=1`)
exposes:

- `GET /panel/api/personas`: git versus live per field. Any authenticated
  operator can read it. Tokens appear only as present or absent; soul text and
  model are shown.
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

## Known gaps

- **Per-persona `mcp` is stored but not yet used in the gateway topology.**
  Nodes do not mount external MCP servers from persona config, and the gateway
  runs turns only in `mono`, where personas stay on the filesystem. Syncing or
  overriding `mcp` records it and has no effect on a node's turns today. The
  runtime bundle a node fetches carries `mcpJson: null` for a managed tenant,
  so resolved header and env values never leave the gateway.
- Before relying on this in production, two verifications that need
  infrastructure were not run with the implementation: the sync's
  compare-and-set against a real Postgres, and the k8s-local cluster proof
  (`deploy/k8s-local/verify-turns.sh`).
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

The dry-run report in `report.json` can be posted to the pull request with any
comment action. `curl --fail-with-body` makes a 401, 409 (stale), 422 (invalid)
or 502 (extraction failed) fail the job and still prints the error body, which
names the variable, persona or revision at fault and never a secret value.
