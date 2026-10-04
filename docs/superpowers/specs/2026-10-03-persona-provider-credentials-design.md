# Persona provider credentials, by reference

**Date:** 2026-10-03 · **Revised:** 2026-10-04 (after design review and the MCP bridge spike)
**Umbrella:** `2026-10-03-centralized-persona-runtime-design.md` — this is WS-A
**Builds on:** `2026-10-01-personas-as-code-design.md` (the persona row, `/deploy`, the
runtime bundle) and `2026-09-18-phase-3-user-scoped-mcp-credentials-design.md`
**Pairs with:** `2026-10-03-node-labels-and-routing-design.md` (WS-B), which decides
*which node* may receive what this spec resolves, and which first splits the Secrets so
that a node does not hold the gateway's own

## 1. Intent

An operator wants each persona to run on its own LLM provider credentials, held in one
central place the gateway reads, and visible to an administrator as a *reference*, never
as a value.

The operator's own words: credentials live in HashiCorp Vault; a persona holds a
reference to them; the gateway retrieves them as needed — when a session starts, resumes
or reloads — and hands them to the node for that session.

Properties this document serves:

- **A persona names where its credentials are; it never contains them.** A reference is
  not a secret, so it can sit in git, in the `/deploy` payload and in the panel.
- **Only the gateway talks to the secret store.** Nodes and the agent child never hold a
  Vault token, a Vault address or a path they could use.
- **Rotation is a Vault operation.** A new secret version is picked up the next time a
  session starts, resumes or reloads. No redeploy, no sync, and no per-message check.
- **A managed persona never silently runs on someone else's credentials.** Today a
  persona with none falls back to whatever the node pod happens to hold, and a failing
  credential lookup is swallowed.

**Decided with the operator, and recorded so it is not re-opened here:** the LLM
provider credential *is delivered to the node* and read by the agent child as
`ANTHROPIC_*` environment. A gateway-side LLM proxy that would keep it off nodes was
considered and **parked** (§13). MCP credentials are a separate mechanism (the MCP bridge,
WS-C) and never reach a node.

## 2. Scope

**In:** the reference model and its payload field; a resolver seam with `env://` and
`vault://` backends; Vault KV v2 with Kubernetes authentication; resolution at
runtime-bundle build; the `auth_token` credential kind; the rule that credential
resolution is *fatal and typed* in managed mode; the no-silent-fallback rule; the gateway's
own provider for its own model calls; the child-env scrub; failure modes and their Slack
text; the trust model this implies; tests including a dev-mode Vault in `k8s-local`.

**Out (and why):**

- Rotation by session-fingerprint, and any per-message secret check. See §8: the
  operator's model is "fresh at start, resume, reload", and the extra machinery had
  correctness problems across gateway replicas.
- Vault dynamic secrets, leases, AppRole and other auth methods, and a second backend.
- A runtime override of provider references; they change through git, like the soul's ACLs.
- A new writer for the `provider_creds` table; it stays an implicit read-only fallback.
- Keeping provider credentials off nodes (the parked LLM proxy, §13).
- Which node may receive a persona's credentials — WS-B. This spec makes that gate
  worth having; it does not build it.

## 3. What exists today (verified in the code)

- `provider_creds(tenant_id, persona_id NULL, kind, value)`, value AES-256-GCM encrypted
  under `SLAUDE_MASTER_KEY`. Read by `applyProviderCreds` (`src/gateway/api/tenants.ts`):
  tenant-wide rows first, then the persona's own override. **Nothing in `src/` writes it.**
- Handled kinds: `api_key`, `base_url`, `oauth_token`. **`auth_token` is not a kind**, so
  `ANTHROPIC_AUTH_TOKEN` — used by several Anthropic-compatible providers — cannot be stored.
- A node gets credentials at agent-child spawn: `setChildEnvResolver` calls
  `client.getRuntime(tenant, persona, jobToken)` (ETag-cached) and `bundleChildEnv`
  (`src/node/worker.ts:120`) overlays `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN` onto the
  child env, plus `SLAUDE_AGENT_ID` for named personas.
- The overlay is *additive*, and the child's environment is `scrubChildEnv(...)`
  (`src/agent/child-env.ts`), which strips a fixed set of gateway secrets. A persona with
  no stored credentials therefore runs on the node's own.
- **A failing resolver does not fail the boot.** The error is caught and the child spawns
  on the node's own environment (`src/agent/manager.ts:~914-920`). It "fails closed" today
  only by accident, because the soul resolver later refetches the same bundle.
