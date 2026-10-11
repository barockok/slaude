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
| `baseUrl` | `ANTHROPIC_BASE_URL` | a literal `https` URL, or a reference |

**`provider` is one atomic set.** When a persona sets any `provider` field, its
credentials come from that object and nowhere else: never from a
`provider_creds` row and never from the node's own environment, whatever
`SLAUDE_PROVIDER_ENV_FALLBACK` says. A `baseUrl` therefore needs a credential
reference (`apiKey`, `authToken` or `oauthToken`) in the same object, and a
persona with only a key runs on the provider's default host, not the node's.

Two schemes exist, and no other:

- `vault://<mount>/<path>#<field>`: a field of a KV **v2** secret. The mount may
  be several segments (see `SLAUDE_VAULT_MOUNTS`).
- `env://PERSONA_<NAME>`: a variable in the **gateway's** environment. Only
  `PERSONA_*` names are allowed, for the same reason as `${PERSONA_*}`
  placeholders: the gateway's environment also holds its own secrets. The
  variable must be set when the sync runs (its presence is checked; its value
  is never read into the payload). `env://` is **not scoped per persona**: any
  persona may name any `PERSONA_*` variable, including one meant for another
  persona. Use `vault://` with a `{persona}` prefix when personas must not
  reach each other's credentials.

A reference is not a secret, so it may sit in git, in the `/deploy` payload and
in the panel. The `personas` table stores the reference only.

`render --check` and `/deploy` validate references with the gateway's own
parser: a literal secret, a `${...}` placeholder, another scheme, `..` or `.`
segments, empty segments, percent-encoding, a query string, a missing `#field`,
an unknown key inside `provider`, a `baseUrl` with no credential beside it, or
a `baseUrl` outside the rule below is refused with 422, naming the persona and
field and never the value. `render` writes payload `version: 2` when any persona
sets `provider` (otherwise 1), so a gateway too old to know the field refuses
the payload instead of ignoring it.

A literal `baseUrl` must be `https`, with no user name, password, query string
or fragment. `http` is accepted only for a host listed (by exact name) in
`SLAUDE_OUTBOUND_INTERNAL_HOSTS`, the same list the outbound-fetch policy uses;
a private IP address likewise only when listed. A loopback, link-local or
cloud-metadata address (`127.0.0.1`, `169.254.169.254`, `localhost`, the
metadata host names, with or without a trailing dot) is never accepted, listed
or not. The gateway checks this at sync and again every time it builds the
bundle, for a literal URL and for a URL a reference resolved to.

**Host names are not resolved in DNS.** Only literal IP addresses and the names
above are classified; the agent child connects from the node's network, so a
lookup on the gateway would prove nothing about where the child lands. A
public name whose DNS answer is a loopback or private address (a wildcard-DNS
name such as one under `nip.io`, say) passes this check. `SLAUDE_OUTBOUND_ALLOWED_HOSTS`
does not apply to `baseUrl`: it governs the gateway's own outbound fetches. To
limit where personas may send their keys, review `provider.baseUrl` in the
persona repository (whoever can merge there can set it), keep each persona's
secret under its own `{persona}` Vault folder so a redirected `baseUrl` can only
carry that persona's own key, and restrict the nodes' egress at the network
layer.
On the gateway a `vault://` reference is also checked against
`SLAUDE_VAULT_ALLOWED_PREFIXES`, and refused when this gateway has no Vault
configured, so a reference that could never resolve fails the pipeline rather
than every turn.

A sync that removes `provider` from a persona that had it warns, naming the
persona: from then on it uses the `provider_creds` rows and, with the default
flag, the node's own credentials.

**Provider and model are a pair.** A sync warns (and reports in `warnings`)
for a persona that sets `provider.baseUrl` without `model`, and for any named
persona with no `model` at all: it would inherit the gateway's default model,
which its own provider may not offer.

`provider` changes only through a sync. There is no runtime override for it.

### Precedence

A persona that sets `provider` gets exactly that set. A persona that does not
gets, per field, its own `provider_creds` row, then the tenant-wide row, then
nothing. A managed tenant never falls back to the gateway's environment for a
persona.

