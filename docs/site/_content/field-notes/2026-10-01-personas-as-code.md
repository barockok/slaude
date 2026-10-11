---
title: "Personas as code: what could move into git, and what could not"
date: 2026-10-01
---

A persona is a Slack identity plus a soul, an optional model, an optional user
token and optional MCP servers. Until now it lived as files on the shared
volume, edited by hand on whichever machine had the volume mounted. This branch
makes a git repository the source of truth for it: a pipeline POSTs the desired
set to the gateway, the gateway stores it in Postgres, and every replica and
node reads it from there. This note records the mechanisms and the mistakes.
The operator-facing procedure is in
[Personas as code](../deploy/personas-as-code.md).

## Why the soul could move and credentials could not

An earlier note in this series claimed the agent child process reads the soul
from disk. It does not. Slaude injects the soul into the system prompt as text
and the child never opens the file. So the soul can come from anywhere that can
hand the gateway a string: the database, a bundle, a request body. The claim was
wrong and is corrected here.

Credentials are different. A user token or an MCP header is consumed by code
that runs in another process and expects a value in its environment or its
config. For those, "move to the database" is not enough: who may read the row,
which replica refreshes a token, and which person a turn runs as all matter.
That is the work of the MCP credential store, and this branch does not reopen
it. Git carries only placeholders for credentials; the gateway resolves them
from its own environment at sync time.

Only names starting with `PERSONA_` resolve (`${PERSONA_SUPPORT_BOT_XOXP}`).
The first version resolved any `${VAR}`, and the gateway's environment also
holds its own secrets: a repository could have copied `${SLAUDE_MASTER_KEY}`
into a stored persona, and from there into anything that reads persona state.
Any other name is a 422 naming the variable, checked before the environment is
looked at. `export` generates `PERSONA_` names and `render --check` enforces the
same rule, so CI rejects what the gateway would.

The `PERSONA_*` variables and the deploy tokens live on gateways only. The
agent's child used to inherit the whole environment minus one key, so a turn
that held those values could read every persona's user token or POST a soul
naming an attacker as approver. Every SDK child (the agent turn, the ingest
pass, the `kb_think` synthesis) is now started without any `PERSONA_*`, either
deploy token, `SLAUDE_MASTER_KEY`, `SLAUDE_NODE_TOKEN` or `SLAUDE_JOB_SECRET`.
Nothing the child runs needs them: MCP placeholders are expanded in the slaude
process before the config reaches the child.

The scrub is defence in depth, not the boundary. In `mono` the child runs as
the same OS user as slaude and is its descendant, so it can read the parent's
environment (`/proc/<pid>/environ`) whatever is scrubbed. A guarantee the
platform cannot enforce must not be documented as one, so `/deploy` is mounted
for the gateway role only, `mono` is one trust domain (as it already was: it
kept per-persona user tokens on its own disk), and a `mono` deployment is
managed through the panel's OIDC superadmin session instead.

## Why skills and `slaude.json` stayed out

Skills are written by the agent itself as it learns. Putting them under a
repository sync would either overwrite what the agent wrote or require a merge
policy. `slaude.json` installs code into the runtime; a pipeline that can edit
it can run code on the gateway. Both stay on the volume.

## Two layers, selfHeal, tombstones

A persona has a desired layer (what the last sync said) and an override layer
(runtime edits from the panel API: soul, model, mcp only). The effective persona
is the desired row with overrides merged on top, in one place.

A sync wipes every override. This is ArgoCD's `selfHeal`: if a runtime edit
could survive a sync, git would stop being the source of truth the moment
anyone used the panel, and nobody could say what a persona is by reading the
repository. The cost is that a quick experiment lasts only until the next
merge. The dry run reports how many override rows a real sync would wipe.

Removing a persona from the repository tombstones the row; it does not delete
it. Identity stops routing, the rows stay, and re-adding the name later reports
`updated`, not `created`. Overrides on a persona that does not exist are
refused at the repository (404), so an orphan override row cannot exist and the
dry run's count matches the real sync by construction.

A non-empty sync must include a persona named `default`. Otherwise the default
persona's soul would have to come from somewhere other than the managed source,
which is a merge of two sources. An empty payload is refused unless
`allowEmpty: true` is sent, in which case everything is retired and the default
persona reverts to the on-disk `SOUL.md`.

Ordering is a compare-and-set on the commit time: a rerun of an older commit is
refused with 409 before any model call is made. Every write, syncs and runtime
edits alike, bumps a strictly increasing state version (a counter that could
repeat would strand a polling replica on stale state), and every runtime write
locks the sync-state row first so it serialises with a sync.

## `/deploy`: its own prefix and its own token