- **Only `worker.ts` installs a child-env resolver.** In `mono` (gateway and agent in one
  process) no persona reference or stored credential is ever applied.
- Turn errors post the raw error text into the thread (`gateway.ts:~1308`,
  `dispatch.ts:197-199`), including provider and CLI messages such as "Invalid API key".
- Soul extraction at sync time makes a model call using **the gateway's own** environment
  (`src/soul/extract.ts:131-136`, `src/persona/sync/run.ts`); `kb_think` synthesis and `/model`
  validation do the same (`src/agent/models.ts`).
- The persona payload (`src/persona/sync/payload.ts`) carries `model`, `userToken`, `mcp`;
  only `userToken` and `mcp` resolve `${PERSONA_*}` placeholders, from the gateway's env,
  at sync time. The `PERSONA_` prefix rule exists because the first resolver accepted any
  `${VAR}` and could have copied `SLAUDE_MASTER_KEY` into a stored persona.

## 4. The reference model

A persona gains an optional `provider` object. Each field is a reference or, for the
non-secret `baseUrl`, a literal URL.

```json
{
  "name": "support-bot",
  "slackUserId": "U…",
  "model": "provider-model-name",
  "provider": {
    "baseUrl": "https://llm.example.com",
    "apiKey": "vault://secret/slaude/personas/support-bot#api_key"
  },
  "soul": "…"
}
```

| Field | Env var on the child | Secret? |
|---|---|---|
| `apiKey` | `ANTHROPIC_API_KEY` | yes — reference |
| `authToken` | `ANTHROPIC_AUTH_TOKEN` | yes — reference |
| `oauthToken` | `CLAUDE_CODE_OAUTH_TOKEN` | yes — reference |
| `baseUrl` | `ANTHROPIC_BASE_URL` | no — literal or reference |

**Reference grammar.**

- `vault://<mount>/<path>#<field>` — KV v2. `mount` is the secrets-engine mount (one or
  more segments), `path` the secret path under it, `field` a key inside the secret's data.
  All required.
- `env://<NAME>` — a variable in the gateway's own environment. `NAME` must start with
  `PERSONA_`, the same rule as placeholders and for the same reason. This is the only
  no-Vault way to give a persona a value, since `provider_creds` has no writer.

No other scheme. An absent field means "not set by this persona" and falls through (§5.3).
Because credentials resolve at bundle build and not at sync, a stored persona holds only
references; there is no secret in the `personas` table or in a git export.

**Provider and model are a pair.** A persona that sets `provider.baseUrl` and no `model`
gets a sync *warning* naming it. In managed mode a persona with **no `model` at all** also
gets one: it inherits the gateway's default, which may not exist on that persona's provider
("model not found" on every turn).

`provider` is desired-layer state. The override layer is unchanged; a sync is how a
reference changes.

## 5. Resolution

### 5.1 The resolver seam

One interface, in a new `src/secrets/` module:

```ts
interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
}
```

`parseRef(string)` validates syntax and returns a typed ref or a `PayloadError`. Backends
register by scheme; nothing outside `src/secrets/` knows Vault's HTTP shape. (An earlier
draft also returned a `generation` for a session fingerprint; that mechanism is dropped,
§8.)

### 5.2 Where it runs

At runtime-bundle build (`buildManagedBundle`), per persona, for each reference in
`provider`. That is the path `getRuntime` already serves, so a session start, a resume and a
reload all take it with no new node-side call. The resolved values go in
`bundle.providerCreds`, exactly as today. Resolution never happens on a node, at sync time,
or in the agent child.

**`mono`.** The gateway-role agent manager gets the same child-env resolver the node
worker has, fed by the same bundle builder in-process. Until it does, a `mono` deployment
that sets a reference is **refused at startup** with a clear error, so the reference is
never silently ignored.

### 5.3 Precedence, per field

1. the persona's reference (`provider.<field>`);
2. the persona's own `provider_creds` row (existing, read-only);
3. the tenant-wide `provider_creds` row (existing);
4. nothing.

There is no gateway-env fallback for a *managed* tenant, as today. The unmanaged tiers
(disk, env) are unchanged.

### 5.4 Fatal, typed, and no silent fallback

Two behaviours change in managed mode.

**Resolution failure is fatal.** If the child-env resolver throws — Vault down, a ref
refused, a field missing — the session boot **fails** with a typed code
(`PROVIDER_CREDENTIALS_UNAVAILABLE`) instead of spawning on the node's environment. The
code travels as the job's failure reason; the gateway maps it to fixed Slack text (§7).