## Vault setup

Vault configuration lives on the gateway only. A node always refuses to boot
with any `SLAUDE_VAULT_*` or `VAULT_*` variable set, whatever
`SLAUDE_NODE_BOOT_CHECK` says (it names the variables, never their values);
nodes make no Vault call. All variables are listed in the
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
   `automountServiceAccountToken: false`; keep it. Vault's Kubernetes login
   needs a service-account JWT, so give the **gateway pod only** a projected
   token with Vault as its audience and a short expiry, and point
   `SLAUDE_VAULT_K8S_TOKEN_PATH` at it:

   ```yaml
   # gateway Deployment, pod spec
   volumes:
     - name: vault-token
       projected:
         sources:
           - serviceAccountToken:
               audience: vault
               expirationSeconds: 600
               path: token
   # gateway container
   volumeMounts:
     - name: vault-token
       mountPath: /var/run/secrets/vault
       readOnly: true
   env:
     - name: SLAUDE_VAULT_K8S_TOKEN_PATH
       value: /var/run/secrets/vault/token
   ```

   Bind the role's `audience` to `vault` as well. Node pods keep
   `automountServiceAccountToken: false` and get no projected token, so no node
   can read a token the role trusts.
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

### Development: token auth

`SLAUDE_VAULT_AUTH=token` with `SLAUDE_VAULT_TOKEN`, and a plain `http://`
address, are for development only and need `SLAUDE_VAULT_ALLOW_INSECURE=1`.
The local cluster (`deploy/k8s-local`) uses this path against a dev-mode Vault:
the token sits in the **gateway** Secret, and no Kubernetes auth role is
involved. A static token never expires on its own and is not bound to a pod,
so anything that reads the gateway's environment holds Vault access for as
long as the token lives. Never use it on a cluster that serves real traffic.

### The service-account rule

Vault trusts whoever presents a token for the bound ServiceAccount. That token
is therefore a secret of the same weight as the Vault policy it unlocks:

- bind the Kubernetes-auth role to the **gateway's own** ServiceAccount, never
  to `default` and never to an account a node pod or any other workload runs
  under;
- mount the token only into gateway pods, as a projected token with audience
  `vault` and a short expiry (above), and keep
  `automountServiceAccountToken: false` everywhere else;
- nodes hold no Vault configuration at all; a node with any `SLAUDE_VAULT_*` or
  `VAULT_*` variable refuses to boot;
- `mono` refuses `SLAUDE_VAULT_ADDR`, because its agent child runs as the same
  user as the process that holds the token.

## Rotation

A credential is read when the runtime bundle is built: a new thread, a respawn
after the idle TTL (default 15 minutes), or a reload. Write a new version in
Vault and the next spawn picks it up; no sync and no redeploy. Because each
gateway caches a resolved value for `SLAUDE_VAULT_CACHE_TTL` seconds, a new
thread may still get the old value for up to that long after the write; to
check a rotation, start a **new thread** after the TTL has passed.

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
| Vault not answering (unreachable, timeout, 5xx, login failure) with no usable cached value | The bundle endpoint answers 503 with `transient: true` and `Retry-After`; the node fails the boot and the job takes its normal retry; the last attempt fails with `PROVIDER_CREDENTIALS_UNAVAILABLE` |
| A definitive answer: a denied or missing secret or field, a bad reference, a `baseUrl` outside the rule | 503 with `transient: false`; the node fails the boot with `PROVIDER_CREDENTIALS_UNAVAILABLE` and the job fails without a retry |
| A reference outside the allowlist | As definitive, and an error-level `provider.cred.resolve` line with reason `prefix` |
| A managed persona with no credential and `SLAUDE_PROVIDER_ENV_FALLBACK=0` | The same code |
| Vault down, warm session | Nothing changes |

How many times a failing turn asks for the bundle: the node's client retries
any 5xx up to three times in one request (waiting 250 ms, then 500 ms) and
does not read `Retry-After`; a transient failure then takes the queue's
second attempt (after about 1 s) with the same three tries. A transient
failure therefore costs about six bundle builds per turn, and so up to six
Vault reads when nothing is cached; a definitive one costs three.

