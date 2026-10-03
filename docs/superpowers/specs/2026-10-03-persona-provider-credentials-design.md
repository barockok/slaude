# Persona provider credentials, by reference

**Date:** 2026-10-03
**Builds on:** `2026-10-01-personas-as-code-design.md` (the persona row, `/deploy`, the
runtime bundle) and `2026-09-18-mcp-credential-ownership` (credentials stay
gateway-owned; nodes receive a projection)
**Umbrella:** `2026-10-03-centralized-persona-runtime-design.md` — this is
workstream WS-A there; the decisions, the other workstreams and the release gate
are tracked in that document.
**Sibling spec (next):** node labels and routing (WS-B) — it adds the gate that
decides *which node* may receive what this spec resolves

## 1. Intent

An operator wants each persona to run on its own LLM provider credentials, held
in one central place the gateway reads, and visible to an administrator as a
*reference*, never as a value.

The operator's own words: credentials live in HashiCorp Vault; a persona holds a
reference to them; the gateway retrieves them as needed — when a session starts,
resumes or reloads — and hands them to a node for that session.

Properties the rest of this document serves:

- **A persona names where its credentials are; it never contains them.** A
  reference is not a secret, so it can sit in git, in the `/deploy` payload and
  in the panel.
- **Only the gateway talks to the secret store.** Nodes and the agent child never
  hold a Vault token, a Vault address or a path they could use.
- **Rotation is a Vault operation.** Writing a new secret version changes the
  next session boot, and reboots warm sessions, without a redeploy or a sync.
- **A persona never silently runs on someone else's credentials.** Today a
  persona with none falls back to whatever the node pod happens to hold.

## 2. Scope

**In:** the reference model and its payload field; a resolver seam with `env://`
and `vault://` backends; Vault KV v2 with Kubernetes, AppRole and token auth;
resolution at runtime-bundle build; the `auth_token` credential kind; folding the
resolved credential's generation into the session-config fingerprint; failure
modes; the child-env scrub; the no-silent-fallback rule for managed personas;
tests including a dev-mode Vault in `k8s-local`.

**Out (and why):**

- Vault dynamic secrets, leases and renewal of secrets (only the *client* token is
  renewed). KV v2 reads cover static provider keys; dynamic secrets are a later,
  separate design.
- A runtime override of provider references. Overrides cover soul, model and mcp
  only; a credential source changes through git, like the soul's ACLs.
- A new writer for the `provider_creds` table. It stays as an implicit, read-only
  fallback (§5.3). An operator who wants a value without Vault uses `env://`.
- Cloud secret managers. The resolver seam admits them; none is built here.
- Panel views of provider sources, MCP, KB scope and skills — the visibility spec.
- Which node may receive a persona's credentials — the labels spec. This spec
  makes that gate worth having; it does not build it.

## 3. What exists today (verified in the code)

- `provider_creds(tenant_id, persona_id NULL, kind, value)`, value AES-256-GCM
  encrypted under `SLAUDE_MASTER_KEY`. Read by `applyProviderCreds` in
  `src/gateway/api/tenants.ts`: tenant-wide rows first, then the persona's own
  rows override. **Nothing in `src/` writes it.**
- Handled kinds: `api_key`, `base_url`, `oauth_token`. **`auth_token` is not a
  kind**, so `ANTHROPIC_AUTH_TOKEN` — what several Anthropic-compatible providers
  use — cannot be stored. It reaches a node only through the node's own env.
- A node gets credentials at agent-child spawn: `setChildEnvResolver` calls
  `client.getRuntime(tenant, persona, jobToken)` (ETag-cached), and
  `bundleChildEnv` overlays `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN` onto the
  child env, plus `SLAUDE_AGENT_ID` for named personas.
- The overlay is *additive*. The child starts from the node's own environment, so
  a persona with no stored credentials runs on the node's. In `k8s-local` that is
  one provider for every persona.
- The persona payload (`src/persona/sync/payload.ts`) carries `model`,
  `userToken` and `mcp`; only `userToken` and `mcp` resolve `${PERSONA_*}`
  placeholders, from the gateway's env, at sync time. The `PERSONA_` prefix rule
  exists because the first resolver accepted any `${VAR}` and could have copied
  `SLAUDE_MASTER_KEY` into a stored persona.