**A node's own `ANTHROPIC_*` does not stand in.** Behind `SLAUDE_PROVIDER_ENV_FALLBACK`:

- `1` (default in the first release): current behaviour, plus a one-time warning per
  persona per node naming the persona that fell back.
- `0`: for a managed persona, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_BASE_URL` are **deleted from the child's env
  object** unless the bundle supplied them. (Not set to `undefined`: how the runtime's spawn
  treats an `undefined` value is unverified, and a deleted key cannot be misread.) A persona
  without credentials then fails its turn with the typed code.

When to change that default is parked (§13). The `k8s-local` overlay sets `0` and drops the
provider env from the node deployment, which is the configuration this spec is built for.

### 5.5 The gateway's own provider

Some model calls are made by the gateway for itself, with its **own** environment, not a
persona's: soul extraction at sync (a sync fails without it), `kb_think` synthesis, and
`/model` validation. This spec states the requirement instead of hiding it: **a gateway
that syncs personas or serves the brain must be given a system provider** through its own
environment, and the docs say so. `/model` validates against the *persona's* provider when
it has one (or passes the choice through unvalidated), so a persona on a different provider
is not rejected by the gateway's. The `model`-unset warning in §4 is the matching guard.

## 6. The Vault backend

### 6.1 Configuration (gateway only)

| Variable | Meaning |
|---|---|
| `SLAUDE_VAULT_ADDR` | base URL; enables the backend |
| `SLAUDE_VAULT_AUTH` | `kubernetes` (default in a pod) or `token` (development only) |
| `SLAUDE_VAULT_ROLE` | role name (kubernetes) |
| `SLAUDE_VAULT_ALLOWED_PREFIXES` | comma list of `<mount>/<path-prefix>` — **required** |
| `SLAUDE_VAULT_NAMESPACE` | sent as `X-Vault-Namespace` when set |
| `SLAUDE_VAULT_CACERT` | CA bundle path for a private Vault |
| `SLAUDE_VAULT_CACHE_TTL` | seconds; default 60 (`0` = fetch on every session start) |
| `SLAUDE_VAULT_STALE_MAX` | seconds a failed refresh may serve the last value; default 600 |

Other auth methods (AppRole and so on) are not specified here.

**Login and renewal.** The client token comes from a Kubernetes login with the pod's
service-account JWT, is kept in memory, and renewed before its lease ends. Vault answers 403
for both "policy denies this path" and "token expired", so a 403 does **not** by itself
trigger a login: the client first checks the token with a `lookup-self`, logs in again only
if that fails, and rate-limits logins (single-flight, with a minimum interval). Otherwise a
policy-denied path would cause a login on every resolve.

If `SLAUDE_VAULT_ADDR` is set and `SLAUDE_VAULT_ALLOWED_PREFIXES` is empty, the gateway
**refuses to start**. An empty allowlist must not mean "anything".

### 6.2 The service account is a secret too

Kubernetes auth logs in with the pod's **service-account token file**, which no environment
scrub touches and which any process in the pod can read. Therefore:

- The gateway runs under **its own ServiceAccount**; the Vault role is bound to that
  account (`bound_service_account_names` and namespace), and to nothing else.
- Node pods set `automountServiceAccountToken: false`, so no node can read a token a role
  trusts. (Today no manifest sets a `serviceAccountName`, so gateway and nodes share
  `default`.)
- `mono` has no such boundary: the agent child shares the process user and can read the
  token. `SLAUDE_VAULT_ADDR` is refused in `mono`, or documented there as unprotected.
- The gateway's own model-call children (`kb_think` synthesis) must not be able to use
  tools: see WS-D, finding on `brain-think`.

### 6.3 The allowed-prefix rule

A reference resolves only if the **final request path** — `<mount>/data/<path>`, after
normalisation — starts with one of the allowed prefixes. This stops a persona payload, which
an operator's repository (and so possibly a pull request) writes, from naming any path the
gateway's Vault role can read, including the gateway's own secrets. It is the same class of
defect as the early `${VAR}` resolver, checked before any network call.

- A prefix may contain the token `{persona}`, expanded to the persona's name when checked, so
  each persona can reach only its own folder (`secret/slaude/personas/{persona}/`). Without
  it, a persona could name another persona's secret inside the same prefix.
- Normalisation rejects, with a `PayloadError` naming the persona and field: `..` and `.`
  segments, empty segments, percent-encoded separators, control characters, a query string,
  and a missing `#field`.