Slack gets one fixed message per failed job, not one per attempt:

> :warning: I can't reach my model provider right now (credentials unavailable). The details are in the server log.

Raw error text never reaches Slack. The gateway logs one
`provider.cred.resolve` line per resolution with the persona, scheme, outcome
(`ok`, `cached`, `stale`, `denied`, `error`), duration and, on failure, an
internal reason. It never logs the path, field or value. Metrics:
`slaude_provider_cred_resolve_total{scheme,outcome}` and
`slaude_provider_cred_stale_served_total`. Alert rules for Vault being
unreachable are in the [alerts runbook](alerts.md#vault-unreachable).

## The node's own provider variables

`SLAUDE_PROVIDER_ENV_FALLBACK` on a node decides what happens when a managed
persona that does **not** set `provider` gets a bundle without some provider
variable:

- `1` (default): the node's own `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN` fill
  the gap, as before, and the node logs one warning per persona naming it and
  the variables it filled.
- `0`: every provider-selecting variable is **deleted** from the agent child's
  environment unless the bundle supplied it, and a managed persona whose
  bundle has no API key, auth token or OAuth token fails its turn with
  `PROVIDER_CREDENTIALS_UNAVAILABLE`. A session the node cannot place (no
  tenant or job token) fails the same way.

A persona that **sets** `provider` always gets the `0` behaviour, whatever the
flag. The deleted variables are whole families, so a provider mode the CLI adds
later is covered too: every `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`,
`CLAUDE_CODE_OAUTH_*`, `CLAUDE_CODE_API_KEY_*`, `CLAUDE_CODE_CLIENT_*` and
`AWS_*` variable, and `GOOGLE_APPLICATION_CREDENTIALS`, except those the bundle
supplied. What the child needs to run is never removed: `PATH`, `HOME`,
`USER`, `SHELL`, `TMPDIR`, `LANG`, `CLAUDE_CONFIG_DIR`, `ENABLE_TOOL_SEARCH`,
`SLAUDE_AGENT_ID`, and the `DISABLE_*` and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` switches slaude sets.

Set `0` once every managed persona has its own credentials, and remove the
provider variables from the node Deployment.

A node drops a session's cached bundle when the session unregisters, so
credentials do not outlive the session in the node's memory. The bundle's
ETag is an HMAC of its body keyed by `SLAUDE_MASTER_KEY`, not a bare hash of a
body that holds plaintext credentials.

**Upgrade every node before setting a reference.** A node older than v0.45.0
does not know `ownProvider`: it applies the persona's resolved set additively,
as it would a `provider_creds` row, and fills every field the persona left out
from its own environment. A persona that sets only a key then sends that key to
the node's own `ANTHROPIC_BASE_URL`, a host the persona never named. Set
`provider` on any persona only after every node in the cluster runs this
release.

## Trust model

**A provider key delivered to a node sits in the agent child's environment.**
The child runs as the same user as the node process; its Bash tool, any
plugin MCP subprocess, and any other session's child on the same node can read
it. Personas that share a node share a trust domain. The reference and the
allowlist bound what a persona can name; the Vault policy bounds what the
gateway can read at all; neither protects one persona on a node from another
persona's prompt-injected turn.

Anyone who can sync personas can change a reference, and so can set a
persona's `baseUrl`: whoever controls the persona repository decides where that
persona's model traffic goes. That is why `provider` is an atomic set. A key is
only ever sent to the host the **same** persona declared, beside that key: a
persona's `baseUrl` never receives a `provider_creds` row's key or the node's
own key, and a persona's key never goes to the node's `ANTHROPIC_BASE_URL`. A
repository change can redirect a persona's own key, which its author can name
anyway; it cannot capture another persona's or the node's. The `baseUrl` rule
keeps that traffic off loopback, link-local and metadata addresses, and off
private addresses the operator has not listed.

`env://` references are not scoped per persona (see [References](#references)).

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
