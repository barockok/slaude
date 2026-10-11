# HA release plan

**Date:** 2026-10-03 · **Revised:** 2026-10-04 (after design review)
**Umbrella:** `2026-10-03-centralized-persona-runtime-design.md` — this is WS-E
**Mechanics:** `.claude/skills/release-prep/SKILL.md`, `scripts/promote-rc.sh`,
`.github/workflows/release.yml`, and the release rules in `CLAUDE.md`

## 1. Intent

Ship WS-A to WS-D in an order that can be rolled forward and back, soaked against real
conditions, and verified by the gate in §6, without any single step being hard to undo. Nothing here
is tagged, pushed to a release or deployed without the operator's explicit go at the points in §7.

## 2. Where we start

Current stable is `v0.44.0` (`package.json` agrees). The last release candidates were
`v0.42.0-rc.1…4`. The repo's rule: anything touching `install.sh`, the dist or version layout, the DB
schema or the agent loop goes out as `vX.Y.Z-rc.N` first; an RC publishes as a GitHub pre-release and
`install.sh` never resolves it as `latest`; notes live under the **stable** name from the first RC; the
tag and `package.json` must agree.

## 3. What goes in which release

| Release | Contents | Path | Why |
|---|---|---|---|
| **v0.44.1** | WS-D D1 **except D1.2** (H1, H3, H5, and the raw-error-text fix D1.6), D2 (H4, H7, H8), the harness fixes in D3, D5.1 stage one (payload `version`, unknown fields reported), D5.2 if it reproduces, and **WS-B phase 0 stage one** (the gateway/node Secret split in the manifests, the node boot *warning*) | direct | no schema, no install path, no agent-loop change; every item is a bug fix or a warning |
| **v0.45.0-rc.N** | D1.2 (per-request Slack client), WS-A (provider credentials), WS-B (node credentials, `runs_on`, label queues, the gate, the manifest, the boot *refusal*), WS-C (KB scope, the MCP bridge, panel views), D5.1 stage two (unknown fields refused) | release candidate | DB schema (three additive columns), node authentication, queue topology, the bundle contract, the tool plane and the agent loop |
| **v0.45.0** | the last green RC, promoted | `promote-rc.sh` | after the gate in §6 |

D4 (verification tasks and documentation) is not a release of its own: it produces evidence the gate
requires and docs that ship with `v0.45.0`.

**Why D1.2 left the patch release.** It threads a per-request client through the gates, surfaces,
presence, status, the reaction fallback and cron: a refactor across the whole outbound path. "Almost no
risk" was wrong. It rides the RC series where it soaks with everything else that touches the transport.

**Why the Secret split is split in two.** Moving the gateway's secrets out of the node Secret is a
deployment change an operator must do; making a node refuse to boot on its absence would stop a cluster
that has not done it. Stage one **warns** and counts, so every operator sees the problem in a patch
release; stage two **refuses**, with a documented temporary escape, in the minor.

**Why one minor for A, B and C.** They share the bundle contract and the node's resolver, and WS-B's gate
exists to protect what WS-A resolves and what WS-C bridges. Shipping them in separate minors would mean
supporting intermediate states nobody wants. The RC train lets each land and soak before the next is added.

## 4. The RC train for v0.45.0

RCs are snapshots of `main`, cumulative. A fix found in soak goes to `main` and a new `-rc.N` is cut; an RC
tag is never patched in place.

| RC | Adds | Soak focus |
|---|---|---|
| `rc.1` | WS-A: provider references, resolver, Vault backend (behind `SLAUDE_VAULT_ADDR`); D1.2 | per-persona keys; rotation at spawn/reload; Vault down; two registered Slack apps |
| `rc.2` | WS-B: node credentials, `runs_on`, label queues, the gate, route table, manifest, stalled-job rescue, boot refusal | mixed legacy/signed nodes; the gate; relabel; unserved label; legacy door closed |
| `rc.3` | WS-C: `kb_sources`, the MCP bridge, panel persona views | KB scope; bridged MCP as agent and as user; SSRF policy; panel |
| `rc.4+` | fixes from soak | |

**Migrations.** WS-A, WS-B and WS-C each add one additive nullable column (all Postgres-only, like the
`personas` table). Numbers are assigned **when each merges**, in merge order, not now: two branches that both
claim the next number would fail the migration runner. Each migration is independent and idempotent
(`ADD COLUMN IF NOT EXISTS`). WS-B also adds one small table (node credential revocations).