- It runs at sync (so CI fails) and again at resolution (so a row written some other way
  cannot bypass it).

The gateway's Vault role should hold read on the allowed prefixes only. This spec documents
the policy; it does not provision it.

### 6.4 Reading, cache, single flight

`GET /v1/<mount>/data/<path>` (KV v2). `data.data[<field>]` is the value. A missing secret or
field, a non-string field, or a KV v1 mount is a resolution failure with a distinct internal
reason. Values are never logged.

An in-process cache per normalised reference holds `{value, fetchedAt}`. Concurrent
resolutions of the same reference share one request. Past `CACHE_TTL` the next caller
refreshes; if the refresh fails and the entry is younger than `STALE_MAX`, the cached value
is served and a counter increments; older, resolution fails.

**Blast radius, stated.** The cache is per process and not persisted. A gateway that restarts
during a Vault outage has no cache, so **a cold start cannot boot new sessions** until Vault
returns; warm sessions already hold their environment and keep running. Replicas may differ
for up to the TTL after a rotation; the TTL bounds it.

## 7. Failure modes and what Slack says

| Situation | Behaviour |
|---|---|
| Vault unreachable or a ref unresolvable, no usable cache | Bundle build fails; the node fails the boot with `PROVIDER_CREDENTIALS_UNAVAILABLE`; the job ends without a retry loop |
| A reference refused by the allowlist | Same, plus an error-level log with persona and reason `prefix` |
| Persona has no credentials and fallback is off | Same code |
| Warm session while Vault is down | Nothing changes; it already holds its environment |
| Respawn (idle expiry, reload) while Vault is down and past `STALE_MAX` | Fails as above |

**Fixed text, never raw errors.** The gateway maps typed failure codes to fixed messages
(`provider credentials for this agent are unavailable`). **The raw error text is never
posted to Slack**, for these failures or any other: today `gateway.ts:~1308` and
`dispatch.ts:197-199` post provider and CLI messages ("Invalid API key · Please run /login")
verbatim; this spec requires the mapping to cover them (the change itself is in WS-D). One
message per failed turn, de-duplicated on the job id, not once per client retry (three), BullMQ
attempt (two) and replica.

Logging: `provider.cred.resolve` with persona, scheme, outcome (`ok|cached|stale|denied|error`)
and duration. Not the path, field or value. The panel, admin-only, may show the reference.

## 8. Rotation

The rule is the operator's: **the value is fetched when a session starts, resumes or
reloads.** Concretely, `getRuntime` is called at child spawn and the credential is read then.

- A new Vault version reaches a persona's next *spawn*: a new thread, a respawn after the
  idle TTL (default 15 minutes), or a reload.
- A warm session keeps the value it booted with until it respawns. For an urgent rotation
  (a leaked key) the operator uses the existing reload (`/reload` or the panel), which
  respawns the sessions immediately; after revoking a key upstream, a warm session fails its
  next model call and the error path of §7 applies.
- **There is no per-message check and no fingerprint of the secret.** An earlier draft folded
  the Vault version into the session-config fingerprint so a rotation would reboot warm
  sessions. It is dropped: the fingerprint is minted only when remote exec is enabled (so the
  design would have changed its meaning), it is minted by whichever replica dispatches while
  the bundle comes from another replica with its own cache (so a session could reboot under a
  new fingerprint and boot with the old key, or flap between replicas), and the first
  rollout would reboot every warm session.

The bundle's ETag is derived from an **HMAC** of the body keyed by `SLAUDE_MASTER_KEY`, not a
bare SHA-256 of a body that contains plaintext secrets. A node evicts a session's bundle from
its cache when the session unregisters, so credentials do not outlive the session in memory.

## 9. Trust model and security

**Stated plainly, because it limits what this feature can promise.** A provider key delivered
to a node sits in the agent child's environment. The child runs as the same user as the node
process, and its Bash tool, any plugin MCP subprocess and any other session's child on that
node can read it (`/proc/<pid>/environ`, argv). **Personas that share a node share a trust
domain.** The label (WS-B) is the boundary: it decides which nodes may receive a persona's
credentials; it does not protect one persona on a node from another's prompt-injected turn.
The `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` setting that the CLI offers is off by default and not
set by slaude; whether to turn it on is a verified task for the plan, not an assumption.

- **Scrub.** Every variable starting `SLAUDE_VAULT_` or `VAULT_` is added to the child-env
  strip list, with a test. In `mono` this is defence in depth, not a boundary.
