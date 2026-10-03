# Per-persona config on nodes, and administrator visibility

**Date:** 2026-10-03
**Umbrella:** `2026-10-03-centralized-persona-runtime-design.md` — this is WS-C
**Depends on:** WS-B (node labels), for the "which nodes run this agent" view
**Related:** `2026-10-03-persona-provider-credentials-design.md` (WS-A), whose
references the visibility view displays

## 1. Intent

An administrator opens the gateway and can answer "what is this agent, and where
does it run" without reading a database or a node's disk: its soul, model,
provider references, MCP servers, knowledge scope, skills, the label it runs on,
and the nodes holding that label. Nodes consume the same per-persona definition
the gateway holds, and nothing more.

Three decisions from the operator drive this spec:

- Knowledge is **a per-persona list of source ids, enforced by the gateway**.
  Nodes never read knowledge content.
- A persona's **remote MCP** is defined on the persona in the gateway and is
  mounted on the node that runs the persona's turn.
- **Skills stay on the shared filesystem**, laid out predictably, so the gateway
  can list what a persona has by reading that layout.

## 2. Scope

**In:** a `kb_sources` field on the persona and its enforcement; node-side
mounting of a persona's remote MCP; how a persona's skills are listed and what a
node sees; the panel's persona API additions and its first persona screens;
node information the panel needs.

**Out:** stdio MCP and the node manifest (WS-B); provider references (WS-A);
a runtime *override* of KB scope (§4.1.5); any editing of skills from the panel;
file isolation between labels (sandboxing); a software inventory.

## 3. What exists today (verified in the code)

**KB.**
- A node never runs the brain. The node mounts shim MCP servers
  (`src/node/shims/index.ts`); each KB tool handler calls
  `client.postTool("kb", tool, args, jobToken)`, which is
  `POST /v1/tools/kb/<tool>`. The gateway's `executeKbTool`
  (`src/gateway/api/tools/kb.ts`) builds scope from the verified job token and calls
  the same `brainHandlers` the in-process MCP uses.
- `brainDepsFor` (`src/gateway/core/gateway.ts:745`) computes scope with
  `resolveBrainScope({ ...(await brainGateFor(ctx)), kbSources: loadKbs().map(...) })`.
  `kbSources` is the **same global list for every persona**.
- Source ids are derived, not stored (`src/knowledge/scope.ts`): `user-<id>`,
  `agent-<agentId>`, `shared`, `public`, the legacy `agent`, and `kb-<label>` per
  installed KB directory under `$SLAUDE_HOME/knowledge`. Installation is
  `slaude.json` `knowledge[]` and stays an operator-level, gateway-side concern.
- A persona reads every `kb-*` source whenever it is in a trusted channel, in a
  1:1, or on a cron turn. A public-channel turn is limited to `public`.
- Writes are unaffected by `kbSources`: the `kb_*` handlers cannot target `kb-*`,
  `public` or the legacy source.
- `gather()` fans out one search per `allowedSources` entry, so narrowing that
  list narrows `kb_search` and `kb_think` in one place. The remote brain server
  trusts the scope its caller sends; it does not resolve one.

**Persona MCP.**
- `personas.mcp_json` is stored, encrypted, with `${PERSONA_*}` placeholders
  already **resolved at sync time** (`resolvePlaceholders`), so the stored value
  holds real header and env secrets. Managed persona MCP is HTTP-only
  (`assertHttpOnlyMcp`).
- `buildManagedBundle` returns `mcpJson: null`, with a comment that nodes do not
  consume a persona's MCP. The unmanaged tiers do ship `mcpJson`, but no node code
  reads `bundle.mcpJson`. The same holds for `bundle.skillsPaths`.
- On a node, the MCP resolver (`src/node/worker.ts`, `agent.setMcpResolver`)
  supplies only the shims and `slaude_session`. External MCP servers, global or
  per-persona, are **not mounted on nodes**. *To be confirmed by a test in a node
  pod before this is built*, because it is wider than the field notes imply.
