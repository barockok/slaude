---
title: Brain migration runbook
description: Move a single-agent deployment's brain (agent memory and per-user memory) into a persona on a gateway, with the export bundle, the token-guarded import endpoint, re-run semantics, rollback and a refusal-by-refusal troubleshooting table.
---

# Brain migration runbook

Moves the memory slices of a standalone (mono) brain into one persona of a gateway deployment. Two CLIs do the work: `bun run brain-export` reads the old brain into a bundle directory, and `bun run brain-import` posts the bundle in batches to the gateway's `/brain-import` endpoint, which writes through the gateway's own brain engine. Embeddings are carried across, not recomputed.

## 1. What moves and what does not

| Moves | Does not move |
|---|---|
| The agent's own slice (`agent`, `agent-default` or any `agent-<id>`), remapped to the persona's slice | `kb-*` sources. They are re-synced from their git sources, never copied. The export skips them and the import refuses them. |
| `user-<id>` slices, with the same source id | Sessions and cron jobs. Use `migrate-sqlite` for those. |
| `shared` and `public` | A brain in `SLAUDE_BRAIN_MODE=remote`. Import refuses it. |
| Per page: chunks and their embeddings, tags, timeline entries with their original dates, raw data, links | |

Every other source in the bundle must be named with `--map from=to` or the client refuses to start.

## 2. Preconditions

- **The persona exists on the gateway and has a Slack user id.** The target slice is derived from that id, the same way the gateway's own memory paths derive it, so you never type it. A persona that is not live or has no Slack user id is refused.
- **Embedding compatibility.** Dimensions must match exactly between the bundle and the target brain. The model name is compared only when both sides name one (a default brain has no `config.json`, so its model is unknown). A bundle that carries no vectors skips the check. The target's dimension is read from the pgvector column, falling back to `config.json`. On a mismatch the gateway answers 409 `embedding mismatch: bundle has 1280 dimensions, this brain has 1536 ...; align EMBEDDING_MODEL and EMBEDDING_DIMENSIONS or re-export`. A model change with identical dimensions and an unset model on one side is not detected: vectors of the same width are accepted.
- **A backup of the target brain database** before the first non-dry run:

  ```bash
  pg_dump --format=custom --file brain-before-import.dump "$SLAUDE_BRAIN_DATABASE_URL"
  ```

- The gateway runs the local brain engine on Postgres. A gateway on `SLAUDE_BRAIN_MODE=remote` or with the brain disabled refuses the import.

## 3. Export

Stop the pod that owns the old brain, or snapshot its volume. The export copies the whole brain home to a temporary directory and reads the copy, so it needs free disk roughly equal to the home's size under the system temp directory. The copy skips the live lock directory, so a running brain still exports, but a writer active during the copy can leave a torn database: stop it or export from a snapshot.

```bash
bun run brain-export --home /data/brain --out ./bundle
```

Expected output:

```
bundle written to ./bundle
source inventory (agent-like sources are remapped on import):
  agent-default                      pages=412 chunks=1180 embedded=1180
  user-UTESTUSER1                    pages=36 chunks=64 embedded=64
  shared                             pages=9 chunks=12 embedded=12
excluded: kb-handbook
```

Read the inventory. Agent-like sources (`agent`, `agent-*`) all land in the one persona slice. `--include <source>` and `--exclude <source>` (repeatable) narrow the export; the `kb-` prefix is excluded by default.

## 4. Set the token on the gateway

`SLAUDE_BRAIN_IMPORT_TOKEN` is the credential for the endpoint. Unset means the route does not exist (404 for every path and method). Rules:

- At least 32 characters, and never equal to the node token (an equal value counts as unset).
- Put it in the **gateway** Secret only. It is on the gateway-only list: a node refuses to boot holding it, and the agent child's environment never inherits it.
- **Mono deployments:** the route is also mounted on the `mono` role, where the agent child runs as the same OS user as the gateway and can read the token from the process environment. Set it only for the duration of the import, then unset it and restart.