**Notes.** `docs/site/_content/releases/v0.45.0.md` is written before `rc.1`, hand-written, grouped Features /
Fixes / Docs / Internal, explaining *why*, linking each workstream's field note, updated as RCs add scope, and
stating the **exposed-secrets rotation** (§5). `v0.44.1.md` is written for that release.

## 5. Compatibility, rollout order and rollback

**Upgrade order is gateways first, then nodes**, for every release in this plan.

| Combination | Behaviour |
|---|---|
| new gateway, old nodes | old nodes use the static token, are label `default`, consume `turns`; personas without `runs_on` are `default`; nothing changes |
| new nodes, old gateway | a node with the static token behaves as before; a node with a signed credential is rejected (401) at boot with a clear message |
| bundle with `mcpServers` or provider references, old node | the old node ignores fields it does not know. **Not safe for provider references:** it ignores `ownProvider`, so it fills every field the persona left out from its own environment and sends the persona's resolved key to the node's own `ANTHROPIC_BASE_URL`, a host the persona never named. Set provider references only after every node is upgraded (corrected in U17) |
| `/deploy` payload with a newer field, **old** gateway | v0.44.1 reports the unknown field (`ignoredFields`); v0.45.0 refuses it; before v0.44.1 the old gateway **silently drops it** |
| node pod that still loads the gateway Secret | v0.44.1 warns; v0.45.0 refuses to boot unless `SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1` |
| `SLAUDE_PROVIDER_ENV_FALLBACK` | defaults to today's behaviour; the default is not changed in this plan (parked) |
| `SLAUDE_NODE_KEY` unset | signed credentials are not accepted; the legacy token is the only door |

**The exposed-secrets rotation.** Any cluster that ran nodes with the shared Secret must treat
`SLAUDE_JOB_SECRET` and `SLAUDE_MASTER_KEY` as exposed to node pods. Rotating `SLAUDE_JOB_SECRET` is supported
(drain, write the new value, restart the gateways). **Master-key rotation is NOT supported in v0.45.0:** no tool
re-encrypts stored credentials under a new key (decided in U17; an earlier draft of this paragraph assumed one).
For the master key the procedure is: discard the stored credentials and re-enter them (re-run onboarding and the
MCP and provider connects), or keep the key and record the exposure. The re-encryption tool is a **pre-stable
follow-up**. The release notes and the multi-node guide state this.

**Rollback is not inert once a feature is configured.** An earlier draft claimed it was. It is only true for
a cluster that has not yet set a reference, a label or a KB list. After they are set:

| What was configured | What older code does after a rollback |
|---|---|
| `provider` references (WS-A) | ignores the column; managed personas fall back to **node-env credentials** |
| `runs_on` (WS-B) | ignores it; every persona runs on `default` |
| `kb_sources` (WS-C) | ignores it; every persona regains **all** knowledge sources |
| node credentials (WS-B) | older gateways reject them (401); nodes must go back to the static token |

A `/deploy` that reaches an old replica mid-rollout records the revision and drops the new fields (before
D5.1). So the plan ships a **configured-then-rolled-back runbook**: before rolling back, remove the references,
labels and KB lists through a sync, or accept the table above; and the soak includes a configured-then-rolled-back
rehearsal. Unsetting `SLAUDE_VAULT_ADDR` and clearing references undoes WS-A; moving nodes back to the static
token undoes WS-B; leaving `kb_sources` null undoes WS-C. Each feature is inert **until configured**, which is
what makes an RC safe to *install*; it is not what makes a *configured* cluster safe to roll back.

## 6. The release gate

**For v0.44.1 (direct).** `bun run typecheck`, `bun test` with zero failures, the installer smoke test, the leak
scan, CI green on the PR, the D1/D2 tests from the hardening spec passing, the D5.1 stage-one tests, and the node
boot *warning* visible in a `k8s-local` run.

**For promoting v0.45.0.** All of the following, on a cluster at the documented size (WS-D, D3.6):

1. WS-A, WS-B and WS-C (with the bridge) are merged with their tests, and D1.2 with the two-app Slack test.
2. `verify-ha.sh` and `verify-turns.sh` pass completely, with no *could not measure*, **twice in a row**, against
   **signed-credential nodes and legacy-token nodes**, and once with the **legacy door closed**.