- `sessionConfigFp(lockUser, remote)` (`src/remote/fingerprint.ts`) is minted at
  dispatch and signed into the job token; a node reboots a warm session when it
  changes.
- `src/agent/child-env.ts` strips a fixed set of secrets plus `PERSONA_*` from the
  child.

## 4. The reference model

A persona gains an optional `provider` object. Each field is either a reference
or, for the non-secret `baseUrl`, a literal URL.

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

- `vault://<mount>/<path>#<field>` — KV v2. `mount` is the secrets-engine mount,
  `path` the secret path under it, `field` a key inside the secret's data. All
  three are required.
- `env://<NAME>` — a variable in the gateway's own environment. `NAME` must start
  with `PERSONA_`, the same rule as placeholders and for the same reason.

No other scheme is accepted. An absent field means "not set by this persona" and
falls through (§5.3). Because credentials resolve at bundle build rather than at
sync, a stored persona holds only references; there is no secret to leak from the
`personas` table or from a git export.

**Provider and model are a pair.** A persona that sets `provider.baseUrl` and no
`model` gets a sync *warning* naming it: the model the gateway would otherwise
pick may not exist on that provider ("model not found" on every turn).

`provider` is desired-layer state. The override layer is unchanged; a sync is how
a reference changes.

## 5. Resolution

### 5.1 The resolver seam

One interface, in a new `src/secrets/` module:

```ts
interface SecretResolver {
  /** The value a reference points at, plus an opaque `generation`. */
  resolve(ref: SecretRef): Promise<{ value: string; generation: string }>;
  /** Cheap: the generation only, from cache; refreshes if expired. */
  generation(ref: SecretRef): Promise<string>;
}
```

`parseRef(string)` validates syntax and returns a typed ref or a `PayloadError`.
Backends register by scheme. Nothing outside `src/secrets/` knows Vault's HTTP
shape.

`generation` is a non-reversible fingerprint of "which secret version this is":
for Vault the KV v2 `version` number; for `env://` an HMAC of the value keyed by
`SLAUDE_MASTER_KEY`. It never contains the value.

### 5.2 Where it runs

At runtime-bundle build (`buildManagedBundle`), per persona, for each reference in
`provider`. That is the same path `getRuntime` already serves, so a session start,
a resume and a reload all take it with no new node-side call. The resolved values
go in `bundle.providerCreds`, exactly as today.

Resolution never happens on a node, at sync time, or in the agent child.

### 5.3 Precedence, per field

1. the persona's reference (`provider.<field>`);
2. the persona's own `provider_creds` row (existing, read-only);
3. the tenant-wide `provider_creds` row (existing);
4. nothing.

There is no gateway-env fallback for a *managed* tenant, as today. The unmanaged
tiers (disk, env) are unchanged.

### 5.4 The no-silent-fallback rule

`bundleChildEnv` today overlays what the bundle provides and leaves everything
else to the node's environment. For a managed persona this must not let a node's
own `ANTHROPIC_*` stand in for a credential the persona lacks.

New behaviour, behind `SLAUDE_PROVIDER_ENV_FALLBACK`:

- `1` (default in the first release): current behaviour, plus a one-time warning
  per persona per node naming the persona that fell back.