- A node does get OAuth access tokens for MCP servers: `GET
  /v1/tenants/:t/mcp-credentials` returns an allowlisted projection, and the node
  seeds it into a pod-local credentials file. The credential **key** is
  `name|sha256({type,url,headers})` (`src/agent/mcp-oauth/store.ts`): **it includes
  the headers**, so a node must mount a server with exactly the headers the key was
  made from or the seeded token will not match.
- On the gateway, `sessionExternalMcp(personaId, global)` is the one function that
  decides which servers a persona has, and the portal already uses it.

**Skills.**
- Layout: `$SLAUDE_HOME/skills/<slug>/SKILL.md` (global) and
  `$SLAUDE_HOME/personas/<name>/skills/<slug>/SKILL.md` (a persona's overlay,
  merged over the global by slug; the default persona sees the global only).
- Writers: the agent through `skillOps` (`write` and `delete` go to the persona's
  overlay; a named persona cannot delete a global skill); the installer from
  `slaude.json`; and the bundled-skill seeder at boot.
- On a node the skills tools run on the **gateway's** filesystem
  (`src/gateway/api/tools/skills.ts`), relying on the shared volume. The node's SDK
  discovers the global `skills/` through the plugin it mounts at `$SLAUDE_HOME`; a
  persona's overlay root is not added.

**Panel.**
- Backend `src/gateway/panel/api.ts`: sessions routes and persona routes
  (`GET|POST /panel/api/personas`, `PUT|DELETE .../:name/overrides/:field`). Roles
  are `superadmin` and `operator`; reads need any authenticated operator,
  mutations need superadmin; CSRF header on mutations. Persona routes answer 409
  on sqlite and use a hard-coded tenant `default`.
- The web app (`src/gateway/panel/web/app/`) has a session list and session detail
  only. **It has no persona UI**; the persona endpoints are not called.
- `GET /panel/api/personas` already returns, per persona, `origin`, `tombstoned`,
  `slackUserId`, `userToken: present|absent`, and per field (soul, model, mcp) the
  git value, the live value and whether it is overridden. It returns the full soul
  text.
- The registry gives `listNodes()` (a SCAN of heartbeat keys with a 30 s TTL),
  `sess:<id>` hashes `{node, since, lastBeat}` and `listByNode`. **The node
  heartbeat holds only a timestamp.**

## 4. Design

### 4.1 Per-persona knowledge scope

**4.1.1 Field.** `personas.kb_sources` — nullable, an array of source ids stored as
JSON text on sqlite and jsonb on Postgres (additive migration). In the `/deploy`
payload: `kbSources: ["kb-<label>", …]`.

**4.1.2 Semantics.**

| Value | Meaning |
|---|---|
| absent / `null` | all installed `kb-*` sources — **today's behaviour, so existing personas change nothing** |
| `[]` | no `kb-*` sources |
| `[a, b]` | only those, intersected with what is installed |

The list governs **only the `kb-*` sources**. The caller's own slice, `shared`,
`public` and the legacy source keep their existing rules; a persona's private
memory is not something a KB allow-list can remove.

**4.1.3 Enforcement.** One edit in `brainDepsFor.scope`: replace
`loadKbs().map(kbSourceId)` with the persona's list intersected with the installed
sources, resolved from the effective persona (`livePersona(ctx.personaId)`). Both
the in-process MCP and the REST tool plane use `brainDepsFor`, so both are covered.
The intersection is computed on every call from the live registry, so a sync takes
effect on the next turn with no restart.

**4.1.4 Validation at sync.** Each id must look like `kb-<label>` (the `kbSourceId`
shape). An id that matches no *installed* KB is a **warning**, not an error: the
installer and the persona sync are independent and may land in either order. A
malformed id is a `PayloadError`.

**4.1.5 No runtime override.** The override set stays `soul | model | mcp`. KB
scope changes through the sync, like provider references. (Runtime-origin personas
created in the panel can set it at creation.)

