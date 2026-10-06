---
title: "Provider credentials by reference: an atomic set, a fatal failure, and a token that is a secret too"
date: 2026-10-05
---

Until this work every persona on a node ran on the node's own LLM provider
variables, or on encrypted `provider_creds` rows that only an operator could
write. A persona managed as code could not say "use this key". Now it names
**where** its key is (`vault://<mount>/<path>#<field>` or `env://PERSONA_<NAME>`),
the gateway resolves the reference when it builds the runtime bundle, and the
node puts the value in the agent child's environment. This note records what
was decided, what was measured and what went wrong. The operator procedure is in
[Provider credentials](../deploy/provider-credentials.md).

## Decisions

**Resolve at bundle build, not by rotation fingerprint.** The first design
re-resolved on a timer and rebooted warm sessions when a credential's
fingerprint changed. Review dropped it for something simpler that needs no
derived value of the secret anywhere: a credential is read when a session
starts, resumes after the idle TTL, or reloads. A new thread therefore uses a
rotated key (after the gateway's cache TTL, 60 s by default); a warm thread keeps
the key it booted with until `/reload`.

**The `provider` object is one atomic set.** When a persona sets any field, all
of its provider variables come from that object: never mixed with a
`provider_creds` row, never filled from the node's environment. The reason is a
credential-capture path: with per-field precedence, a repository change could set
a persona's `baseUrl` to a host it controls and let the node's own key (or a
tenant row's key) be sent there. With the set atomic, a `baseUrl` only ever
receives the key declared beside it, which its author could name anyway.

**Failure is fatal and typed.** A reference that cannot be resolved fails the
turn with `PROVIDER_CREDENTIALS_UNAVAILABLE` and one fixed Slack message per
failed job. It never falls back to the node's environment. The bundle endpoint
says whether the failure is transient (Vault not answering: the job takes its
normal retry) or definitive (denied, missing, a bad reference: no retry).

**The Vault service account is a secret.** Vault trusts whoever presents a token
for the bound ServiceAccount. So the role is bound to the gateway's own
ServiceAccount, the token is a projected one with audience `vault` mounted on the
gateway pod only, nodes refuse to boot with any `SLAUDE_VAULT_*` or `VAULT_*`
variable set (whatever `SLAUDE_NODE_BOOT_CHECK` says), and `mono` refuses
`SLAUDE_VAULT_ADDR` because its agent child runs as the user that holds the token.

**`{persona}` in the allowed prefixes.** `SLAUDE_VAULT_ALLOWED_PREFIXES` is
required, and a `{persona}` segment expands to the persona's name, so each
persona can reach only its own folder. `env://` has no such scoping: any persona
may name any `PERSONA_*` variable. The docs say so plainly instead of pretending.

**`SLAUDE_PROVIDER_ENV_FALLBACK` keeps its old default (`1`).** With `0` the node
deletes whole families of provider-selecting variables from the child
(`ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `AWS_*`, ...) with a tested keep list, so a
provider mode the CLI adds later is covered too. Changing the default was parked.

**A gateway LLM proxy was parked.** Keeping keys off nodes entirely would need
one; it is a separate design.

## What went wrong

- **A per-field filter was not enough.** The first strict mode deleted the four
  known variables. A child can select a provider through others
  (`CLAUDE_CODE_USE_BEDROCK` with `AWS_*`, for instance), so strict mode now
  deletes families and keeps an explicit allow list.
- **A trailing or percent-encoded dot** (`localhost.`, `169.254.169.254%2e`) got
  a loopback or metadata host past the `baseUrl` rule. Host classification now
  normalises before comparing.
- **The Vault client dropped a working token after a failed refresh**, turning a
  Vault blip into an outage; and a refused `lookup-self` on a recently accepted
  token was read as "Vault is down" and stale-served a value the policy had just
  revoked. A refusal is now a denial, and a denial is never masked by the stale
  cache.
- **A wall-clock cache** could serve an entry forever after a clock step
  backwards. The cache uses a monotonic clock and distrusts a backwards step.
- **A resolver failure on the node spawned the child on the node's own
  environment** instead of failing the boot. It now fails with the typed code.

## What was measured

The resolver was run against a real dev-mode Vault (an optional test, enabled
by a URL), including KV v1: a v1 mount answers the v2 path with 404 and is
reported as a missing secret. The per-turn cost of a failure was counted: a
transient failure costs about six bundle builds per turn (three client tries,
times the queue's two attempts), so up to six Vault reads when nothing is
cached.

## Not done

The re-encryption tool for `SLAUDE_MASTER_KEY` rotation does not exist, so the
master key cannot be rotated without discarding stored ciphertext (see the
release notes). The gateway still needs its own provider for soul extraction,
`kb_think` synthesis and `/model`.