- `0`: for a managed persona, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_BASE_URL` are set to `undefined` on the
  child unless the bundle supplied them. A persona without credentials then fails
  its turn with a generic message (§7), instead of running as someone else.

When to change that default is parked (§13). The `k8s-local` overlay sets `0` and
drops the provider env from the node deployment, which is the configuration this
spec is built for.

## 6. The Vault backend

### 6.1 Configuration (gateway only)

| Variable | Meaning |
|---|---|
| `SLAUDE_VAULT_ADDR` | base URL; enables the backend |
| `SLAUDE_VAULT_AUTH` | `kubernetes` (default in a pod) \| `approle` \| `token` |
| `SLAUDE_VAULT_ROLE` | role name (kubernetes, approle) |
| `SLAUDE_VAULT_ALLOWED_PREFIXES` | comma list of `<mount>/<path-prefix>` — **required** |
| `SLAUDE_VAULT_NAMESPACE` | sent as `X-Vault-Namespace` when set |
| `SLAUDE_VAULT_CACERT` | CA bundle path for a private Vault |
| `SLAUDE_VAULT_CACHE_TTL` | seconds; default 60 |
| `SLAUDE_VAULT_STALE_MAX` | seconds a failed refresh may serve the last value; default 600 |

The Vault client token is obtained by logging in (kubernetes: the pod's service
account JWT; approle: role id and secret id from files or env; token: a static
token), kept in memory, re-obtained when Vault answers 403, and renewed before its
lease ends. A login is single-flight across concurrent requests in the process.

If `SLAUDE_VAULT_ADDR` is set and `SLAUDE_VAULT_ALLOWED_PREFIXES` is empty, the
gateway **refuses to start**: an unconfigured allowlist must not mean "anything".

### 6.2 The allowed-prefix rule

A reference is resolved only if its normalised `<mount>/<path>` starts with one of
the allowed prefixes. This is the control that stops a persona payload — which an
operator's repository, and so possibly a pull request, writes — from naming any
path the gateway's Vault role can read, including the gateway's own secrets. It is
the same class of defect as the early `${VAR}` resolver, checked before any
network call.

Normalisation rejects, with a `PayloadError` naming the persona and field:
`..` and `.` segments, empty segments (`//`), percent-encoded separators, control
characters, a query string, and a missing `#field`. It runs at sync (so CI fails)
and again at resolution (so a row written some other way cannot bypass it).

The gateway's Vault role should hold read on the allowed prefixes and nothing
else. This spec documents the policy; it does not provision it.

### 6.3 Reading

`GET /v1/<mount>/data/<path>` (KV v2). The response's `data.data[<field>]` is the
value and `data.metadata.version` the generation. A missing secret, a missing
field, a non-string field, or a KV v1 mount (no `data.data`) is a resolution
failure with a distinct internal reason. Values are never logged.

### 6.4 Cache, single flight, stale

An in-process cache per reference, keyed by the normalised ref, holds
`{value, generation, fetchedAt}`. Concurrent resolutions of the same reference
share one request. Past `CACHE_TTL` the next caller refreshes. If the refresh
fails and the entry is younger than `STALE_MAX`, the cached value is served and a
warning counter increments; older than that, resolution fails. Each gateway
replica keeps its own cache, which is fine: the TTL bounds how long replicas can
disagree.

## 7. Failure modes

- **Vault unreachable or a reference unresolvable, no usable cache.** The bundle
  endpoint answers 503. The node does not spawn the child. The gateway posts one
  message in the thread: *"provider credentials for this agent are unavailable"* —
  generic text only. **Vault's error body, the path and the persona's reference
  never go into Slack.** (A provider's OAuth error body once reached a thread
  through exactly this kind of failure message.)
- **A reference rejected by the allowlist at resolution.** Same 503 and message,
  plus an error-level log with the persona name and the reason `prefix`.
- **A secret rotated mid-session.** See §8.
- **Vault down while a warm session is running.** The child already holds its
  env; nothing changes until the next boot. A turn that needs a reboot (§8) while
  Vault is down and the cache is past `STALE_MAX` fails as above.

Logging: `provider.cred.resolve` with persona, scheme, outcome
(`ok|cached|stale|denied|error`) and duration. Not the path, not the field, not
the value. The panel, which is admin-only, may later show the reference.

## 8. Rotation and the session fingerprint

The fingerprint is minted at dispatch, on every inbound message. It becomes

```
sha256([lockUser, remote, providerGeneration(persona)])
```

where `providerGeneration` is the concatenation of the per-reference
`generation` values for that persona, in field order. It is read through
`generation()`, which answers from cache and refreshes at most once per TTL per
reference per replica; a failed refresh serves the last known generation. Dispatch
therefore adds at most one bounded Vault call per reference per TTL to the Slack
hot path, with a short timeout, and never blocks a message on Vault being up.

When a secret's version changes, the next message for a warm session mints a
different fingerprint, the node reboots the session, the child respawns, and
`getRuntime` fetches the new value. A persona with no references contributes the
empty generation, so its fingerprints are unchanged by this spec.

The bundle's ETag is already a hash of its body, which now contains the resolved
credentials; a rotation changes it and a node's revalidation sees the new body.

## 9. Security

