# Brain Remote MCP — Implementation Plan

> **For agentic workers:** Implement task-by-task with TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run the gbrain engine behind `slaude_kb` as a separate OAuth-protected MCP process, selectable via config (local default / remote), slaude proxying.

**Architecture:** A `BrainBackend` seam in `brain.ts` routes `brainCall`/`brainAdminCall` to either a `LocalBackend` (current in-process engine) or a `RemoteBackend` (OAuth'd MCP client → brain server). A new `slaude brain-server` process boots the engine and serves two dumb-engine MCP tools behind a Keycloak JWT resource guard. Scope + gating stay in slaude.

**Tech Stack:** Bun + TS, `@modelcontextprotocol/sdk` (client + webStandard streamable-http server), `jose` (JWKS JWT verify), existing `src/agent/mcp-oauth/*` loopback.

## Global Constraints

- Public repo — no real names/orgs/internal identifiers. Generic placeholders only.
- Default behavior unchanged: no `SLAUDE_BRAIN_MODE` / `local` → identical to today.
- Engine boot/lifecycle (`getBrain`/`boot`/`closeBrain`/embedding) stays local-only; in remote mode slaude never boots an engine.
- gbrain imported only via `gbrainImport` (never tsc-resolved).
- Granular commits, one logical change each.
- Test runner: `bun test`. Typecheck: `bun run typecheck`.

---

### Task 1: Brain mode/remote/oidc config

**Files:**
- Create: `src/knowledge/brain-config.ts`
- Test: `tests/brain-config.test.ts`

**Interfaces:**
- Produces: `brainMode(): "local" | "remote"`, `brainRemoteUrl(): string` (throws if remote & unset), `brainServerConfig()` `{port,host,publicUrl,issuer,audience,authDisabled}`, `brainBearerEnv(): string | undefined`.

- [ ] **Step 1:** Write `tests/brain-config.test.ts`: default mode is `local`; `SLAUDE_BRAIN_MODE=remote` → `remote`; `brainRemoteUrl()` throws when remote and `SLAUDE_BRAIN_URL` unset, returns url when set; `brainServerConfig()` defaults (port 4319, host `0.0.0.0`, authDisabled false); `SLAUDE_BRAIN_AUTH_DISABLED=1` → authDisabled true. Save/restore `process.env` per test.
- [ ] **Step 2:** Run `bun test tests/brain-config.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `brain-config.ts` reading env getters.
- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Commit `feat(brain): brain-config mode/remote/oidc getters`.

---

### Task 2: Engine-op runner extracted (shared by Local + server)

**Files:**
- Modify: `src/knowledge/brain.ts`
- Create: `tests/brain-runop.test.ts`

**Interfaces:**
- Produces: `runScopedOp(name, params, scope): Promise<unknown>` (current `brainCall` body: ensureSource for writes + buildCtx synthetic-auth + handler), `runAdminOp(name, params, sourceId): Promise<unknown>` (current `brainAdminCall` body). Both exported. These are the LocalBackend primitives and are reused verbatim by the brain server.

- [ ] **Step 1:** Write `tests/brain-runop.test.ts` — stub `gbrainImport` indirection is hard; instead assert `runScopedOp` and `runAdminOp` are exported functions and that `runScopedOp` calls `ensureSource` for a write op. Use a spy by mocking `operations` via a temp gbrain stub is over-engineering — instead test the ctx-builder purity: export `buildScopedCtxAuth(scope)` returning the synthetic `auth` object and assert its shape (`token:"in-process"`, clientId, scopes `["read","write"]`, sourceId, allowedSources). Keep the op-dispatch tested in Task 3 against the server handler.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** In `brain.ts`, rename `brainCall` body into `runScopedOp`, `brainAdminCall` body into `runAdminOp`; extract `buildScopedCtxAuth(scope)`; keep `brainCall`/`brainAdminCall` as thin wrappers that (for now) call `runScopedOp`/`runAdminOp` directly. Export the three.
- [ ] **Step 4:** Run `bun test tests/brain-runop.test.ts` and full `bun test` → PASS (no behavior change).
- [ ] **Step 5:** Commit `refactor(brain): extract runScopedOp/runAdminOp engine primitives`.

---

### Task 3: BrainBackend + getBackend selection

**Files:**
- Create: `src/knowledge/backend.ts`
- Modify: `src/knowledge/brain.ts` (delegate `brainCall`/`brainAdminCall` to `getBackend()`)
- Test: `tests/brain-backend.test.ts`

**Interfaces:**
- Consumes: `runScopedOp`/`runAdminOp` (Task 2), `brainMode`/`brainRemoteUrl` (Task 1).
- Produces: `interface BrainBackend { call(name,params,scope); adminCall(name,params,sourceId) }`, `LocalBackend` (delegates to runScopedOp/runAdminOp), `getBackend(): BrainBackend`, `setBackendForTest(b)` / `resetBackend()`.

- [ ] **Step 1:** Write `tests/brain-backend.test.ts`: default `getBackend()` is LocalBackend (call routes to a stubbed runner via injection point); `SLAUDE_BRAIN_MODE=remote` selects RemoteBackend (assert constructor called / instanceof). Use a lazy remote factory so importing doesn't require the client. Reset singleton between tests.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `backend.ts` with `LocalBackend` (`call`→runScopedOp, `adminCall`→runAdminOp), cached `getBackend()` selecting via `brainMode()`, remote constructed lazily (`new RemoteBackend(brainRemoteUrl())`). Change `brain.ts` `brainCall`→`getBackend().call(...)`, `brainAdminCall`→`getBackend().adminCall(...)`.
- [ ] **Step 4:** Run `bun test` → PASS.
- [ ] **Step 5:** Commit `feat(brain): BrainBackend seam + getBackend mode selection`.

---

### Task 4: OAuth resource guard (jose JWT + PRM)

**Files:**
- Create: `src/knowledge/server/oauth-guard.ts`
- Test: `tests/brain-oauth-guard.test.ts`

**Interfaces:**
- Produces: `verifyBearer(authHeader: string | null, cfg): Promise<{ok:true}|{ok:false,status,wwwAuth?}>` using `jose.jwtVerify` with a `createRemoteJWKSet` (injectable for tests), checking `iss`/`aud`; `protectedResourceMetadata(cfg)` → `{resource, authorization_servers:[issuer]}`. `authDisabled` short-circuits ok.

- [ ] **Step 1:** Write test: generate an RSA keypair with `jose.generateKeyPair("RS256")`; sign a JWT (good iss/aud) → `verifyBearer` ok; wrong aud → `{ok:false,status:401}`; wrong iss → fail; expired → fail; missing header → `{ok:false,status:401,wwwAuth contains resource_metadata}`; `authDisabled:true` → ok regardless. Inject a `getJWKS` returning the local public key.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `oauth-guard.ts` (jose verify with injectable key resolver; PRM builder; WWW-Authenticate string).
- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Commit `feat(brain): OAuth resource guard (Keycloak JWT verify + PRM)`.

---

### Task 5: Brain server (engine + MCP tools + HTTP)

**Files:**
- Create: `src/knowledge/server/brain-server.ts`
- Create: `src/knowledge/server/tools.ts` (the two tool handlers)
- Test: `tests/brain-server-tools.test.ts`, `tests/brain-server-roundtrip.test.ts`

**Interfaces:**
- Consumes: `runScopedOp`/`runAdminOp` (Task 2), `verifyBearer`/`protectedResourceMetadata` (Task 4).
- Produces: `buildBrainMcpServer(): McpServer` registering `brain_op`/`brain_admin_op`; `startBrainServer(cfg, {runScoped,runAdmin}?): {url, stop()}` (deps injectable for tests).

- [ ] **Step 1 (tools):** Write `tests/brain-server-tools.test.ts`: register tools with stubbed `runScoped`/`runAdmin`; call `brain_op` handler with `{op:"think",params:{q:"x"},clientId:"agent",sourceId:"agent",allowedSources:["agent"]}` → stub receives `("think",{q:"x"},{clientId,sourceId,allowedSources})` and result JSON is returned in content. `brain_admin_op` likewise.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `tools.ts` `registerBrainTools(server, deps)`.
- [ ] **Step 4:** Run → PASS. Commit `feat(brain): brain_op/brain_admin_op server tools`.
- [ ] **Step 5 (server):** Write `tests/brain-server-roundtrip.test.ts`: `startBrainServer({authDisabled:true,port:0,...}, stubDeps)` on ephemeral port; connect an MCP `Client` over `StreamableHTTPClientTransport`; `callTool brain_op` → stub result round-trips; hit `/.well-known/oauth-protected-resource` → PRM JSON; with auth enabled + no bearer → 401 + WWW-Authenticate.
- [ ] **Step 6:** Run → FAIL.
- [ ] **Step 7:** Implement `brain-server.ts`: `Bun.serve` with `webStandardStreamableHttp` transport mounted at `/mcp`; PRM route; guard via `verifyBearer` (skip for PRM + when authDisabled); default deps = real `runScopedOp`/`runAdminOp`; boot engine + `ensureSources()` only in the real entrypoint path (guard behind a `boot:true` opt so tests skip it).
- [ ] **Step 8:** Run → PASS. Typecheck. Commit `feat(brain): brain-server HTTP (Bun.serve + streamable-http + guard)`.

---

### Task 6: RemoteBackend + OAuth'd brain client

**Files:**
- Create: `src/knowledge/remote/brain-client.ts`
- Modify: `src/knowledge/backend.ts` (wire RemoteBackend)
- Test: `tests/brain-remote-backend.test.ts`

**Interfaces:**
- Consumes: server from Task 5; token source (`SLAUDE_BRAIN_TOKEN` env or store key `slaude_brain`).
- Produces: `class RemoteBackend implements BrainBackend` — `call`→`brain_op`, `adminCall`→`brain_admin_op`; lazy single-flight client init; `bearer()` resolver (env first, store second); throws clear "run `slaude brain connect`" when none.

- [ ] **Step 1:** Write `tests/brain-remote-backend.test.ts`: start a real `startBrainServer({authDisabled:true})` with stub deps; `new RemoteBackend(url)` with `SLAUDE_BRAIN_TOKEN=test`; `.call("think",{q:"x"},scope)` → stub got the op + scope, result round-trips; `.adminCall("sources_list",{}, "default")` works. Missing token + missing store entry → call rejects with auth-hint error (auth-enabled server / no bearer).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `brain-client.ts` (MCP Client + StreamableHTTPClientTransport, Authorization header from `bearer()`, JSON-decode tool result), wire into `backend.ts` remote branch.
- [ ] **Step 4:** Run `bun test` → PASS. Typecheck.
- [ ] **Step 5:** Commit `feat(brain): RemoteBackend over OAuth'd MCP client`.

---

### Task 7: CLI — brain-server + brain connect

**Files:**
- Modify: `bin/slaude.ts`
- Create: `src/cli/brain-connect.ts`

**Interfaces:**
- Consumes: `startBrainServer` + real boot (Task 5); `discover`/`beginConnectShared`/`writeEntry` (mcp-oauth); `brainRemoteUrl`.
- Produces: `slaude brain-server` (boots engine + serves), `slaude brain connect` (one-time OAuth bootstrap → store under `slaude_brain`).

- [ ] **Step 1:** Add `brain-server` case → entry `src/knowledge/server/brain-server.ts` (its `import.meta.main` block calls `startBrainServer(brainServerConfig(), undefined, {boot:true})`). Add `brain` case → `src/cli/brain-connect.ts`.
- [ ] **Step 2:** Implement `brain-connect.ts`: `discover(url)` → `beginConnectShared` → print authorize URL → `waitForCode` → `exchange` → `writeEntry(agentConfigDir(), "slaude_brain", {type:"http",url}, tokens)`; print success.
- [ ] **Step 3:** Manual smoke: `bun run typecheck`; `SLAUDE_BRAIN_AUTH_DISABLED=1 SLAUDE_BRAIN_HOME=$(mktemp -d) bun src/knowledge/server/brain-server.ts &` boots and serves PRM (curl). Kill it.
- [ ] **Step 4:** Update `slaude --help` text with the two subcommands.
- [ ] **Step 5:** Commit `feat(cli): slaude brain-server + brain connect`.

---

### Task 8: Gateway skips local bootstrap in remote mode

**Files:**
- Modify: `src/gateway/core/gateway.ts:226-237`
- Test: extend an existing gateway test or add `tests/gateway-remote-brain.test.ts`

**Interfaces:**
- Consumes: `brainMode` (Task 1).

- [ ] **Step 1:** Write test: when `SLAUDE_BRAIN_MODE=remote`, the gateway bootstrap path does not call local `ensureSources`/`scheduleNightlyMaintenance` (assert via a spy/flag) — the server owns them. In local mode, unchanged.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Guard the `if (brainEnabled())` block at gateway.ts:226 with `&& brainMode() === "local"` for the source-bootstrap + nightly cycle (keep the kb MCP wiring intact — it proxies). `brainCall`/`brainAdminCall` still work remotely for the runtime path.
- [ ] **Step 4:** Run → PASS. Typecheck.
- [ ] **Step 5:** Commit `feat(brain): gateway defers source bootstrap to brain server in remote mode`.

---

### Task 9: Docs

**Files:**
- Create: `docs/findings/2026-06-20-brain-remote-mcp.md`
- Modify: `CLAUDE.md` (Findings Log index, newest first)

- [ ] **Step 1:** Write the finding: mechanism (BrainBackend seam, dumb-engine server, OAuth resource guard with Keycloak, proxy topology, config toggle), the Keycloak client/audience setup needed, the two-process deploy contract (one writer). No internal specifics.
- [ ] **Step 2:** Add index line to `CLAUDE.md`.
- [ ] **Step 3:** Run full `bun test` + `bun run typecheck` green.
- [ ] **Step 4:** Commit `docs(brain): remote brain MCP finding + index`.

---

## Self-Review

- Spec coverage: config toggle (T1,T3), separate process + CLI (T5,T7), OAuth/Keycloak (T4,T6,T7), proxy topology (T3,T6), scope/gating unchanged (T2 verbatim move), error handling (T6 auth-hint, T5 401), gateway remote bootstrap (T8), docs (T9). ✓
- Default-unchanged guaranteed by LocalBackend verbatim move + local default in T1/T3. ✓
- Type consistency: `runScopedOp`/`runAdminOp`/`BrainBackend`/`getBackend`/`startBrainServer`/`verifyBearer`/`RemoteBackend` used consistently across tasks. ✓