`POST /deploy/v1/tenants/:tenant/personas[?dryRun=1]`. The existing `/v1` plane
authenticates with the node token, and every node holds it. A pipeline endpoint
under that token would let any node rewrite identity. So `/deploy` has its own
prefix and its own `SLAUDE_DEPLOY_TOKEN`, set on the gateway only, and a test
asserts the deploy token gets a 401 on `/v1`.

The token is trimmed and must be at least 32 characters after trimming;
anything shorter is treated as unset and `/deploy` answers 404 for every path
and method. The trim matters: the generic env reader does not trim, so a
whitespace-only value was "configured" and a whitespace bearer matched it. A
deploy token equal to the node token counts as unset, with a warning.
The tenant path segment is decoded inside a guard and must match the persona
name alphabet, otherwise 404 (a malformed escape used to surface as a 500).

Pull-request jobs need a dry run, and a pull request's workflow runs the pull
request's own code, so whatever credential it holds an unreviewed change can
use. A second token, `SLAUDE_DEPLOY_PREVIEW_TOKEN`, is accepted only with
`?dryRun=1`; presented on an apply it is the same 401 as a wrong token. A dry
run makes no model call (classification never depended on the extracted
structure), so the preview token cannot spend provider budget either. Because
that token now sits in workflows running unreviewed code, the body `/deploy`
buffers is capped at 4 MiB (413 above it). On sqlite, where the persona tables
do not exist, `/deploy` and the panel's persona routes answer 409 instead of
failing on a missing table.

## The strict extractor

The structured soul (approvers, channel overrides) is extracted from the soul
text by a model call. The existing `loadSoulData` degrades silently to an
approvers-only result when extraction fails. For a file read at boot that is a
tolerable degradation; for a sync it is not, because a transient provider error
would quietly store a persona with no channel mandate. The sync uses a strict
extraction that throws, returns 502, and logs the failure class and a truncated
message server-side. Extraction and validation run before the transaction, so no
model call happens while a lock is held.

The extraction result is cached by soul text, and the cache was a planting
point: it lived under `$SLAUDE_HOME`, a volume every node and every agent turn
can write, and a strict extraction trusted a hit. A file planted there could
name an attacker as manager or approver. Three layers now: the cache directory
is `SLAUDE_SOUL_CACHE_DIR` (pod-local on gateways in the shipped manifests),
every hit is re-validated (schema, and every Slack id must appear in the soul
text), and with `SLAUDE_MASTER_KEY` set each entry is signed with a key derived
from it, over the full sha256 of the text and the data. Grounding alone was not
enough: it permits swapping roles among ids the soul merely mentions. The
signature first covered only the 64-bit prefix that names the file; it now
covers the full digest, and an entry in the old format is re-extracted once.

## The registry: a synchronous snapshot and a poll

Lookups on the hot path are synchronous reads of a snapshot. A poll compares a
cheap state token and rebuilds when it changes. This differs in mechanism from
the spec's per-lookup revalidation and gives the same guarantee: staleness is
bounded by the poll interval. A write also rebuilds the snapshot on the replica
that took it and publishes on the tenant's config-reload channel, which nodes
subscribe to. Other gateway replicas do not subscribe: they converge through
the 10 s poll, so "near-immediate" holds for the writing replica and the nodes
only.

Three details came from review:

- Invalidation originally nulled the registry, and the lazy getter rebuilt from
  disk, so every sync or override silently flipped a managed tenant back to the
  filesystem. Invalidation now keeps serving the installed snapshot and
  triggers an asynchronous rebuild that picks the right source.
- The poll records a version as handled only when its rebuild actually
  installed a snapshot. A rebuild superseded by a newer one whose own rebuild
  fails is retried on the next tick.
- The default persona's soul text and its structured data are one pair from one
  source: both from the managed row, or both from disk. If the managed row's
  structured data fails validation, the previous pair is kept and the failure
  logged. Never half of each: that is an agent speaking one soul while approvals
  use another's access lists.

## The bundle

A node learns what to run from the runtime bundle the gateway builds. For a
managed tenant the bundle is built from effective state and nothing else: the
code path returns (or 404s) on every branch, so the disk and environment tiers
are unreachable from it by construction. The first version fell through to disk
when the raw row lookup came back empty, and review found it. On a database
error the bundle route fails (the node retries) rather than concluding the
tenant is unmanaged and serving another source. The bundle also carries the
persona's Slack user id, because the child's `SLAUDE_AGENT_ID` anchors the
persona's private brain slice and plugin-spawned MCP processes inherit it.
It does not carry the persona's MCP config: nodes never mount it, and its
header and env values are resolved secrets, so a managed bundle ships
`mcpJson: null`. It does carry the persona's effective model (see below), and
a managed bundle says so (`managed: true`); an unmanaged bundle's content is
unchanged.

## Nodes

