---
title: "Boxes, phases 1 and 3: the sandbox seam and box definitions, both dark"
date: 2026-11-24
---

# Boxes, phases 1 and 3: the seam and the definitions

**Date:** 2026-11-24
**Status:** on the branch, not released. Design: `docs/superpowers/specs/2026-11-24-box-design.md`. Plan: `docs/superpowers/plans/2026-11-24-box-implementation.md`.

## What exists now

Nothing a deployment can see. `SLAUDE_BOX` is `off` on the gateway and
`SLAUDE_BOX_TIER` is `none` on nodes, and with both at their defaults no
session, bundle, ETag or session row differs from before.

- **The seam.** `AgentManager.setSandboxResolver` asks one resolver for a
  session's sandbox. A sandbox adds `spawnClaudeCodeProcess` to the boot
  options and nothing else. A null answer is tier `none`. A resolver that
  throws fails the boot with `BOX_UNAVAILABLE`. No resolver is installed
  outside tests: the driver that would install one is a later phase.
- **The environment of a boxed spawn** (`src/box/env.ts`) is built from
  nothing, never filtered from the node's.
- **Definitions.** `boxes/<name>/box.yaml` in the deploy repository, one Zod
  schema, a generated JSON schema. `personas render` compiles each box to a
  payload entry with an image digest. The gateway stores a box as a row plus
  one row per version, signs the set, and with `SLAUDE_BOX=on` pins each
  session of a boxed persona to a digest and sends its turns only to a node
  that offers the box's tier.

## Decisions taken while building it

**The builder is stricter than the design's wording.** The design passes every
`ANTHROPIC_*` and `CLAUDE_*` name outside the four provider keys into a box.
The bundled CLI keeps adding provider modes with their own keys and switches
under those prefixes, so the builder passes an `ANTHROPIC_*` name only when it
is a model name, never passes a `CLAUDE_*` name of a provider-selecting family
or one that reads like a credential, and drops any copied value that is shaped
like a secret. A property test feeds it random secret-shaped values under
random names and looks for them in the output.

**Tier order through an exact-match gate.** Dispatch compares capability
strings exactly, and tiers are ordered (`none < bwrap < gvisor`; a box states
the weakest tier it accepts). A node therefore advertises the capability of
every sandbox tier at or below its own: a `gvisor` node also advertises
`box-tier/bwrap`. The design says a node advertises the strongest tier it
offers; with one string a box that accepts `bwrap` would never match a
`gvisor` node.

**The pinned digest travels in the session view, not the bundle.** A node
caches a runtime bundle per tenant and persona, so a per-session digest cannot
live in it. The bundle carries the box's name, the image and digest of its
current version, and its current policy; the session view carries `box_name`
and `box_digest` for a pinned session. `src/box/session-box.ts` joins the two
and fails the boot when they disagree. Egress rules are read from the bundle
source on every call, which is what lets an allowlist change reach a running
session at its next connection.

**The three box tables are Postgres only.** `personas` is Postgres only, and a
box is declared by a persona sync, which sqlite does not run. `sessions` gains
its two columns in both dialects. A read on sqlite answers "no boxes" without
touching a table.

**A session row keeps its old shape unless it is pinned.** The first version
returned `box_name: null` on every row, and the node's REST session store
test, which compares the two row shapes key by key, failed. The two keys are
now part of a row only when both are set.

**A row replayed from a deleted box.** A box that is removed and created again
restarts at version 1, so an old version 1 row would carry a valid signature
for the same name and number. Each row's signature and the manifest's list
include the manifest version the row was written at, and the old row no longer
matches.

**`${` is refused twice.** On the parsed tree first, so the message can name
the field, then on the text, which also covers a comment and anything a YAML
feature hid.

## What is assumed, not measured

**Provider credential forms.** `src/box/provider-forms.ts` holds one set,
`BOX_SUPPORTED_PROVIDER_FORMS`, with all three forms in it. That is the
assumption written before the provider proxy spike (plan, spike 3) was run.
A form outside the set makes a persona not boxable: the sync warns, dispatch
leaves it unboxed, and the bundle carries no box for it. When the spike's
result is in, the set is the one line to change.

**The placeholder credential.** A box's credential variable holds a fixed
placeholder string. Whether the CLI checks a credential's shape locally is one
of the things the same spike records.

## Known gaps

- A whole signed box set replaced by an older signed set verifies. Guardrails
  close that with a high-water mark kept outside the database; boxes do not
  have one yet.
- `personas render --no-push` reports a stand-in digest for an image that is
  not in the registry, so a pull request's dry run can print "image: new
  digest". The command says on stderr that such a payload must not be
  deployed; nothing on the gateway refuses it. A session pinned to such a
  digest could not start (it fails closed).
- `slaude box check` validates the files. It does not look inside an image;
  a node does that when it unpacks one (a later phase).
- The docker-based registry lookup and build were exercised with a fake
  process runner only. No real registry was used.
- The console has a read-only route (`GET /panel/api/boxes`) and no page yet.
- `personas export` does not write the `box` key back into an agent.yaml.

## Tests

Unit tests run in the default suite. The sync, bundle and store tests that
need the persona tables run under `SLAUDE_DB=pg` (PGLite locally). Nothing in
these two phases needs Linux, root or a sandbox runtime.
