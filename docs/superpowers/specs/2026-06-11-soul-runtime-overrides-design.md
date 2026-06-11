# Soul runtime overrides — design (2026-06-11)

## Problem

SOUL.md is operator-authored and static: changing `trustedChannels`,
`allowedChannels`, `dmAllowedUsers`, or `blockedUsers` requires editing the
file and redeploying/rebooting. The manager needs to adjust these ACLs at
runtime — add a channel the agent should join, allowlist a DM user, ban a
noisy user — without touching SOUL.md.

## Decisions (locked with owner)

- **Interfaces:** both a slash command and an MCP tool, sharing one store.
- **Authority:** **primary manager only** — `soul.manager.userId`, checked at
  the gate. Backup manager and approvers are excluded (owner: "only Manager").
  Loosening to backup later is a one-line change in the auth helper.
- **Remove semantics:** full shadow — a runtime `remove` masks an entry that
  comes from SOUL.md itself. Runtime view = `(soul ∪ adds) − removes`.
- **Fields (v1):** `trustedChannels`, `allowedChannels`, `dmAllowedUsers`,
  `blockedUsers`. Nothing else (approvers/redactPatterns deliberately out).
- **Immediacy:** an override takes effect on the next inbound message in
  every session — no reload, no restart, no per-session state.

## Store

New table in the existing bun:sqlite db (consistent with `ignores`,
`one_on_one_locks`; transactional; audited; survives restarts on the PVC):

```sql
CREATE TABLE IF NOT EXISTS soul_overrides (
  field      TEXT    NOT NULL CHECK(field IN
              ('trustedChannels','allowedChannels','dmAllowedUsers','blockedUsers')),
  value      TEXT    NOT NULL,
  action     TEXT    NOT NULL CHECK(action IN ('add','remove')),
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (field, value)   -- one verdict per id; latest write wins (upsert)
);
```

`value` is validated at write time with the same regexes as `SoulDataSchema`
(`^[CGD][A-Z0-9]+$` channels, `^[UW][A-Z0-9]+$` users) — the store never
holds malformed ids. `<#C…|name>` / `<@U…>` wrappers stripped before
validation.

## Merge — the immediacy mechanism

`soulData()` (src/soul/extract.ts) is the single accessor all 22 consumers
use — the engagement gate, channel-mode gate, DM allowlist, and blocklist all
call it **per inbound message**. The merge happens inside `soulData()`, on
every call, after base resolution (memo / disk cache / regex fallback):

```
effective[field] = (base[field] ∪ adds[field]) − removes[field]
```

Because no consumer caches the result across messages, an override is live on
the very next message in **any** session/channel/DM — no reload required.
The overlay read is one indexed SELECT against local sqlite per call;
negligible.

Implementation: pure function `applyOverrides(base: SoulData, rows:
OverrideRow[]): SoulData` in new `src/soul/overrides.ts` (unit-testable, no
I/O), plus `src/db/soul-overrides.ts` for the table access. `soulData()`
composes the two. `memo` (set by `setSoulData`) holds the **base** only; the
overlay is applied on read so tests that inject fixtures still see overrides.

Note: `assertIdsGroundedInPersona` keeps guarding the **extraction** path
(LLM must not invent ids). Overlay ids are exempt — they are explicit manager
actions, grounded by the auth gate instead.

## Slash command

```
/soul trust  add|remove <#C…|id>     → trustedChannels
/soul allow  add|remove <#C…|id>     → allowedChannels
/soul dm     add|remove <@U…|id>     → dmAllowedUsers
/soul block  add|remove <@U…|id>     → blockedUsers
/soul list                            → overlay vs SOUL.md base, who/when
/soul clear  trust|allow|dm|block|all → drop overrides (revert to SOUL.md)
```

Parsed in `src/gateway/slack/commands.ts` (same pattern as `/cron-add`),
handled in the gateway slash dispatcher. Auth: inbound `userId ===
soulData().manager.userId`, checked **before** any parsing side effects.
Non-manager gets a refusal reply, no mutation. Works anywhere the manager can
already chat (DM or channel).

`/soul list` renders provenance per field: which ids come from SOUL.md,
which are runtime adds, which SOUL.md ids are masked by removes — so drift
from the file is always visible.

## MCP tool

`soul_override` on the surface MCP server (where `reply` lives — it is
session-bound and the route ctx carries the inbound `userId`):

```
soul_override({ field: 'trust'|'allow'|'dm'|'block',
                action: 'add'|'remove'|'list'|'clear', value? })
```

Gate: the **current turn's inbound userId** must equal
`soulData().manager.userId`. Non-manager turn → tool returns a refusal
string, no mutation, no approval button (owner decision: manager at gate is
the control). The tool writes through the same `src/db/soul-overrides.ts`
helpers as the slash path — one store, one validation.

Prompt-injection posture: the tool only works inside a turn initiated by the
manager's own Slack message. A non-manager cannot cause a mutation even if
they convince the model to call the tool, because the gate checks the signed
inbound user id, not the model's intent.

## Safety rails

- `blockedUsers` may never contain `manager.userId` (self-lockout guard) —
  rejected at write with explanatory reply. Backup manager may be blocked
  (consistent with manager-only authority).
- Removing a channel from `trustedChannels` while a session is live there:
  next message simply gates as untrusted/unlisted. No session teardown.
- `dmAllowedUsers` removal: next DM from that user drops at the whitelist
  gate.
- All writes log `[soul-override] field=… value=… action=… by=…`.

## Testing

- **Unit (overrides.ts):** add; remove shadowing a SOUL.md entry; add then
  remove (latest wins); duplicate add idempotent; malformed id rejected;
  manager-block rejected.
- **Gateway seam:** `/soul trust add <#C…>` from manager → next message in
  that channel passes the gate (immediacy); `remove` → dropped; non-manager
  `/soul …` → refused, store untouched; `/soul block add` drops user's next
  message.
- **MCP:** manager-initiated turn mutates; non-manager-initiated turn
  refused.

## Out of scope (v1)

- approvers / redactPatterns / identity overrides
- approval-button flow for the MCP path
- persistence back into SOUL.md (overlay is deliberately separate; operator
  reconciles the file manually using `/soul list` provenance)
