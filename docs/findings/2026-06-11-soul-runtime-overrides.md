# Soul runtime overrides — manager-editable ACLs without redeploy (2026-06-11)

## Problem

SOUL.md ACLs (`trustedChannels`, `allowedChannels`, `dmAllowedUsers`,
`blockedUsers`) were static: any change meant editing the file and
rebooting. The manager needs to trust a new channel, allowlist a DM user, or
ban a noisy user at runtime.

Full design: `docs/superpowers/specs/2026-06-11-soul-runtime-overrides-design.md`.

## Shape

- **Store:** `soul_overrides` sqlite table — `(field, value)` primary key,
  `action ∈ {add, remove}`, latest write wins, audited (`created_by`,
  `created_at`).
- **Merge:** `soulData()` applies `(base ∪ adds) − removes` on **every
  read**. All gates call `soulData()` per inbound message and never cache
  across messages → an override is live on the next message in every
  session, no reload. `soulDataBase()` exposes the un-overlaid view for
  provenance rendering.
- **Full shadow:** a runtime `remove` masks an entry that comes from SOUL.md
  itself. `/soul list` shows soul-vs-runtime provenance so drift stays
  visible; `/soul clear` reverts to pure SOUL.md.
- **Surfaces:** `/soul <trust|allow|dm|block> <add|remove> <id>` slash
  command + `soul_override` tool on the surface MCP. Both write through one
  validated helper (`mutateOverride` in `src/soul/overrides.ts`).

## Authority — deliberate choices

- **Primary manager ONLY.** Backup manager and approvers are excluded
  (owner: "only Manager"). Loosening is a one-line change at each gate.
- Both surfaces gate on the **signed inbound Slack user id** — the MCP tool
  checks the turn initiator via a live getter over the route ctx, so a
  prompt-injected model call cannot mutate ACLs from a non-manager turn.
- Self-lockout guard: `blockedUsers` can never contain the manager id.

## Gotchas hit

- `setSoulData()` memo holds the **base**; the overlay is applied in
  `soulData()` after memo resolution — so test fixtures injected via
  `setSoulData` still see runtime overrides (and the memo path stays
  override-aware in prod).
- The overlay read is wrapped in try/catch returning base — a corrupt
  overrides table must never take the engagement gates down.
- `soul_override` only mounts when the gateway passes an `initiator`
  resolver to `createSurfaceMcp` — legacy callers (tests, sim) without one
  get no tool rather than an ungateable one.