- **Nodes** hold no Vault configuration and make no Vault call. They receive the resolved
  environment for the session's persona, nothing else.
- **No value in a durable place.** Resolved values live in the cache and the response body
  only; never in the DB, the soul cache, a log or the panel.
- **Public-repo hygiene.** Examples, tests and docs use generic mounts and paths
  (`secret/slaude/personas/<name>`) and fake tokens.
- **Who can change a reference:** anyone who can sync personas. The allowlist (with
  `{persona}`) bounds what a reference can reach; the Vault policy bounds what the gateway can
  read at all.

## 10. Migration and compatibility

- One additive migration: `personas.provider_json` (jsonb, nullable), **Postgres only** like the
  `personas` table. Its number is assigned at merge time, not here. Existing rows are untouched.
- The `provider` payload field is optional. `export` omits it when absent; `render --check`
  validates references with the same parser the gateway uses.
- **A `/deploy` payload carrying `provider` is refused by a gateway that does not know the
  field**, because the payload schema becomes strict and versioned (WS-D, foundations). An older
  gateway would otherwise strip it silently and leave the persona on node credentials.
- `SLAUDE_PROVIDER_ENV_FALLBACK` defaults to today's behaviour, so an existing deployment changes
  only when an operator sets a reference or the flag to `0`.
- `auth_token` is added as a `provider_creds` kind for completeness; with no writer it matters
  through `provider.authToken`.
- A *rollback* after references are configured moves those personas back to node-env credentials
  (the old code ignores the column). The release plan (WS-E) carries the runbook for that.
- Docs: a provider-credentials page; configuration reference entries; a field note.

## 11. Testing

**Unit.**
- `parseRef`: valid; traversal, encoded separators, empty segments, missing field, wrong scheme,
  `env://` outside `PERSONA_`, multi-segment mount.
- Allowlist: inside, outside, the prefix-boundary case (`…/personas` vs `…/personas-evil`), and the
  `{persona}` token (own folder passes, a sibling's does not).
- Precedence per field: reference > persona row > tenant row > none.
- Cache: TTL (including `0`), single flight under concurrency, stale within max, failure past max.
- `bundleChildEnv` with fallback `1` and `0`: keys are deleted, not undefined.
- Resolver failure is fatal and typed; a successful resolve is unaffected.
- Scrub list covers `SLAUDE_VAULT_*` and `VAULT_*`.
- ETag is an HMAC and changes when a value changes.

**Vault client against a fake HTTP server.** Kubernetes and token login; a 403 that is a
policy denial does **not** cause a login storm; a 403 that is token expiry does one rate-limited
login; KV v2 parsing; KV v1 detection; namespace header; 5xx and timeout.

**Integration on `k8s-local`.** A dev-mode Vault (`vault server -dev`) as
`deploy/k8s-local/vault.yaml` plus a seed script, with a Kubernetes-auth role bound to the
gateway's own ServiceAccount. Two personas pointing at two secrets. Node pods have
`automountServiceAccountToken: false`.

**End to end (the existing mock LLM).** Each persona's turn reaches the mock with *its own*
credential. Write a new KV version and show that a **new thread** gets the new credential and a
warm session keeps the old one until a reload. Stop Vault and show a fresh persona's turn fails
with the fixed message, with no raw error text in the thread, while a warm session keeps running.
A `mono` run refuses a reference (until the resolver is installed there).

## 12. Release

DB schema, the agent loop's boot path and the bundle contract change: a release candidate, with
notes under the stable name from the first RC. The fallback default does not change in this
release.

## 13. Decisions recorded, and what is parked

Decided with the operator: HashiCorp Vault, KV v2, static, plain read; credentials per persona and
referenced; Vault only (no second backend, no dynamic secrets); the provider credential is
delivered to the node; fetch at session start, resume and reload; no fingerprint rotation.

Parked, to be decided later and not part of this release:

- **A gateway LLM proxy** (the node's child points at the gateway, which injects the key). It
  would keep provider keys off nodes, make rotation per request, enforce provider/model pairing
  and add per-persona budgets, at the cost of putting the gateway on the model data path
  (streaming, abort, capacity, SSRF policy) and an unproven CLI-compatibility check. The
  operator chose to keep the provider on the node for now; the MCP bridge (WS-C) is unaffected.
- **Per-tenant Vault prefixes** beyond `{persona}`: one deploy is one workspace.
- **When to change the `SLAUDE_PROVIDER_ENV_FALLBACK` default.**
