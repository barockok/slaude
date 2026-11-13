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
(`$SLAUDE_HOME/agent.yaml` and `personas/`) exactly as before. The first
successful sync makes the tenant managed; from then on the database is its
only source for every persona field. Two operator-level files stay as
fallbacks for the *default* persona only, never merged with a managed value:
the global `.mcp.json` when the default persona's synced `mcp` is empty, and
`$SLAUDE_HOME/agent.yaml` after an `allowEmpty` retirement in `mono` (see below).
A per-persona directory (`personas/<name>/`) is never read for a managed
tenant. Sqlite deployments stay on the filesystem: `/deploy` and the panel's
persona routes answer 409 `persona sync requires Postgres` there.

## Repository layout

> **The three-file layout below is the older form.** A persona synced from it has
> no structure to run on, so a changed or new one is refused at sync (a 422 that
> names `personas export --format agent-yaml`). Use [one file](#one-file-agentyaml)
> for every persona. This section stays for reading a repository that still has
> the old layout.

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
background:                     # optional: background-learning settings
  budgetUsd: 2.5                # daily USD budget, 0 to 100 (0: no background spend)
  timezone: "Europe/Berlin"     # IANA zone; the budget day runs midnight to midnight here
```

`kbSources` lists the `kb-<label>` knowledge-base sources the persona may read.
Absent means every installed knowledge base; `[]` means none. It filters
retrieval and is not isolation. See [Knowledge scope](knowledge-scope.md).

`background` sets the persona's daily budget for background learning passes
and the skill check (`budgetUsd`, 0 to 100; 0 turns background spend off) and the
timezone its budget day and schedule use (`timezone`, a valid IANA name). Either
key may be omitted: an absent budget falls back to `SLAUDE_BACKGROUND_BUDGET_USD`
(default 1), an absent timezone to `SLAUDE_BACKGROUND_TIMEZONE`, then `UTC`.
Unknown keys inside `background` are refused. A bad timezone or a budget out of
range fails the sync. It needs migration 0020 on the gateway's database.

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

## One file: agent.yaml

A persona is defined by a single `personas/<name>/agent.yaml`, which replaces
`persona.yaml`, `SOUL.md` and `mcp.json`. A directory that has an `agent.yaml`
must not also have those three files (that is a sync error). A directory without
one is the older layout: it syncs only while its soul text is unchanged from what
is stored, and `personas render` warns about it.

The file's fields, with placeholders throughout:

```yaml
name: support-bot                 # required: must equal the directory name
description: Answers support questions in the team channels
model: provider/model-name
slackUserId: slack:user:UTESTUSER1   # required for a named persona
userToken: ${PERSONA_SUPPORT_BOT_XOXP}
provider:                         # as persona.yaml: references, never values
  baseUrl: https://llm.example.com
  apiKey: env://PERSONA_SUPPORT_BOT_API_KEY
runsOn: general                   # node label; plugins follow the machine, see below
soul: |                           # required: prose only, identity and voice
  You are the support bot. Plain and direct.
mandate:
  global: Answer questions about the product and file bugs.
  scoped:
    - boundary: slack:channel:CTEAMCHAN  # a channel reference, trust:public, trust:trusted or dm
      mode: extend                # override (default), extend or reduce
      text: Also triage the deploy queue here.
    - boundary: trust:public
      mode: reduce
      text: Share nothing internal in public channels.
access:
  manager: slack:user:UMANAGER1
  backupManager: slack:user:UDEPUTY1
  approvers:
    - user: slack:user:UAPPROVER1
      scope: budget changes
      catchall: false
    - user: slack:user:UAPPROVER2            # no scope: a catchall approver
      channel: slack:channel:CTEAMCHAN   # optional: only in this channel
  channels:
    public: [slack:channel:CPUBLIC1]
    trusted: [slack:channel:CTEAMCHAN]
  dm: [slack:user:UFRIEND1]
  blocked: [slack:user:UNOISY1]
  redact: ["internal-[0-9]+"]     # regular expressions
  approvalTimeoutSeconds: 300     # optional; absent or 0 uses the default persona's timeout
mcp:                              # the same shape as mcp.json
  mcpServers:
    tracker:
      type: http
      url: https://tracker.example.com/mcp
      headers:
        Authorization: ${PERSONA_SUPPORT_BOT_TRACKER_TOKEN}
skills: [triage, release-notes]   # absent: every skill; []: none
guardrails: [no-outbound-email]   # guardrails that also apply to this agent
memory:
  kbSources: [kb-handbook]        # absent: every installed KB; []: none
  background:
    budgetUsd: 2
    timezone: UTC
channels:                         # per-channel settings, keyed by channel reference
  "slack:channel:CTEAMCHAN":
    session: channel              # one long-lived session for this channel, no wakes needed
    proactive: true               # the agent works on its own here; on its own this also gives the channel session
```

**Compiled, never extracted.** The structured parts compile deterministically
to the persona's structure at sync: no model is called and nothing is cached,
for the default persona as well. The `soul` block stays prose; mandates and
access come only from their own keys, so a `## Manager` or `## Mandate` heading
left in the soul has no effect and the sync warns about it. A console edit of
such a persona's soul changes the prose and keeps the structure.

**`channels`** compiles to the `## Channel` block a `SOUL.md` would carry
(`### Session` with `Mode: channel`, `### Proactive` with `Enabled:`), appended
to the soul. `proactive: true` alone gives the channel a channel session with
wakes; `session: channel` alone gives it the session without wakes. A key that is not a channel reference, a `session` other than `channel`, a
`proactive` that is not a boolean, a bare `session:` or `proactive:`, or an
unknown key fails the sync. So does a `soul` that already has a `## Channel`
section for a listed channel, or that ends inside an open code fence. A console
edit of the soul keeps these generated sections, except for a channel whose
section the edited text carries itself; sections you wrote in `soul` are yours
to edit away.

**Scoped mandates** behave as the `Mode:` line and `## Scope` blocks of a
`SOUL.md` do: the most specific boundary applies, an absent `mode` is
`override`, and an unknown one reads as `extend` (a sync warning names it) so a
typo keeps the global mandate.

**Access is exactly what the file says.** Nothing is inherited from the default
persona: `dm: []`, `approvers: []` or a missing `access` mean none, so an agent
with no `access` answers nobody until a console grant says otherwise. It has no
manager to fall back on either. The one exception is the default persona's
blocked users, which still apply. Its own `access.channels` also decide the KB
scope, the trust hint and the decision gate in those channels. A default persona
defined this way uses only its own approvers, then its managers: an on-disk
`SOUL.md` and `SLAUDE_APPROVERS` are not consulted, and with neither nobody can
approve. A `SOUL.md` persona keeps its existing fallback to the default.

**Errors.** A malformed value (a bad reference, a bad regular expression, a boundary
that is not a channel reference, `trust:public`, `trust:trusted` or `dm`, a `name` that differs from the directory), an
unknown key or a duplicate key fails the sync with a message naming the persona
and the key. A bare `skills:` or `memory.kbSources:` with no value fails too:
remove the key for all, or write `[]` for none.

**`skills`** lists the skill slugs the agent may use. It covers the skills in
`$SLAUDE_HOME/skills` and the persona's own overlay: the Skill tool, the
`/slug` invocation, `list_skills`, `read_skill`, `write_skill` and `delete_skill`
all honour it, and the model is not offered other skills. Built-in `slaude:`
skills and installed plugins' skills are not limited by it. It is a filter on
what the agent loads, not a sandbox: skill files stay readable on disk.

**`guardrails`** adds this agent to `scope: agents` guardrails it names (which
apply to their own agents as well). It is additive only: it cannot remove or
weaken a guardrail, a disabled guardrail stays off, a `shared` one is
unaffected, and an unknown slug is a sync warning that takes effect once a
guardrail with that slug exists.

**Plugins are not a field.** Every agent on a machine gets every plugin
installed there; choose machines with `runsOn`.

An agent defined this way needs nodes that advertise the `agent-definition/1`
capability, which this version's nodes do; an older node is refused, as for
owner guardrails. It needs payload version 6 and migration 0036 on the
gateway's database. Secrets stay as `${PERSONA_*}` placeholders and
`provider` references exactly as in `persona.yaml`.

`export --format agent-yaml` (below) writes these files from a current
deployment.

### Editor help and the JSON Schema

The file's shape is defined once, in a schema that the validator itself uses,
and published as a JSON Schema:

```
https://barockok.github.io/slaude/schemas/agent.schema.json
```

With it an editor completes keys, shows each field's help text on hover and
underlines a mistake as you type. Add this line at the top of an `agent.yaml`
(the YAML language server reads it, in VS Code with the YAML extension, in
Neovim, JetBrains and others):

```yaml
# yaml-language-server: $schema=https://barockok.github.io/slaude/schemas/agent.schema.json
```

`personas export --format agent-yaml` writes that line itself. The schema marks
every object closed: **an unknown or misspelt key is an error at every level**,
in the editor and in the sync, so a typo cannot silently leave an access list
or a limit unset. A few rules need more than a shape (the name matching its
directory, a repeated boundary, a valid redaction pattern, a soul that carries
its own `## Channel` section for a channel under `channels:`); the editor does
not check those, and the sync does.

## References

Wherever `agent.yaml` names a person or a place it takes a typed reference: the
text says what kind of thing it points to, so a bare id is never the long-term
form. The design is in the
[domain objects and references spec](https://github.com/barockok/slaude/blob/main/docs/superpowers/specs/2026-11-12-domain-model-and-references.md)
and the [field note](../field-notes/2026-11-12-typed-references.md).

| Form | Example | Takes |
|---|---|---|
| Slack user | `slack:user:U0EXAMPLE` | user fields |
| Slack channel | `slack:channel:C0EXAMPLE` | channel fields |
| Slack, workspace-qualified | `slack:user:T0EXAMPLE/U0EXAMPLE`, `slack:channel:T0EXAMPLE/C0EXAMPLE` | the same fields |
| WhatsApp | `whatsapp:phone:+620000000000`, `whatsapp:group:<id>` | user, channel |
| Telegram | `telegram:user:12345` | user fields |
| Email | `email:person@example.com` | user fields |
| Internal records | `user:<id>`, `boundary:<id>` | user, channel |
| Selectors | `trust:public`, `trust:trusted`, `dm` | `mandate.scoped[].boundary` only |

The fields that take references, and what each accepts:

| Field | Kind |
|---|---|
| `slackUserId`, `access.manager`, `access.backupManager`, `access.approvers[].user`, `access.dm[]`, `access.blocked[]` | user |
| `access.approvers[].channel`, `access.channels.public[]`, `access.channels.trusted[]`, the keys of `channels:` | channel |
| `mandate.scoped[].boundary` | channel, or one selector |

A user reference in a channel field (or the reverse) is refused, as is a
selector anywhere but `boundary`. `agent:`, `env:` and `node:` references parse
but name no user or channel, so no field takes them.

Rules, applied before anything looks a reference up:

- Case is not folded. The scheme and kind must be lower case and Slack ids
  upper case, as Slack issues them; `Slack:user:u0example` is refused, in the
  editor too. The ids are the same shapes as before (`U` or `W` for users, `C`,
  `G` or `D` for channels); a workspace is `T` followed by upper-case letters
  and digits.
- An email address is trimmed and lower-cased. The local part must be ASCII:
  fullwidth letters and other compatibility characters are refused, not folded
  to ASCII. Plus-addressing and dots are kept, so `a+x@` and `a@` are different.
  A display name, angle brackets, whitespace, two `@`, an empty part, a domain
  without a dot or an address over 254 characters is refused. The domain is
  folded (NFKC) and stored in its ASCII (IDNA) form.
- A phone number is E.164 with the leading `+`.
- Each scheme fixes its number of leading segments, so a `:` in the last one
  needs no escaping. There is no percent-encoding and no empty segment. A
  reference is at most 256 characters.

Refusals name the field and the kind of mistake, never the value.

**What compiles today.** Records for people and places do not exist yet, so only
`slack:` references can be turned into something the runtime uses: they compile
to the same Slack ids as before (the workspace qualifier is read and dropped
while one workspace is connected). Every other scheme parses and validates, then
fails the compile with a message such as `access.dm[1] uses the 'email' scheme,
which cannot be resolved yet`. It will work once the records arrive in a later
release; write `slack:` references until then.

**The transition.** A bare Slack id (`U0EXAMPLE`, `C0EXAMPLE`) is accepted for
one more release, read as the matching Slack reference, with a warning that names
the field path (never the value) in the `personas render` output (which CI runs;
the gateway sync report does not carry these warnings yet). The same goes for the older boundary form `channel:C0EXAMPLE`,
read as `slack:channel:C0EXAMPLE`. The release after the first stable one that
carries this refuses both. `personas export --format agent-yaml` already writes
the typed form, so exporting then rendering gives no warning.

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
No sync makes a model call: a persona's structure is compiled from its
`agent.yaml`.

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
  writes the highest version any field needs: 4 when any persona sets
  `background` (upgrade the gateway first: it must run migration 0020 before CI
  sends v4), else 3 when any persona sets `kbSources`, else 2 when any persona sets `provider` or `runsOn`, otherwise 1.
  A payload without those fields still deploys to an older gateway, and one
  with them is refused by a gateway that would ignore them. A payload whose `version` is newer than the gateway supports is
  refused with 422 before anything is applied: upgrade the gateway first.
- A field the gateway does not know (at the top level or on a persona) is
  ignored, never stored, and listed in `ignoredFields` as `futureKnob` or
  `persona.<name>.<field>`. The gateway also logs a warning naming the fields.
  Only names are reported, never values. That is with `SLAUDE_DEPLOY_STRICT=0`
  on the gateway. Strict is the default since v0.45.0: an unknown field is a 422
  naming it, so upgrade the gateways before the pipeline that renders new
  fields, or set `SLAUDE_DEPLOY_STRICT=0` while they catch up. `personas render --check`
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
  topology. In `mono` the default persona reverts to the on-disk `agent.yaml` and
  keeps answering. In the gateway topology **every turn stops, the default
  persona's included**: the tenant is still managed and has no live persona,
  so a node's runtime bundle request is 404 and no turn can boot. Sync a set
  that includes `default` to recover.
- Every persona must carry its `agent.yaml` definition. A persona without one
  is refused with a 422 that names it and the command that converts it
  (`personas export --format agent-yaml`), unless its soul text is unchanged from
  what is stored, in which case it keeps its stored structure. A dry run applies
  the same check, so a preview never reports a sync that would fail. Nothing is
  extracted: the structure is compiled from the file.
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

To migrate to [one file](#one-file-agentyaml), add `--format agent-yaml`:

```sh
bun run personas export --format agent-yaml --out ./persona-repo
bun run personas export --format agent-yaml --persona support-bot --out ./persona-repo
```

It writes one `personas/<name>/agent.yaml` per persona with the same secret
handling as above. This is the one place a model still reads a soul: the
structured parts come from a one-time extraction (its cache, else a model call,
every id grounded in the text), and the soul keeps its prose: the sections that
moved into their own keys (`## Mandate`, `## Reporting`, approvers, channels,
redaction and so on) are dropped from it, and anything it does not recognise
stays. It reads `$SLAUDE_HOME`, so a deployment already managed from a git
repository migrates by hand or by exporting from a filesystem copy. Review the
result: an extraction can miss a section, and compiling is exact only about
what was extracted.

## An agent.yaml on disk

A deployment that keeps its personas in `$SLAUDE_HOME` (no sync) can use the same
file. `$SLAUDE_HOME/agent.yaml` defines the default persona and
`personas/<name>/agent.yaml` a named one. It compiles with the same parser as a
synced file, so nothing about the persona goes through extraction: access,
mandates, skills and proactive settings are read from the file as written.

```sh
SLAUDE_HOME=/path/to/home bun run personas migrate default
SLAUDE_HOME=/path/to/home bun run personas migrate sam --out ./migrated
```

`migrate` turns a SOUL.md persona into an agent.yaml beside it and moves SOUL.md
to `SOUL.md.pre-agent-yaml`, because the loader refuses both together. With
`--out <dir>` it writes a copy under `<dir>` and touches nothing else (use it to
migrate a copy that lives in a repository). `--keep-soul` leaves SOUL.md where it
is. It never overwrites an agent.yaml, and if SOUL.md cannot be moved it removes the file it wrote.

What it does so the persona behaves as before:

- A SOUL.md persona inherits the access fields it leaves out (managers,
  channel lists, approvers) from the default persona. An agent.yaml persona
  inherits nothing, so migration writes the inherited values into the file.
- The global `## Proactive` section becomes the `proactive` key (`read`,
  `watch`, `quietHours`, `maxPerDay`, `enabled`). `Wake`, `Highest` and `Cooldown`
  have no key, and dropping them would loosen the persona, so a soul that sets
  one is refused unless you pass `--allow-loss`.
- A named persona that lists its own trusted or public channels is warned: a
  SOUL.md persona's knowledge scope and trust classes came from the default
  persona's lists, an agent.yaml persona's come from its own. Access added at
  runtime with `/soul` is not in the file; only what the soul text says is written.
- Before writing, it compiles the file and compares access, mandates and
  proactive settings with what the soul read. A difference stops the migration
  with the field named, and nothing is written.
- It refuses a soul that holds a secret-shaped value. A persona's Slack user
  token stays in `config.json`, which may sit beside the file along with `mcp.json`.

A file on disk cannot set `model`, `mcp`, `runsOn`, `provider`, `memory.kbSources`,
`memory.background` or `userToken` yet; the process refuses to start and says
where each one lives instead (the model from `SLAUDE_MODEL`, MCP servers from
`mcp.json`, the token and Slack id from `config.json`). A malformed file stops
the process at boot with the persona and key named, because skipping the persona
would let its name fall through to the default persona. A `SOUL.md` with no
`agent.yaml` beside it stops the gateway and mono at boot (a managed tenant is
unaffected: its personas come from the database), and the message names
`personas migrate`. A fresh home gets a starter `agent.yaml`.

## Runtime overrides

For quick experiments without a commit, the panel API (`SLAUDE_PANEL=1`)
exposes the routes below. They always act on the tenant `default`.

- `GET /panel/api/personas`: git versus live per field, for every persona
  including tombstoned ones (each entry says `tombstoned: true|false`). Any
  authenticated operator can read it. Tokens appear only as present or absent;
  soul text and model are shown, plus `runsOn` and a `kb.mode` summary
  (`all`, `none` or `list`).
- `GET /panel/api/personas/<name>`: one persona's definition, references and
  presence only (see [persona definitions](panel.md#what-it-does)). Any
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

- **Connectable and mounted MCP servers can differ in `mono`.** In the
  gateway role, `/mcp connect` and the portal's integrations page offer exactly
  the servers the [MCP bridge](mcp-bridge.md) serves for the persona. In
  `mono` they still read the global `.mcp.json` for a managed persona, while
  the persona's turns mount its synced `mcp`.
- **Export does not catch every token in an MCP URL.** It does not detect a
  token in a URL's host, or in a URL path segment shorter than 32 characters.
  Review MCP URLs before committing an export.
- **On nodes, per-persona `mcp` reaches the agent only through the MCP
  bridge.** A managed persona's remote `http` servers are served by the
  [MCP bridge](mcp-bridge.md): the runtime bundle carries only their names
  (`mcpServers`), and every call goes through the gateway, so resolved header
  and env values never leave it (`mcpJson` in the bundle is always `null`).
  stdio, legacy `sse` and plugin servers in a persona's `mcp` are not bridged;
  a node runs a stdio server only when its own
  [node MCP manifest](node-manifest.md) declares it for that persona. In `mono`
  on Postgres a managed persona's external MCP servers come from its effective
  `mcp` (nothing when it has none; the default persona falls back to the
  global `.mcp.json`).
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
(a persona with no `agent.yaml`) fail the job and still prints the error body, which
names the variable, persona or revision at fault and never a secret value.
