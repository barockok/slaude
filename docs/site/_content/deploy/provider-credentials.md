---
title: Provider credentials
description: Give each persona its own LLM provider credentials by reference, resolved by the gateway from HashiCorp Vault or its own environment.
---

# Provider credentials

A persona managed as code can run on its own LLM provider credentials. The
persona names **where** a credential is (a reference); it never contains the
credential. The gateway resolves each reference when it builds the persona's
runtime bundle, which happens when a session starts, resumes or reloads, and
hands the result to the node that runs the session.

This needs the gateway topology (`SLAUDE_ROLE=gateway` plus nodes) and
[personas as code](personas-as-code.md) on Postgres. `mono` refuses provider
references (see [Mono](#mono)).

## References

In `persona.yaml`:

```yaml
slackUserId: "UTESTUSER1"
model: "provider/model-name"
provider:
  baseUrl: "https://llm.example.com"
  apiKey: "vault://secret/slaude/personas/support-bot#api_key"
```

| Field | Variable on the agent child | Value |
|---|---|---|
| `apiKey` | `ANTHROPIC_API_KEY` | reference |
| `authToken` | `ANTHROPIC_AUTH_TOKEN` | reference |
| `oauthToken` | `CLAUDE_CODE_OAUTH_TOKEN` | reference |
| `baseUrl` | `ANTHROPIC_BASE_URL` | a literal `http(s)` URL, or a reference |

Two schemes exist, and no other:

- `vault://<mount>/<path>#<field>`: a field of a KV **v2** secret. The mount may
  be several segments (see `SLAUDE_VAULT_MOUNTS`).
- `env://PERSONA_<NAME>`: a variable in the **gateway's** environment. Only
  `PERSONA_*` names are allowed, for the same reason as `${PERSONA_*}`
  placeholders: the gateway's environment also holds its own secrets.

A reference is not a secret, so it may sit in git, in the `/deploy` payload and
in the panel. The `personas` table stores the reference only.

`render --check` and `/deploy` validate references with the gateway's own
parser: a literal secret, a `${...}` placeholder, another scheme, `..` or `.`
segments, empty segments, percent-encoding, a query string, a missing `#field`,
an unknown key inside `provider`, or a `baseUrl` with a user name or password
in it is refused with 422, naming the persona and field and never the value.
On the gateway a `vault://` reference is also checked against
`SLAUDE_VAULT_ALLOWED_PREFIXES`, and refused when this gateway has no Vault
configured, so a reference that could never resolve fails the pipeline rather
than every turn.

**Provider and model are a pair.** A sync warns (and reports in `warnings`)
for a persona that sets `provider.baseUrl` without `model`, and for any named
persona with no `model` at all: it would inherit the gateway's default model,
which its own provider may not offer.

`provider` changes only through a sync. There is no runtime override for it.

### Precedence

Per field: the persona's reference, then the persona's own `provider_creds`
row, then the tenant-wide `provider_creds` row, then nothing. A managed tenant
never falls back to the gateway's environment for a persona.

## Vault setup

Vault configuration lives on the gateway only. A node refuses to boot with any
`SLAUDE_VAULT_*` or `VAULT_*` variable when `SLAUDE_NODE_BOOT_CHECK=refuse`, and
warns otherwise; nodes make no Vault call. All variables are listed in the
[configuration reference](../reference/configuration.md#provider-credentials).

1. **KV v2.** References read `GET /v1/<mount>/data/<path>`. A KV v1 mount
   answers that path with 404 and reports as a missing secret.
2. **A dedicated ServiceAccount for the gateway**, and a Kubernetes-auth role
   bound to it and nothing else:

   ```sh
   vault write auth/kubernetes/role/slaude-gateway \
     bound_service_account_names=slaude-gateway \
     bound_service_account_namespaces=slaude-scale \
     policies=slaude-personas ttl=1h
   ```

   The shipped `slaude-gateway` ServiceAccount sets
   `automountServiceAccountToken: false`. Vault's Kubernetes login needs the
   pod's token, so set it to `true` on the gateway ServiceAccount (or pod) when
   you enable Vault. Node pods keep `automountServiceAccountToken: false`, so
   no node can read a token the role trusts.
3. **A policy that reads the persona folders only:**

   ```hcl
   path "secret/data/slaude/personas/*" {
     capabilities = ["read"]
   }
   ```

4. **The gateway environment:**

   ```sh
   SLAUDE_VAULT_ADDR=https://vault.example.com
   SLAUDE_VAULT_ROLE=slaude-gateway
   SLAUDE_VAULT_ALLOWED_PREFIXES=secret/slaude/personas/{persona}
   ```

   `SLAUDE_VAULT_ALLOWED_PREFIXES` is required: a gateway with
   `SLAUDE_VAULT_ADDR` set and an empty allowlist refuses to start. The
   `{persona}` token expands to the persona's name, so each persona can reach
   only its own folder (`secret/slaude/personas/support-bot/...`) and not a
   sibling's. The check runs on the final request path, at sync and again at
   every resolution.

`SLAUDE_VAULT_AUTH=token` with `SLAUDE_VAULT_TOKEN`, and a plain `http://`
address, are for development only and need `SLAUDE_VAULT_ALLOW_INSECURE=1`.

## Rotation

A credential is read when the runtime bundle is built: a new thread, a respawn
after the idle TTL (default 15 minutes), or a reload. Write a new version in
Vault and the next spawn picks it up; no sync and no redeploy.

A warm session keeps the value it booted with. For an urgent rotation (a
leaked key) use `/reload` or the panel's reload, which respawns sessions at
once. After revoking a key upstream, a warm session fails its next model call.

The gateway caches each resolved value per process for `SLAUDE_VAULT_CACHE_TTL`
seconds (default 60; `0` disables the cache). When a refresh fails because
Vault cannot answer, the last value is served for up to
`SLAUDE_VAULT_STALE_MAX` seconds (default 600) and
`slaude_provider_cred_stale_served_total` increments. A definitive answer (a deleted
secret or field, a policy denial) is never masked. The cache is not persisted:
a gateway that restarts while Vault is down cannot start new sessions until
Vault returns; warm sessions keep running.

## Failure behaviour

| Situation | Behaviour |
|---|---|
| Vault unreachable, or a reference unresolvable, with no usable cached value | The bundle endpoint answers 503 with a fixed body; the node fails the session boot with `PROVIDER_CREDENTIALS_UNAVAILABLE`; the job fails without a retry |
| A reference outside the allowlist | The same, and an error-level `provider.cred.resolve` line with reason `prefix` |
| A managed persona with no credential and `SLAUDE_PROVIDER_ENV_FALLBACK=0` | The same code |
| Vault down, warm session | Nothing changes |

Slack gets one fixed message per failed turn:

> :warning: I can't reach my model provider right now (credentials unavailable). The details are in the server log.

Raw error text never reaches Slack. The gateway logs one
`provider.cred.resolve` line per resolution with the persona, scheme, outcome
(`ok`, `cached`, `stale`, `denied`, `error`), duration and, on failure, an
internal reason. It never logs the path, field or value. Metrics:
`slaude_provider_cred_resolve_total{scheme,outcome}` and
`slaude_provider_cred_stale_served_total`.

## The node's own provider variables

`SLAUDE_PROVIDER_ENV_FALLBACK` on a node decides what happens when a managed
persona's bundle leaves a provider variable out:

- `1` (default): the node's own `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN` fill
  the gap, as before, and the node logs one warning per persona naming it and
  the variables it filled.
- `0`: the four provider variables are **deleted** from the agent child's
  environment unless the bundle supplied them, and a managed persona whose
  bundle has no API key, auth token or OAuth token fails its turn with
  `PROVIDER_CREDENTIALS_UNAVAILABLE`.

Set `0` once every managed persona has its own credentials, and remove the
provider variables from the node Deployment.

A node drops a session's cached bundle when the session unregisters, so
credentials do not outlive the session in the node's memory. The bundle's
ETag is an HMAC of its body keyed by `SLAUDE_MASTER_KEY`, not a bare hash of a
body that holds plaintext credentials.

## Trust model

**A provider key delivered to a node sits in the agent child's environment.**
The child runs as the same user as the node process; its Bash tool, any
plugin MCP subprocess, and any other session's child on the same node can read
it. Personas that share a node share a trust domain. The reference and the
allowlist bound what a persona can name; the Vault policy bounds what the
gateway can read at all; neither protects one persona on a node from another
persona's prompt-injected turn.

Anyone who can sync personas can change a reference.

## The gateway's own provider

Some model calls are the gateway's own and use its own environment: soul
extraction at sync (a sync fails without it), `kb_think` synthesis, and
`/model` validation. A gateway that syncs personas or serves the brain still
needs a provider in its own environment. `/model` does not check a persona that
sets `provider` against the gateway's provider: the choice passes through
unverified, and `/model` with no argument does not list models for it.

## Mono

In `mono` (gateway and agent in one process) no child-env resolver runs, so a
reference would be silently ignored. A `mono` process refuses to start when any
persona sets `provider`, and a sync to a `mono` gateway that carries one is
refused with 422. `SLAUDE_VAULT_ADDR` is refused in `mono`: the agent child
could read the service-account token Vault trusts.

## Rollback

An older gateway ignores `personas.provider_json`: rolling back moves those
personas onto `provider_creds` rows or the node's own environment. Keep the
node's provider variables (and `SLAUDE_PROVIDER_ENV_FALLBACK=1`) until the new
release has soaked.