**4.1.6 Defence in depth, and its limit.** A node cannot widen scope: it never
sends one. With the remote brain mode, the brain server trusts the scope the
gateway sends, so the gateway process remains the single enforcement point. Two
other callers use `agentScope()` (the memory provider and the backfill) and are not
KB readers; they are unchanged.

### 4.2 Persona remote MCP on nodes

**4.2.1 The shape.** The runtime bundle gains `mcpServers`: the persona's
effective HTTP servers, as `{ name: { type, url, headers } }`, for a node holding the
persona's label (WS-B's gate) and for no one else. The node's MCP resolver adds
them to the shims and `slaude_session` it already supplies.

**4.2.2 Exact headers.** Because the OAuth credential key includes the headers, the
node mounts each server with the headers the bundle carries, byte for byte, and the
gateway builds the key from the same object. A test asserts that the key a node
computes equals the key the gateway stored under, for a server with headers and for
one without.

**4.2.3 Decision needed: static header secrets.** A persona's MCP can carry a
secret header (for example an `Authorization` value resolved from `PERSONA_*` at
sync). The agent child calls the server directly, so a node that mounts it must
hold the value. Three options:

- **A. Ship it to gated nodes (recommended).** The bundle carries the resolved
  headers to a node that holds the persona's label. Smallest change; consistent
  with provider credentials, which also reach the gated node. The trade-off is
  that a static MCP secret now exists in a node's memory for the session, so a
  compromised *matching* node can read it. OAuth-backed servers do not have this
  property, because their tokens are short-lived and projected.
- **B. Strip secrets; OAuth only.** Ship `type` and `url` with no static secret
  headers and require OAuth for anything secret. Safest, but a persona with a
  static-token server stops working on nodes.
- **C. Proxy through the gateway.** The gateway makes the MCP call, as it does for
  KB. Keeps every secret off nodes; a large new component and a hop on every call.

This spec assumes **A**, and ships the bundle field only for OAuth-free or
gated paths; the operator confirms or chooses B or C before the plan.

**4.2.4 The existing global list.** If the node-pod test (§3) confirms nodes mount
no external MCP at all, the global `.mcp.json` servers need the same treatment,
through the same bundle field, or the cluster silently has no external MCP. The plan
includes that test as its first task and the fix as part of this workstream if
confirmed.

**4.2.5 Redaction.** Nothing here changes what the panel shows: MCP appears as
server name, type and host only, never headers or env.

### 4.3 Skills

**4.3.1 The contract.** The two roots in §3 are the contract between the gateway
and the nodes: stable, documented, and covered by a test that fails if either side
moves them. The gateway lists a persona's skills by calling `skillOps.list(name)`.

**4.3.2 Provenance.** The list result does not say whether a skill is global or the
persona's own. The panel needs it, so `discoverSkills` gains a `source:
"global" | "persona"` field computed while merging. No change to behaviour.

**4.3.3 What a node sees.** Today a node's SDK discovers global skills; a persona's
overlay is reachable only through the `slaude_skills` tools. Whether to add the
overlay root to the node's plugin set, so persona skills are first-class `/skill`
targets on nodes as they are on the gateway, is **open** (§9). The panel view does
not depend on it.

**4.3.4 Out.** Panel editing of skills. Skills are written by the agent as it
learns; a panel write path would need a merge policy the personas-as-code work
deliberately avoided.

### 4.4 Visibility: the read model and the panel

**4.4.1 `GET /panel/api/personas/:name`.** One persona's definition, for any
authenticated operator:

```jsonc
{
  "name": "…", "origin": "git|runtime", "tombstoned": false,
  "slackUserId": "U…",
  "soul": { "length": 377, "overridden": false, "preview": "first N chars" },
  "model": { "git": "…", "live": "…", "overridden": false },
  "runsOn": "label",                       // WS-B
  "provider": {                            // WS-A; references only
    "apiKey": "vault://… | env://… | stored | none", "baseUrl": "https://…"
  },
  "mcp": [ { "name": "…", "type": "http", "host": "example.com", "oauth": true } ],
  "kb": { "mode": "all|none|list", "sources": [ { "id": "kb-…", "installed": true } ] },
  "skills": [ { "slug": "…", "name": "…", "source": "global|persona" } ],
  "nodes": [ { "id": "…", "alive": true, "labels": ["…"], "warmSessions": 2 } ]
}
```

Never present: secret values, MCP headers or env, resolved provider values. A
reference's *path* is shown to authenticated panel users only; it is not logged.
The existing list route keeps its shape, with `runsOn` and a `kb.mode` summary added.

**4.4.2 Nodes.** With WS-B, the node heartbeat carries the node's labels, so "nodes
running this persona" is "live nodes holding its `runs_on` label", read from the
registry. `warmSessions` joins `sess:<id>` entries through `listByNode` and the
`sessions` table. Node-level facts beyond labels (version, capacity) are optional;
the heartbeat gains them only if the operator wants them.

**4.4.3 Web app.** A hash route `#/p/<name>` and a persona list reachable from the
header, following the existing hash-routing and the `?mock=1` fixture backend:
`api.ts` gains `Backend` methods, `App.tsx` the second route, and two components
(`PersonaList`, `PersonaDetail`) built from the existing `ui.tsx` primitives. Read
only in this spec. The existing override endpoints are not surfaced yet.

