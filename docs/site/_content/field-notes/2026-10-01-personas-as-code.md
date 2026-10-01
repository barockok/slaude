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
it. Git carries only placeholders (`${VAR}`) for credentials; the gateway
resolves them from its own environment at sync time.

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
whitespace-only value was "configured" and a whitespace bearer matched it.
The tenant path segment is decoded inside a guard and must match the persona
name alphabet, otherwise 404 (a malformed escape used to surface as a 500).

## The strict extractor

The structured soul (approvers, channel overrides) is extracted from the soul
text by a model call. The existing `loadSoulData` degrades silently to an
approvers-only result when extraction fails. For a file read at boot that is a
tolerable degradation; for a sync it is not, because a transient provider error
would quietly store a persona with no channel mandate. The sync uses a strict
extraction that throws, returns 502, and logs the failure class and a truncated
message server-side. Extraction and validation run before the transaction, so no
model call happens while a lock is held.

## The registry: a synchronous snapshot and a poll

Lookups on the hot path are synchronous reads of a snapshot. A poll compares a
cheap state token and rebuilds when it changes. This differs in mechanism from
the spec's per-lookup revalidation and gives the same guarantee: staleness is
bounded by the poll interval, and a publish on the config-reload channel makes
it near-immediate.

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
persona's mandate. A persona's own channel mandate now applies to named
personas on a managed tenant, which is a behaviour change from the volume-based
path.

## Export never puts a secret in git

`personas export` seeds a repository from a running home. Tokens become
`${VAR}` placeholders and the variable names are listed. For MCP config, every
string under any server's `headers` or `env` that is not already exactly a
placeholder becomes a generated one. Export refuses, naming the persona and
server and never the value: a url with userinfo, query or fragment; a
non-string header or env value; two keys that normalise to one variable name;
args that look like a credential (`key=`, `token=`, `secret=`, `password=`,
`bearer `, or a `--*token`-style flag with a separate value). Other stdio args
cannot be classified automatically, so export succeeds and prints a warning
listing the servers to review. Parse errors name the file and persona only,
because a parser message can quote content.

`personas render --check` runs the gateway's own placeholder validation with
every name satisfied, so CI rejects exactly what the gateway would 422.
`${lower}` in `userToken` or `mcp` is a 422 rather than stored literally.

## Known gaps

State plainly:

1. **Per-persona `mcp` is stored but not consumed in the gateway topology.**
   External MCP servers from a persona's config are mounted only by the
   gateway's in-process resolver, which runs turns only in `mono`, and `mono`
   is sqlite, where personas stay on the filesystem. Nodes build shims for
   slaude's built-in tool contracts and never read persona MCP config; the
   bundle computes `mcpJson` and nothing uses it. Wiring it changes the
   security surface (a stdio server is code execution inside a node pod, and
   credentials depend on whom the turn runs as) and needs its own design.
   Ahead of that, runtime `mcp` overrides and quick-onboard `mcp` accept
   `type: "http"` servers only; git-synced `mcp` is unrestricted because git is
   the trusted path.
2. **The compare-and-set race has not been run on a real Postgres.** No
   Postgres was available in the session that built this. The repository tests
   passed on PGLite, which serialises transactions, so the race cannot occur
   there and the pass proves nothing about the compare-and-set. The real-Postgres
   run and the split-check mutation are required before merge.
3. **The k8s-local cluster proof has not been executed.** The new section of
   `verify-turns.sh` that checks a node's soul hash was only statically
   checked; no cluster could be started. Required before merge.
4. **A pre-existing weakness, not fixed here:** the `/v1` node token reader does
   not trim or length-check, so a whitespace-only `SLAUDE_NODE_TOKEN` makes `/v1`
   accept a whitespace bearer. The deploy token does not have this problem;
   the node token should get the same treatment.

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
- **A test that passes under its own mutation.** Several review findings here
  (the bundle fall-through, the registry flipping to disk, a cache seed nobody
  read) were invisible to tests that asserted behaviour and not source. The
  boot log hash exists so a proof can fail when the source is wrong.