Nodes take the soul from the bundle, not the volume, and no longer load the
persona registry from the volume at boot. Transcripts stay on the volume:
they are agent-written state.

To make the source observable, each session boot logs
`[agent] session=<id> persona=<name> soul=<12 hex>`: the first 12 hex digits of
the soul's sha256. A log line carries a hash, never soul text. The cluster
proof asserts on that hash, because a test that only checks behaviour passes
just as well when the node reads the volume.

On a config change, a warm session must pick up the new soul. Reload is
deferred until the session's outstanding inputs reach zero. The spec said "the
turn in flight finishes", and that was wrong: the SDK closes the CLI's stdin as
soon as the input iterable is closed on a session past its first result, so an
immediate reload breaks the running turn. The first fix used a boolean; an
auto-evolve prompt and a queued user message can both be outstanding, so it is
a count, and the reload applies only at zero. A message sent to a session that
is mid-reload awaits its exit (bounded by a timeout) and boots a fresh session,
so a turn claimed in that window is never pushed into a closed queue. The
mechanism predates this branch (the MCP-connect reload has the same hazard);
this branch newly fires it on every warm session at every config change.

On an invalid structured soul a session emits no channel mandate and logs a
warning naming only the session and persona. It never borrows the default
persona's mandate. On a node, a named persona's channel mandate now comes from
its own structured soul, which is a behaviour change from the volume-based
path. In `mono` it does not: the manager passes no structured soul for a named
persona there, so the default persona's channel overrides still apply (a known
gap below).

## Retired personas fail closed

A persona removed from git is tombstoned, and every path that used to fall
back to the default persona now refuses instead: an inbound event addressed to
its bot user, or a reply in its thread, is dropped with a log line; a new
session for it fails to boot; a warm session of it is closed when the registry
installs a snapshot without it (its in-flight turn is aborted); its Slack
client and brain-slice gate throw rather than hand back the default persona's.
A cron job owned by it skips each occurrence while it is retired: the
compare-and-set that claims an occurrence has already advanced the schedule,
so recording `skipped: persona not live` without releasing the claim skips
exactly that one. The first version paused the job, which broke "re-adding it
in git restores it whole": every job needed a manual resume.

## Model and MCP on a managed tenant

The persona `model` was stored, overridable from the panel, and read by
nothing: every session was created with `SLAUDE_MODEL`. Now the precedence is
a per-thread `/model` choice, then the persona's effective model, then
`SLAUDE_MODEL`. To tell a thread's choice from a default without a schema
change, a managed tenant creates session rows with an empty model, meaning
"follow the persona"; the model is resolved at boot (`mono` from the registry
snapshot, a node from its bundle). Rows created earlier carry `SLAUDE_MODEL`
and keep it, exactly as on a filesystem tenant.

`mono` on Postgres or PGLite is a supported managed deployment, and its
in-process MCP resolver still read `personas/<name>/mcp.json` from disk, so
the synced `mcp` was ignored and stale servers kept mounting. A managed tenant
now mounts each persona's effective `mcp` (nothing when it has none); the
default persona falls back to the global `.mcp.json`, the same operator-level
fallback shape as its soul. Effective values are not `${VAR}`-expanded a
second time.

## Export refuses what it cannot make safe

`personas export` seeds a repository from a running home. Tokens become
`${PERSONA_*}` placeholders and the variable names are listed. For MCP config,
every string under any server's `headers` or `env` that is not already exactly
a `PERSONA_` placeholder becomes a generated one.

The first version scrubbed the shapes it knew and copied everything else, and
a probe found six common shapes it wrote to git verbatim: a string `headers`, a
string `args`, unknown keys such as `apiKey` or an `oauth` block, a `command`
with an inline `TOKEN=`, and a token in the url path. Scrubbing a known shape
loses to an unknown one, so export is now allowlist-shaped and fails closed:
only known keys (`type`, `url`, `command`, `args`, `headers`, `env`; at the top
level `mcpServers` and `privateServices`); `headers`/`env` must be objects of
strings and `args` a list; the url path, the command and every arg are scanned
for token shapes (Slack and GitHub prefixes, `sk-`, AWS key ids, `Bearer`, a
JWT, any run of 32+ token characters). Each refusal names the persona, server
and key, never the value. The cost is false positives, which fail safe. Other
stdio args cannot be classified, so export succeeds and prints a warning
listing the servers to review. Parse errors name the file and persona only,
because a parser message can quote content.

`personas render --check` runs the gateway's own placeholder validation with
every name satisfied, so CI rejects exactly what the gateway would 422.
`${lower}` in `userToken` or `mcp` is a 422 rather than stored literally.

## Known gaps

State plainly:

1. **Per-persona `mcp` is not consumed on nodes.** External MCP servers from
   a persona's config are mounted only by the in-process resolver, which runs
   turns only in `mono` (where a managed tenant now uses effective `mcp`).
   Nodes build shims for slaude's built-in tool contracts and never read
   persona MCP config, and a managed bundle ships none. Wiring it changes the
   security surface (a stdio server is code execution inside a node pod, and
   credentials depend on whom the turn runs as) and needs its own design.
   Ahead of that, runtime `mcp` overrides and quick-onboard `mcp` accept
   `type: "http"` servers only; git-synced `mcp` is unrestricted because git is
   the trusted path.
2. **The compare-and-set race has not been run on a real Postgres.** No
   Postgres was available in the session that built this. The repository tests
   passed on PGLite, which serialises transactions, so the race cannot occur
   there and the pass proves nothing about the compare-and-set. Required
   before merge, not yet run: the real-Postgres run and the split-check
   mutation.
3. **The k8s-local cluster proof has not been executed.** The "personas as
   code" section of `deploy/k8s-local/verify-ha.sh` checks a node's soul hash
   on a fresh boot and, after a second sync, on a second turn in the same
   session (a warm session picking up a changed soul depends on the real
   CLI's result cadence, which unit tests fake). It was only statically
   checked; no cluster could be started. Required before merge, not yet run.
4. **A pre-existing weakness, not fixed here:** the `/v1` node token reader does
   not trim or length-check, so a whitespace-only `SLAUDE_NODE_TOKEN` makes `/v1`
   accept a whitespace bearer. The deploy token does not have this problem;
   the node token should get the same treatment.
5. **MCP lists read the global `.mcp.json`.** The `/mcp connect` list and the
   portal integrations list still read it for a managed persona, so
   connectable and mounted servers can differ. **Resolved:** `/mcp connect`, `/mcp disconnect` and the Connect cards now resolve per persona through `connectableServers`, the same function the portal unions over personas.
6. **Export misses some tokens in MCP URLs.** A token in a URL's host or in a
   path segment shorter than 32 characters is not detected; review MCP URLs
   before committing.
7. **In `mono`, a named persona's channel mandate is the default persona's.**
   Nodes use each persona's own structured soul; the `mono` manager does not.
8. **After `allowEmpty` the gateway topology runs no turns.** A managed tenant
   with no live persona has no bundle to serve, so every node turn fails, the
   default persona's included, while `mono` reverts the default persona to the
   on-disk `SOUL.md`. The guide states it; making the two agree needs a
   decision about what an empty managed tenant should be.

Also: a killed node never releases its session lock, so a re-delivered turn
waits out the lock TTL (an existing latency bound, unchanged).

## Mistakes worth recording

- **A concurrency test that only raced once.** The first version of the
  compare-and-set race test reused one tenant across iterations. After the first
  iteration the live revision was already newer than the loser, so the loser was
  refused regardless of commit order, and a mutation that split the check from
  the write would still pass. The test now uses a fresh tenant per iteration.
- **A cache key derived twice.** The cluster script seeded the extraction cache
  (so the sync needs no provider credentials) by hashing the soul text in bash.
  The key's hash length was wrong, so the seed was never read. The key is now
  derived once, by an exported `soulCachePath` that extraction itself uses, and
  a unit test seeds a file at that path and shows extraction returns it without
  a model call. The script calls the helper inside the gateway pod.
- **CI's sqlite leg was not run for several tasks.** Verification ran with
  `SLAUDE_DB=pg` only. When the default leg was finally run, 31 tests failed:
  the persona suites touch Postgres-only tables and did not skip on sqlite.
  They now skip unless `SLAUDE_DB=pg`. From then on both legs were run for
  every task.
- **A crash path in a fire-and-forget call.** The cron scheduler starts each
  run with `void`, so a throw inside it (a persona retired between the live
  check and the run, a database error) became an unhandled rejection, which
  exits Bun, and left the job marked running. The call site now catches,
  records the error and clears the job.
- **A detached session still credited by id.** After the bounded reload wait
  detaches a session that never exited, its query loop kept running and its
  late messages were looked up by session id, so they joined the fresh
  session's turn and a late result could apply a deferred reload under it. The
  loop now passes its own session and late messages are dropped.
- **Mono on Postgres was reachable and described as impossible.** Both docs
  said "mono is sqlite", so the deploy token in the agent child, the disk MCP
  read and the inert model all sat in a configuration the code allowed and the
  docs ruled out. The final review found them by reading the configuration
  space rather than the topology diagram.
- **A test that passes under its own mutation.** Several review findings here
  (the bundle fall-through, the registry flipping to disk, a cache seed nobody
  read) were invisible to tests that asserted behaviour and not source. The
  boot log hash exists so a proof can fail when the source is wrong.