Roll the gateway so it picks the value up. Generate one with `openssl rand -hex 32`.

## 5. Dry run

```bash
export SLAUDE_BRAIN_IMPORT_TOKEN=...      # the client reads this variable; there is no --token flag
bun run brain-import --gateway https://gateway.example.com --persona ana --dry-run ./bundle
```

`--token-env VAR` names a different variable to read. Expected output:

```
batch of 100 sent
...
DRY RUN target agent slice: agent-uana1x
  agent-uana1x                       written=412 skipped=0 overwritten=0 failed=0 links=0 written/0 dropped/0 failed no-embedding=0
  user-UTESTUSER1                    written=36 skipped=0 overwritten=0 failed=0 links=0 written/0 dropped/0 failed no-embedding=0
  shared                             written=9 skipped=0 overwritten=0 failed=0 links=0 written/0 dropped/0 failed no-embedding=0
```

A dry run predicts page outcomes only; it does not predict transaction failures or links. Check `target agent slice` first.

**The default persona** (`--persona default`) maps to the gateway process's own agent id. If that id resolved to the literal `default` (the Slack identity was not resolved), the import would land in `agent-default`. The dry run prints the real target; if it is not the slice you expect, stop and fix the identity before applying.

## 6. Apply

Do this before the persona's Slack traffic is cut over to the gateway, so the persona does not write new memory into the slice while it is being filled.

```bash
bun run brain-import --gateway https://gateway.example.com --persona ana ./bundle
```

Same output as the dry run without the `DRY RUN` prefix. Exit codes:

| Code | Meaning |
|---|---|
| 0 | Every page of the manifest is accounted for and nothing failed. |
| 1 | A failure (failed page, failed links, a refused batch, an unreachable gateway) or a count mismatch between the manifest and what the gateway reports. Failed slugs and reasons are printed on stderr; slugs of `user-*` slices are never listed. |
| 2 | Usage error: missing flag, missing token variable, bad `--on-conflict` or `--map`. |

Batches are 100 pages or 1 MB. A 5xx or network error is retried up to five times with backoff; a 4xx stops the run with the gateway's message.

`--on-conflict skip|overwrite|fail` chooses what happens to a page that already exists (default `skip`). `--map from=to` routes a source explicitly, and a target must be the persona's slice, a `user-*` slice, `shared` or `public`.

## 7. Re-runs and conflicts

- **`skip` is idempotent.** An existing page's content is left alone, but its links are still written (links are additive and idempotent). Links are written after pages, so a link to a page that landed in a later batch is dropped on the first run. Re-run the same command once and it resolves. The client prints a hint when links were dropped. Links into `kb-*` or unmapped sources are never imported, so the hint can repeat on every re-run; that is expected. Rewriting an identical edge resets its context text to the bundle's.
- **`overwrite`** replaces the page row's content, chunks, tags, timeline, raw data and its outgoing links. The page row itself is kept, so links pointing at it from other pages survive. Between the content write and the link pass there is a crash window: the page's outgoing links are absent until the links pass runs. Re-running restores them.
- **`fail`** marks an existing page failed and changes nothing for it. Caveat: a retry after a 5xx can find a half-applied batch already present and mark those pages failed. Use `skip` for resumable runs.
- **`shared` and `public`: first import wins under `skip`.** When importing several agents into one gateway, import `shared` from one reference agent, or use `--on-conflict overwrite` or `--map shared=...` deliberately.
- **`user-*` slices keep their id**; they land in the same slice on the gateway.
- **Soft-deleted pages in the target.** Under `skip` a soft-deleted page counts as existing and stays deleted. Under `overwrite` it may stay hidden. Purge the page first if you want the bundle's version visible.

## 8. Verify

1. Ask the persona something only the old agent knew; it should recall it from memory.
2. Compare the printed counts with the inventory from the export. The client already fails with `MISMATCH agent slice: expected N pages, gateway accounted for M` when they differ.
3. Check the persona's view in the control panel.