3. The nightly HA suite (fake Slack plus the mock LLM) is green on `main` — **the last three consecutive
   nightly runs, one of them on the RC's commit**.
4. A real-Slack smoke run on the RC following the runbook below, each step passing.
5. D4.4 (the cluster proof for personas as code) has been run once on a real managed cluster, and its result
   recorded.
6. H1, H3, H4, H5, H6, H19 are fixed (v0.44.1 or earlier); H2 (D1.2), H7, H8 are fixed or consciously deferred in
   the notes; H12, H13, H14, H17 are resolved or measured and documented; the stalled-active-job rescue, the
   unscoped KB tools and the raw-error-text fix are fixed; D5.2 is reproduced and fixed or shown not to apply.
7. **Alerts and runbooks exist and have been exercised**: Vault unreachable; a label with no live node; a node
   credential within 14 days of expiry; a rising rate of 403 from the gate; the legacy door in use while a node key
   is configured; a node pod holding gateway-only variables.
8. **A capacity check:** a run with several label queues and the node counts they imply, recording Redis
   connections (one per worker per node), memory, and the gateway's added load from the MCP bridge; the numbers are
   in the notes, not assumed. Recorded in a copy of
   [the capacity check template](../plans/2026-10-05-capacity-check-template.md).
9. The configured-then-rolled-back rehearsal (§5) has been run once.
10. Docs and field notes are merged (§8).
11. The soak below has completed with no open defect that affects a turn, a credential or a queue.

**Real-Slack smoke runbook** (kept in the `k8s-local` README, generic names): mention the agent and get a reply;
follow up in the thread without a re-mention; click an approval and then click it a second time (the card must
survive); run `/link`; kill the node running a live turn and watch the answer arrive; rotate a provider secret in
Vault and see a **new thread** use it; relabel a persona and see the next turn land on the other label and an
in-flight turn re-dispatched once; call a bridged MCP tool as the agent and, in a 1:1, as the user; revoke an MCP
grant upstream and see the fixed error and the connect card.

**Soak.** Install the RC explicitly (`SLAUDE_VERSION=0.45.0-rc.N`) on a cluster used for real work: at least
**three days** with real traffic, or at least one full nightly cycle plus the runbook, whichever is longer. The
duration is the operator's call (§9).

## 7. Explicit-go points

The operator's rule (pause for an explicit go before tags, releases and deploy bumps) applies at each of these. No
step proceeds on the strength of an earlier approval:

1. Merging the WS-D PR for v0.44.1, and tagging `v0.44.1`.
2. Cutting each `v0.45.0-rc.N` (editing `package.json` to the full RC string and tagging).
3. Rotating `SLAUDE_JOB_SECRET` and `SLAUDE_MASTER_KEY` on any cluster (it is irreversible for stored ciphertext
   unless the re-encryption step runs).
4. Promoting `v0.45.0` with `scripts/promote-rc.sh` (run `--dry-run` first).
5. Any deploy-version bump of a running cluster.

## 8. Documentation and records

- **Release notes:** `v0.44.1.md` and `v0.45.0.md`, per the repo template.
- **Field notes** (`docs/site/_content/field-notes/<date>-<slug>.md`, indexed in `CLAUDE.md`'s Findings Log, newest
  first), one per workstream: what was decided, what was measured, what went wrong. The WS-D note records the
  defects' mechanisms, not the operator's deployment. The MCP bridge note records the spike.
- **Docs pages:** provider credentials and Vault (including the trust model and the service-account rule); node labels,
  the node credential, the Secret split, the stdio manifest and the stated limits (WS-B §4.9, §4.12); the MCP bridge
  and its limits (§4.2.9); the persona definition and panel views; the local-cluster runbook (forward script,
  tunnels, sizing floor); a rollback runbook; an alerts runbook; configuration reference entries for every new variable.
- **Public-repo hygiene on every commit:** the pre-commit leak scan, no scratch artifacts, no AI co-author trailer,
  generic names in all examples.

## 9. Open decisions

1. **Soak length** for `v0.45.0` (three days proposed).
2. **Whether v0.44.1 waits** for D3's harness fixes or ships with D1 and D2 only.
3. **Whether the panel persona views** (WS-C) may ship in a later minor if the rest is ready.
4. **Which managed cluster** hosts the one-time proof in the gate (WS-D, D4.4).
5. **Whether D5.2** (if it reproduces) ships as its own patch release immediately rather than waiting for v0.44.1.
