# HA delivery process and tracker

**Date:** 2026-10-04
**Specs:** `docs/superpowers/specs/2026-10-03-*.md` (umbrella plus WS-A to WS-E), approved by the operator
**Branch:** `ha/dev` (integration branch; nothing here merges to `main`, tags or releases without the operator's
explicit go, per WS-E §7)

## How the work is done and checked

Work is split into units. Each unit goes through the same loop, with the roles separated so that nobody marks
their own work complete.

| Role | Who | Does | Does not |
|---|---|---|---|
| Orchestrator | the lead session | writes the unit brief from the spec, owns git and merges, re-runs typecheck, the unit's tests and the leak scan itself, decides accept or reject | trust an agent's report without re-running it |
| Implementer | a subagent in its own git worktree off `ha/dev` | writes the test first, implements, commits granularly, reports requirement → code → test | merge, push, tag, touch a live cluster, add an AI trailer |
| Reviewer 1 — spec compliance | a *different* subagent | checks every requirement of the unit against the diff and asks whether each test would fail without the behaviour | edit anything |
| Reviewer 2 — adversarial | a third subagent, for units that touch credentials, node auth, the gate, queues or the MCP bridge | looks for secret leakage, auth bypass, SSRF, races, mixed-version breaks, scope creep | edit anything |

A unit is **accepted** only when: both reviewers return PASS (or all BLOCKER and MAJOR findings are fixed and
re-reviewed), `bun run typecheck` exits 0, the unit's tests pass, the leak scan is clean, and the orchestrator has
merged it into `ha/dev` and re-run the affected suites on the merged result. Fix rounds are capped at two per unit;
anything still open is recorded here as an open issue and the work continues.

Guardrails for every agent: public-repo rules from `CLAUDE.md`, generic placeholders only, no real secrets, no
commands against the operator's running cluster (offline validation only), no pushes, no AI co-author trailers.

At the end the whole branch is verified together: the full test suite against Redis and Postgres, the typecheck, the
shellcheck set CI uses, the manifest builds, a cross-unit review by a fresh reviewer, and a written list of what the
operator needs to run on the real cluster.

## Units

Status values: `todo`, `in progress`, `in review`, `accepted`, `blocked`.

### Stage 1 — patch-release class and foundations

| Unit | Content | Spec | Status |
|---|---|---|---|
| U1 | Versioned `/deploy` payload, unknown fields reported | WS-D D5.1 | todo |
| U2 | Slack HTTP-mode correctness, scopes, typed failure text | WS-D D1.1, D1.3, D1.5, D1.6 | todo |
| U3 | Approval cards, portal unlink, `/mcp` per persona | WS-D D2.1–D2.3 | todo |
| U4 | Local cluster and verify harness, runbooks | WS-D D3.1–D3.7, D4.1, D4.5 | todo |
| U5 | Secret split, ServiceAccounts, node boot warning | WS-B §4.0 stage one | todo |
| U6 | Model-child lockdown, one outbound-fetch policy | WS-D D5.2, D5.3 | todo |

### Stage 2 — features (release-candidate class)

| Unit | Content | Spec | Status |
|---|---|---|---|
| U7 | Per-request Slack client | WS-D D1.2, D1.4 | todo |
| U8 | Provider credentials by reference, Vault | WS-A | todo |
| U9 | Node credential, `authenticateNode`, route table, gate, endpoint hardening | WS-B §4.1–§4.4 | todo |
| U10 | `runs_on`, label queues, dispatch, worker, reaper, unserved labels, typed relabel | WS-B §4.5–§4.8 | todo |
| U11 | Node-local stdio manifest, plugin allow-list, strict MCP config | WS-B §4.10 | todo |
| U12 | MCP bridge | WS-C §4.2 | todo |
| U13 | KB scope, scoped list tools, skills provenance, memory-provider check | WS-C §4.1, §4.3 | todo |
| U14 | Panel persona API and screens | WS-C §4.4 | todo |

### Stage 3 — cluster setup for the operator's mock test, docs, closeout

| Unit | Content | Spec | Status |
|---|---|---|---|
| U15 | `k8s-local` for the full topology (split Secrets, labelled node deployments, dev Vault, bridge upstream, runbooks), docs, field notes, release-note drafts | WS-D, WS-E §8 | todo |
| U16 | Whole-branch verification and cross-unit review | all | todo |

## Open issues

None yet.