## 9. Cleanup

Unset `SLAUDE_BRAIN_IMPORT_TOKEN` and roll the gateway. Delete the bundle directory: it holds user memory in plain text.

## 10. Rollback

Nothing outside the persona's slices (its `agent-*` slice plus any `user-*`, `shared` and `public` pages in the bundle) was written. To undo, restore the `pg_dump` taken in section 2.

## 11. Troubleshooting

Gateway refusals:

| Status and message | Cause | Fix |
|---|---|---|
| 404 `not found` | Token unset or under 32 characters (or equal to the node token), node role, wrong path | Set the token on the gateway and roll it; the route is `/brain-import/v1/personas/<persona>` |
| 401 `invalid or missing brain-import token` | Wrong or missing bearer | Export the same value the gateway holds |
| 405 `method not allowed` | Not a POST | Use the CLI |
| 409 `the brain is disabled on this gateway` | `SLAUDE_BRAIN_DISABLED` | Enable the brain |
| 409 `brain import is not supported with SLAUDE_BRAIN_MODE=remote` | Remote brain mode | Import on a gateway with the local engine |
| 413 `body exceeds 4194304 bytes` | Batch over 4 MB | Re-export; a single page larger than the cap cannot be imported |
| 422 `body must be JSON` / `invalid body: <path> <code>` | Client/gateway version skew or a damaged bundle | Use CLI and gateway from the same release; re-export |
| 409 `persona '<name>' is not live or has no Slack user id` | Unknown persona, or its Slack user id is empty | Create the persona with a Slack user id first |
| 422 `map target '<to>' (from '<from>') is not the persona's agent slice, a user slice, shared or public` | `--map` points elsewhere | Map only to allowed targets |
| 422 `source '<id>' kb-* sources are out of scope (re-created from the manifest)` | A `kb-*` source in the bundle | Re-export without it |
| 422 `source '<id>' has no mapping (use map)` | A source that is not agent-like, `user-*`, `shared` or `public` | Add `--map <id>=<target>` |
| 422 `source '<id>' maps to a forbidden target` | A map entry resolved to a disallowed target | Fix the map |
| 409 `embedding mismatch: ...` | Dimension (or both-known model) differs | Align `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS`, or re-export from a matching brain |
| 422 `embedding length does not match the declared dimensions` | A vector of another width than the manifest declares | Re-export; do not edit the bundle |

Client and export errors:

| Message | Cause and fix |
|---|---|
| `usage: brain-import --gateway <url> --persona <name> ...` (exit 2) | Missing `--gateway`, `--persona` or bundle |
| `set SLAUDE_BRAIN_IMPORT_TOKEN in the environment (never a flag)` (exit 2) | Export the token variable |
| `--on-conflict must be skip, overwrite or fail` / `--map expects from=to, got '...'` (exit 2) | Fix the flag |
| `bundle has no manifest.json (interrupted export?)` | The export did not finish; export again |
| `pages.jsonl checksum does not match the manifest` | The bundle was modified or truncated; export again |
| `unsupported bundle version ...`, `manifest has no files checksum`, `manifest is missing engine or sources` | Bundle from another version or damaged |
| `source 'kb-...': kb-* sources are never imported; re-export without them` | Re-export without kb sources |
| `source(s) with no mapping: ... (use --map from=to)` | Map each listed source |
| `--map a=kb-x: kb-* sources are never an import target` | Choose an allowed target |
| `gateway unavailable after retries (<status>)` | Gateway down or erroring; re-run (skip is idempotent) |
| `gateway refused the batch (<status>): <message>` | See the gateway table; earlier batches already landed, and a re-run under `skip` is safe |
| `brain home '<dir>' has no db directory` (export) | `--home` is not a PGLite brain home |
| `MISMATCH <slice>: expected N pages, gateway accounted for M` (exit 1) | Pages missing from the responses; re-run and compare |