- **Scrub.** Every environment variable starting `SLAUDE_VAULT_` or `VAULT_` is
  added to the child-env strip list, with a test. In `mono`, where the child can
  read its parent's environment, this is defence in depth, not the boundary, and
  the docs say so, as the personas-as-code note does.
- **Nodes** hold no Vault configuration and make no Vault call. The projection a
  node receives is the resolved env values for the session's persona, nothing else.
- **No value in a durable place.** Resolved values live in the cache and the
  response body only; never in the DB, the soul cache, a log or the panel.
- **Public-repo hygiene.** Examples, tests and docs use generic mounts and paths
  (`secret/slaude/personas/<name>`) and fake tokens. No real mount, host or role.
- **Who can change a reference.** Anyone who can sync personas. The allowlist
  bounds what a reference can reach; the Vault policy bounds what the gateway can
  read at all.

## 10. Migration and compatibility

- One additive migration: `personas.provider_json` (nullable text on sqlite,
  jsonb on Postgres). Existing rows are untouched and behave as before.
- The `provider` payload field is optional. `export` omits it when absent;
  `render --check` validates references with the same parser the gateway uses.
- `SLAUDE_PROVIDER_ENV_FALLBACK` defaults to today's behaviour, so an existing
  deployment changes only when an operator sets a reference or sets the flag to 0.
- `auth_token` is added as a `provider_creds` kind for completeness; with no
  writer, it matters through `provider.authToken`.
- Docs: a new page for provider credentials; the personas-as-code deploy page and
  configuration reference gain the new variables; a field note records the
  decisions and the mistakes found.

## 11. Testing

**Unit.**
- `parseRef`: valid refs; traversal, encoded separators, empty segments, missing
  field, wrong scheme, `env://` outside `PERSONA_`.
- Allowlist: inside, outside, and the prefix-boundary case (`…/personas` vs
  `…/personas-evil`).
- Precedence: reference > persona row > tenant row > none, per field.
- Cache: TTL, single flight under concurrency, stale-within-max, failure past max.
- Fingerprint: stable across calls; changes on a generation change; unchanged for
  a persona without references.
- `bundleChildEnv` with the fallback flag at `1` and `0`.
- Scrub list covers `SLAUDE_VAULT_*` and `VAULT_*`.

**Vault client against a fake HTTP server.** Kubernetes, AppRole and token login;
re-login on 403 without a stampede; KV v2 parsing and `version`; KV v1 detection;
namespace header; a 5xx and a timeout.

**Integration on `k8s-local`.** A dev-mode Vault (`vault server -dev`) as
`deploy/k8s-local/vault.yaml` plus a seed script, with a Kubernetes-auth role
scoped to the allowed prefix. Two personas pointing at two secrets.

**End to end (the existing mock LLM).** Each persona's turn reaches the mock with
*its own* credential in the request header. Then write a new KV version and show
the next turn arrives with the new credential after a warm-session reboot.
Then stop Vault and show a fresh persona's turn fails with the generic message
while a warm session keeps running.

## 12. Release

This touches the DB schema, the agent loop's session fingerprint and the bundle
contract, so it ships as `vX.Y.Z-rc.N` first, per the repo rules, with the notes
under the stable name from the first RC. The fallback default does not change in
this release.

## 13. Decisions recorded, and what is left open

Decided with the operator: Vault is HashiCorp Vault, KV v2; credentials are per
persona and referenced, not stored in the persona; nothing holds a secret except
Vault and the gateway's short-lived memory; stdio MCP and skills are separate
concerns (a pool's software; the shared filesystem) and not part of this.

Also decided with the operator:

- **Plain KV, not dynamic.** A secret is a static key-value entry in Vault. When
  someone changes it, the change shows up the next time a session starts, resumes
  or reloads; no leases, renewal or revocation. Dynamic secrets are not planned.
- **Vault only.** No second backend is planned. The resolver seam stays, but
  nothing is built or specified for another store.

Parked, to be decided later and not part of this release:

- **Per-tenant prefixes.** One allowlist covers every tenant. A `{tenant}` token
  in a prefix would let one gateway serve tenants with disjoint secret trees. One
  deploy is one workspace, so it is not needed now.
- **When to flip `SLAUDE_PROVIDER_ENV_FALLBACK` to `0`.** The flag ships with the
  default described in §5.4 (today's behaviour plus a warning). Changing that
  default is a separate decision.