**4.4.4 Constraints carried over.** Persona routes stay managed-only (409 on
sqlite) and tenant `default`; this spec does not generalise either.

## 5. Migration

One additive migration: `personas.kb_sources`. Existing rows are `null`, meaning
"all installed", so behaviour is unchanged until a persona sets the field.
`export` omits it when null; `render --check` validates ids with the same parser the
gateway uses. The bundle gains `mcpServers` and a node ignores it until the node
resolver step ships, so mixed-version clusters keep working during a rollout.

## 6. Security

- Scope is computed on the gateway from the verified job token and the live
  persona; a node supplies no scope input.
- Shipping MCP secrets to nodes (§4.2.3) is the one new exposure. It is confined to
  nodes that pass WS-B's gate, and the decision is the operator's.
- The panel's new read route is authenticated like the existing ones and returns
  presence and references, never values.
- Public-repo hygiene as elsewhere: generic labels and hosts in tests and docs.

## 7. Testing

**Unit.** KB list semantics (absent, empty, list, unknown id, malformed id); the
`brainDepsFor` intersection; the credential-key equality of §4.2.2; the bundle
shape for a persona with and without MCP; `discoverSkills` provenance; the panel
read model's redaction (a persona with secret headers and env yields none of them).

**Existing suites to extend:** `tests/gateway/api/runtime-persona` and
`runtime-effective`, `tests/gateway/core/session-external-mcp`,
`tests/brain-scope`, `tests/gateway/portal/integrations-aggregate`, `tests/skills`,
`tests/panel/personas-overrides`, `tests/node/worker-e2e`. There is **no test today**
of a per-persona KB list or of a node consuming `mcpJson`/`skillsPaths`; both are
added here.

**Panel.** API tests for the new route's auth and redaction; the Playwright suite
(`tests/panel-web/panel.spec.ts`) gains the persona list and detail on the mock
backend.

**Integration (`k8s-local`).** A node-pod test that a persona's HTTP MCP appears in
the agent's tool list on a node; a persona with `kbSources: []` finds nothing in a
`kb-*` source it could otherwise read; two personas with different lists see
different results.

## 8. Release

The DB column, the bundle contract and the node's MCP resolver (the agent loop)
change, so this ships as a release candidate, after WS-B. The panel read route and
screens alone could ship earlier as a normal minor; the plan decides the split.

## 9. Open decisions

1. **§4.2.3** — static MCP header secrets on nodes: A (ship to gated nodes), B (OAuth
   only) or C (proxy). Recommended A.
2. **§4.3.3** — persona-private skills as first-class targets on nodes, or only
   reachable through the skills tools.
3. **§4.4.2** — whether the node heartbeat should carry version and capacity beyond
   labels.
4. **§4.2.4** — the global external MCP list on nodes, pending the node-pod test.
