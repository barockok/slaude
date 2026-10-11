# Per-persona config on nodes, and administrator visibility

**Date:** 2026-10-03 · **Revised:** 2026-10-04 (after design review and the MCP bridge spike)
**Umbrella:** `2026-10-03-centralized-persona-runtime-design.md` — this is WS-C
**Depends on:** WS-B (node identity, labels and the gate, which the bridge's endpoints use)
**Related:** `…persona-provider-credentials…` (WS-A), whose references the visibility view
displays

## 1. Intent

An administrator opens the gateway and can answer "what is this agent, and where does it run"
without reading a database or a node's disk: its soul, model, provider references, MCP servers,
knowledge scope, skills, the label it runs on, and the nodes holding that label. Nodes consume the
same per-persona definition the gateway holds, and **no MCP credential ever reaches a node**.

Decisions from the operator that drive this spec:

- Knowledge is **a per-persona list of source ids, enforced by the gateway**.
- A persona's **remote MCP** is defined on the persona in the gateway. The node gets the *tools*,
  through a **gateway-side bridge**; the credential, the OAuth refresh and the choice between the
  agent's and a user's identity stay on the gateway.
- **Skills stay on the shared filesystem**, laid out predictably, so the gateway can list them.
- stdio MCP servers are node-local and chosen per persona on the node (WS-B).

## 2. Scope

**In:** the MCP bridge (node-side relay, gateway-side MCP client, identity and credential selection,
SSRF policy, failure behaviour); a `kb_sources` field on the persona and its enforcement, with the
bypasses the review found; the skills layout contract; the panel's persona API and first persona
screens.

**Out:** stdio MCP and the node manifest (WS-B); provider references (WS-A); a runtime *override* of KB
scope; panel editing of skills; file isolation; bridging MCP server notifications, sampling, prompts or
resources (§4.2.9); a transparent HTTP proxy for MCP (§4.2.10); moving `mono` onto the bridge (§4.2.11).

## 3. What exists today (verified in the code)

**KB.**
- A node never runs the brain. The node mounts shim MCP servers (`src/node/shims/index.ts`); each KB
  tool handler calls `POST /v1/tools/kb/<tool>`. The gateway's `executeKbTool`
  (`src/gateway/api/tools/kb.ts`) builds scope from the verified job token and calls the same
  `brainHandlers` the in-process MCP uses.
- `brainDepsFor` (`src/gateway/core/gateway.ts:745`) computes scope with
  `resolveBrainScope({ ...(await brainGateFor(ctx)), kbSources: loadKbs().map(...) })` — the **same
  global list for every persona**. `gather()` fans out one search per `allowedSources` entry, so
  narrowing that list narrows `kb_search` and `kb_think`.
- **Bypasses the review found.** `list_kbs` and `search_kbs` are unscoped and return every installed KB
  with its disk path (`mcp-tools.ts:46-63`, `tools/kb.ts:23-27`). KB content lives under
  `$SLAUDE_HOME/knowledge`, on the volume nodes mount at `/data`, so a child's Read or Grep reaches it
  directly. The **memory provider runs on nodes**: the brain is enabled by default there and
  `agentScope()` resolves the agent id to `"default"` (`agent-identity.ts`, `manager.ts:857, 1410`,
  `memory/index.ts`), so, if the hypothesis holds, every persona's transcripts — including 1:1s —
  land in a slice the default persona's `kb_search` reads. `shared` and the legacy `agent` source are
  readable by every persona. The memory-provider claim is **unverified** and is the first task in the
  plan (§4.1.7).

**Persona MCP.**
- `personas.mcp_json` is stored encrypted, with `${PERSONA_*}` placeholders already **resolved at sync
  time**, so the stored value holds real header and env secrets. The panel's runtime override accepts
  only `type: "http"`; git-synced personas accept any `mcp` object, including stdio and `sse`.
- `buildManagedBundle` returns `mcpJson: null`.
- **Correction to an earlier finding (H24):** a node does **not** mount external MCP servers —
  global `.mcp.json` or per-persona — because its resolver supplies only the shims and
  `slaude_session`. But it **does** mount **plugin MCP servers**, from the node's local disk, and they
  are not subject to any allow-list (WS-B §4.10).
- A node gets OAuth access tokens through `GET /v1/tenants/:t/mcp-credentials` and seeds them into a
  pod-local `.credentials.json` (`src/node/credentials.ts`); recovery on `needs-auth` calls the refresh
  endpoint. That machinery exists and is tested; its consumers are `mono` and plugin MCPs, because no
  node mounts an external server for it to serve. The credential **key** is
  `name|sha256({type,url,headers})` (`src/agent/mcp-oauth/store.ts`), so it depends on the headers.
- On the gateway, `sessionExternalMcp(personaId, global)` decides which servers a persona has, and the
  portal uses it. `privateOverrides` (`external-mcp.ts:89-101`) strips credentials from servers named in
  `privateServices` when a session is locked to a 1:1; `resolveEffectiveIdentity` (`manager.ts:502`)
  picks the cron-captured user, else the 1:1 lock owner, and dispatch signs it into `runAs`.
- Refresh is single-flight in process and across replicas with a Redis lock
  (`src/gateway/core/credential-refresh.ts`); the gateway already acts as an MCP client with those
  credentials for the brain (`src/knowledge/remote/brain-client.ts`).
- **No outbound-fetch protection exists** anywhere in `src/` — no host allowlist, no private-range
  denial, no redirect policy — including OAuth discovery and token exchange.

**Skills.** Layout: `$SLAUDE_HOME/skills/<slug>/SKILL.md` (global) and
`$SLAUDE_HOME/personas/<name>/skills/<slug>/SKILL.md` (a persona's overlay, merged over the global by
slug; the default persona sees the global only). Writers: the agent through `skillOps`, the installer
from `slaude.json`, and the bundled-skill seeder. On a node the skills *tools* run on the gateway's
filesystem through the shared volume; the node's SDK discovers the global `skills/` through the plugin
it mounts at `$SLAUDE_HOME`, and a persona's overlay root is not added.

**Panel.** `src/gateway/panel/api.ts` has sessions routes and persona routes
(`GET|POST /panel/api/personas`, `PUT|DELETE …/overrides/:field`), with roles `superadmin` and
`operator`, CSRF on mutations; persona routes answer 409 on sqlite and use tenant `default`. The web app
has a session list and detail only: **no persona UI**. `GET /panel/api/personas` already returns, per
persona, `origin`, `tombstoned`, `slackUserId`, `userToken: present|absent` and per field the git, live
and overridden values, including the full soul text. The registry gives `listNodes()` and `sess:<id>`
hashes; **the node heartbeat holds only a timestamp** (WS-B adds labels).

## 4. Design

### 4.1 Per-persona knowledge scope

**4.1.1 Field.** `personas.kb_sources` — nullable, an array of source ids (jsonb), an additive migration
whose number is assigned at merge, Postgres only like the table. In the `/deploy` payload:
`kbSources: ["kb-<label>", …]`.

**4.1.2 Semantics.**

| Value | Meaning |
|---|---|
| absent / `null` | all installed `kb-*` sources — **today's behaviour, so existing personas change nothing** |
| `[]` | no `kb-*` sources |
| `[a, b]` | only those, intersected with what is installed |

The list governs **only the `kb-*` sources**. The caller's own slice, `shared`, `public` and the legacy
source keep their existing rules.

**4.1.3 Enforcement.** In `brainDepsFor.scope`, replace `loadKbs().map(kbSourceId)` with the persona's
list intersected with the installed sources, resolved from the live persona. The in-process MCP and the
REST tool plane both use `brainDepsFor`, so both are covered; the intersection is computed per call, so a
sync takes effect on the next turn.

**4.1.4 The unscoped tools.** `list_kbs` and `search_kbs` take the same persona-filtered list and **stop
returning disk paths**. A persona can no longer learn that a KB it may not read exists.

**4.1.5 Validation at sync.** Each id must have the `kb-<label>` shape. An id that matches no *installed*
KB is a **warning**, since the installer and the persona sync land independently; a malformed id is a
`PayloadError`.

**4.1.6 No runtime override.** The override set stays `soul | model | mcp`.

**4.1.7 What this does and does not guarantee, and the first task.** `kbSources` filters *retrieval*. It
is **not isolation**: KB files are readable on the shared volume, and personas on one node share a trust
domain (WS-B §4.12). The docs say so. Before the plan is written, **verify the memory-provider claim**
in a node pod: with the brain enabled on a node, do a named persona's transcripts land in the
`agent-default` slice? If they do, the fix is one of: route memory through the gateway with the persona's
agent id; or set `SLAUDE_BRAIN_DISABLED=1` on nodes; the plan picks by what the verification shows. Also
decide (open decision 3) whether nodes mount `knowledge/` at all; they need `skills/`, `personas/` and
`workspaces/`, not the KB wikis.

### 4.2 The MCP bridge

A persona's remote MCP servers reach the agent on a node as **in-process MCP servers that relay to the
gateway**, which is the MCP client to the real server. The credential, the OAuth refresh and the choice of
identity never leave the gateway. This extends the pattern the node already uses for Slack, KB and skills.

```
agent loop (CLI)
  ├─ "A"  in-process server, inside the node process
  ├─ "B"  in-process server
  └─ "C"  in-process server
        │  tools/list, tools/call  → POST /v1/tools/mcpx/<server>/{list,call}
        │  (node bearer + job token; label gate; runAs per turn)
        ▼
  gateway: MCP client, credential chosen by runAs, refreshes OAuth
        │  real MCP over HTTP
        ▼
  the real servers A, B, C
```

**4.2.1 What the agent sees.** Three independent MCP servers, each with its full tool list, under the usual
`mcp__<server>__<tool>` names. The tool names, descriptions and input schemas are the upstream's own.
The agent cannot tell a bridge from a direct connection in normal use.

**4.2.2 The node side is generic and relays.** One factory builds, per server name in the bundle, an
`McpServer` (the SDK's required in-process type) whose two request handlers are set on its low-level
`.server` and **do no conversion**:

- `tools/list` → `POST /v1/tools/mcpx/<server>/list` → the gateway's `tools/list` → the raw definitions
  (JSON Schema, `outputSchema`, annotations) returned unchanged. No zod conversion.
- `tools/call` → `POST /v1/tools/mcpx/<server>/call` with `{name, arguments}` → the gateway's
  `tools/call` → `{content[], isError, structuredContent}` returned unchanged.

The bundle carries the persona's server **names only** (`mcpServers: ["A","B","C"]`); no URL, header or
secret. `bundle.mcpJson` stays `null`. The server's `instructions` string is fetched once with the list
and passed as the in-process server's `instructions`.

**4.2.3 The gateway side.** New tool-plane routes `mcpx/<server>/list` and `mcpx/<server>/call`, behind the
node bearer, the job token and WS-B's label gate, built on `executeToolCall`'s existing pattern. Context
comes from the verified claims, never the body. The handler is an MCP **client** to the upstream, with a
pool of sessions keyed by `(owner, server)` that reconnects when an upstream session expires, using the
same refresher as the brain client. Calls honour a per-call timeout (the CLI's per-tool timeout is
respected; the gateway's own is shorter than any ingress timeout) and the request's abort signal, which
is propagated to the upstream.

**4.2.4 Which credential, per call.** From the job token's `runAs`:

| Turn | Credential used for server `S` |
|---|---|
| `runAs = agent` | the agent's OAuth entry for `S`, else the static headers in the config |
| `runAs = user`, `S` **private** (`privateServices`, locked 1:1) | the **user's** OAuth entry only; never the agent's, never static headers. A user with no account or grant gets a tool error "connect `S`" — **no fallback to the agent** |
| `runAs = user`, `S` not private | the user's OAuth entry if present, else the config's static headers (agent-wide) |

This reproduces `resolveOwner` and `privateOverrides` on the gateway, including stripping static headers
and **query-string secrets** for private servers, and the cron-captured identity winning over the live
lock. The plan pins each row with a test against the existing behaviour. The owner is re-derived on
**every call**, so a 1:1 starting, ending or a cron turn with a captured user needs no reboot and no file
rewrite on the node. Upstream sessions are never shared across owners.

**4.2.5 The tool list is fixed when the child boots (measured).** The CLI calls `tools/list` once. In the
spike, after the identity changed and a `tools/list_changed` notification was sent, the CLI **did not list
again**, and `reconnectMcpServer` does not work on in-process servers (it throws "SDK servers should be
handled in print.ts" and blanks the status). So:

- **The list is computed at child boot, from the `runAs` at that moment.**
- **Per-call credentials still follow the current `runAs`** (measured: the same live session reached the
  upstream as the agent in one turn and as the user in the next).
- This matches how sessions already behave: a locked 1:1 is user-owned from boot, and a lock flip already
  reboots the child, which re-lists. An unlocked thread runs as the agent. A tool listed for the agent but
  needing the user's credential fails cleanly at the upstream.
- **Edge:** a cron turn with a captured initiator on an already-warm session keeps the boot-time list. The
  spec accepts this and the docs state it.

**4.2.6 Failure behaviour.** An upstream 401 makes the gateway refresh (single-flight, Redis-locked across
replicas) and retry once. If refresh fails or answers "reconnect", the tool result is `isError` with fixed
text ("this agent's connection to `S` needs to be re-authorised"), **never** the upstream's error body, and
the gateway posts the existing connect card in the thread, because the claims carry channel and thread. The
CLI sees an ordinary tool error, so it never caches `needs-auth` for hours. An upstream or gateway outage is
a tool error, not a session failure.

**4.2.7 SSRF policy (new, required).** The gateway attaches real credentials to URLs taken from persona
configuration, and today **nothing in the repo validates outbound hosts**. Before the bridge ships:

- each server's origin is **pinned** at connect or sync and every request goes only to it;
- only `https` (and `http` for loopback in development only) is allowed;
- the resolved address is checked against private, loopback, link-local and metadata ranges **at connect
  time, after DNS resolution**, so DNS rebinding cannot reach the cluster;
- redirects are **not followed** (`redirect: "manual"`), since a redirect would carry the credential;
- OAuth discovery and token-exchange fetches get the same policy (they share the gap today).

An operator-controlled allowlist of hosts can narrow this further. The same module serves WS-D's backlog
item on outbound fetches.

**4.2.8 Limits.** A request-size cap and a result-size cap with a clear truncation message; a per-owner
concurrency limit so one persona cannot exhaust the gateway's sockets.

**4.2.9 What is not bridged.** Server-to-client notifications, sampling, and MCP prompts and resources. Agents
use tools. If a real server needs one of the others, it is added later, per server, not assumed.

**4.2.10 Why not a transparent HTTP proxy.** Investigated and rejected for MCP: the CLI would carry a bearer
on argv fixed at boot, with no rotation; a static `Authorization` header turns off the CLI's OAuth so a 401
becomes terminal, and without it the CLI starts OAuth discovery against the gateway's own URL; there is no
streaming passthrough in the codebase; legacy `sse` servers need their `endpoint` event rewritten; and the
`/v1` bearer cannot be sent by the scrubbed child. The bridge avoids all of it.

**4.2.11 What this retires, and what it leaves.** For gateway-managed servers the node no longer needs the
credential seeding, the `needs-auth` recovery, the two `mcp-credentials` endpoints or the key coupling to
the CLI's header hash (`src/node/credentials.ts` and its wiring). They stay until the bridge is proven, then a
cleanup task removes the node-side parts; `mono` keeps its current path (it has no node boundary to protect)
and may move later. Plugin MCP servers and stdio servers are **node-local software** and are governed by
WS-B's manifest allow-list, not the bridge.

**4.2.12 Spike results, recorded.** A throwaway upstream MCP server, a gateway-side relay and a node-side
generic bridge were exercised with the real CLI through the Agent SDK. Model-free, 15 of 15 checks passed,
including tool definitions byte-equal to a direct connection. Through the CLI: all five tool shapes (simple,
complex nested schema, image content, `isError`, `structuredContent`) were called by the model and reached the
upstream with intact arguments; the upstream saw the agent's credential in one turn and the user's in the next,
in the same live session; the tool list did **not** refresh mid-session (§4.2.5). Not measured: the REST hop,
session pooling, latency, OAuth refresh, abort propagation, large results, per-tool timeouts. These are in the
test plan.

### 4.3 Skills

**4.3.1 The contract.** The two roots in §3 are the contract between the gateway and the nodes: stable,
documented, covered by a test that fails if either side moves them. The gateway lists a persona's skills with
`skillOps.list(name)`.

**4.3.2 Provenance.** The list does not say whether a skill is global or the persona's own; `discoverSkills`
gains `source: "global" | "persona"` while merging. No change in behaviour.

**4.3.3 What a node sees.** A persona's overlay is reachable on a node only through the `slaude_skills` tools.
Whether to add the overlay root to the node's plugin set so persona skills are first-class `/skill` targets is
open (§9). The panel view does not depend on it.

**4.3.4 Out.** Panel editing of skills.

### 4.4 Visibility: the read model and the panel

**4.4.1 `GET /panel/api/personas/:name`** — one persona's definition, for any authenticated operator:

```jsonc
{
  "name": "…", "origin": "git|runtime", "tombstoned": false, "slackUserId": "U…",
  "soul": { "length": 377, "overridden": false, "preview": "first N chars" },
  "model": { "git": "…", "live": "…", "overridden": false },
  "runsOn": "label",                                   // WS-B
  "provider": { "apiKey": "vault://… | env://… | stored | none", "baseUrl": "https://…" },   // WS-A, references only
  "mcp": [ { "name": "…", "via": "bridge|plugin|stdio", "type": "http", "host": "example.com", "oauth": true } ],
  "kb": { "mode": "all|none|list", "sources": [ { "id": "kb-…", "installed": true } ] },
  "skills": [ { "slug": "…", "name": "…", "source": "global|persona" } ],
  "nodes": [ { "id": "…", "alive": true, "labels": ["…"] } ]
}
```

Never present: secret values, MCP headers or env, resolved provider values. A reference's *path* is shown only
to authenticated panel users and is not logged. The existing list route keeps its shape, adding `runsOn` and a
`kb.mode` summary.

**4.4.2 Nodes.** With WS-B the heartbeat carries labels, so "nodes running this persona" is the live nodes holding
its `runs_on` label, read from the registry. (Warm-session counts and node version or capacity are **not** in this
first cut.)

**4.4.3 Web app.** A hash route `#/p/<name>` and a persona list reachable from the header, following the existing
hash routing and the `?mock=1` fixture backend: `api.ts` gains `Backend` methods, `App.tsx` the second route, and
two components built from `ui.tsx` primitives. Read only. The existing override endpoints are not surfaced yet.

**4.4.4 Constraints carried over.** Persona routes stay managed-only (409 on sqlite) and tenant `default`.

## 5. Migration

One additive migration: `personas.kb_sources` (number assigned at merge). Existing rows are `null`, meaning "all
installed", so behaviour is unchanged until a persona sets it. `export` omits it when null; `render --check`
validates ids with the gateway's parser. The bundle gains `mcpServers` (names); a node ignores it until the bridge
ships, so mixed-version clusters keep working. A gateway that does not know `kbSources` refuses a payload carrying it
(strict, versioned payload, WS-D foundations), so an older gateway cannot strip it silently and widen scope.

## 6. Security

- Scope is computed on the gateway from the verified job token and the live persona; a node supplies no scope input.
- **No MCP secret reaches a node.** The bridge keeps static headers, OAuth tokens and refresh tokens on the gateway.
- The bridge's routes are gated by WS-B's label gate and use the node bearer and the job token; the owner is re-derived
  per call from the signed `runAs`.
- The SSRF policy (§4.2.7) is a precondition.
- The panel read route is authenticated like the existing ones and returns presence and references, never values.
- Public-repo hygiene: generic labels and hosts in tests and docs.

## 7. Testing

**Unit.**
- KB: list semantics (absent, empty, list, unknown id, malformed id); the `brainDepsFor` intersection; `list_kbs` and
  `search_kbs` filtered and path-free; a persona with `[]` finds nothing in a `kb-*` source it could otherwise read.
- Bridge, node side: list and call relay unchanged (definitions byte-equal); `instructions` mirrored; names are
  `mcp__<server>__<tool>`; bundle carries names only.
- Bridge, gateway side: the credential matrix of §4.2.4 row by row, against the existing `privateOverrides` and
  `resolveOwner` behaviour; no agent fallback for an unbound user; owner re-derived per call (an agent turn then a user turn
  in one session); upstream sessions never shared across owners; 401 → refresh → retry once; refresh failure →
  fixed error text and a connect card, never the upstream body.
- SSRF policy: private, loopback, link-local and metadata addresses refused; a hostname that resolves to a private address
  refused (rebinding); a redirect not followed; non-https refused.
- The tool list is computed at boot from the boot-time `runAs`.
- Skills: `discoverSkills` provenance; the layout contract test.
- Panel read model redaction: a persona with secret headers, env and provider values yields none of them.

**Existing suites to extend:** `tests/gateway/api/runtime-persona`, `runtime-effective`; `tests/gateway/core/external-mcp`,
`session-external-mcp`, `cron-private-mcp-scoping`, `credential-refresh*`; `tests/brain-scope`;
`tests/gateway/portal/integrations-aggregate`; `tests/skills`; `tests/panel/personas-overrides`; `tests/node/worker-e2e`,
`shims`. There is **no test today** of a per-persona KB list, of a node consuming persona MCP, of an outbound-host policy, or
of the live CLI against a bridged server; the bridge's CLI test follows the spike's harness.

**Integration (`k8s-local`).** A real upstream MCP server (the repo's `mock-mcp` answers `{}` and is not one; the spike's is
the model); a persona's bridged server appears in the agent's tool list on a node and is callable; a locked 1:1 reaches the
upstream as the user and an unlocked thread as the agent; revoke the grant upstream and see the fixed error and the connect
card; abort a turn mid-call and see the upstream request cancelled; a large result is truncated with the message; the latency
overhead of the extra hop is measured and recorded.

**Panel.** API tests for the new route's auth and redaction; the Playwright suite gains the persona list and detail on the mock
backend.

## 8. Release

The DB column, the bundle contract, the new tool-plane routes and the node's MCP resolver (the agent loop) change: a release
candidate, after WS-B. The bridge and the KB work can land in separate RCs; the panel read route and screens alone could ship
earlier as a normal minor. The plan decides the split.

## 9. Open decisions

1. **Whether the bridge ships behind a per-server switch** (`bridge` vs leaving a server unmounted on nodes) for the first RC.
2. **Persona-private skills as first-class targets on nodes**, or only reachable through the skills tools.
3. **Whether nodes mount `knowledge/` at all** (§4.1.7).
4. **The memory-provider fix** once verified (§4.1.7).
5. **Moving `mono` onto the bridge** and removing the node-side credential seeding, as a later cleanup.
