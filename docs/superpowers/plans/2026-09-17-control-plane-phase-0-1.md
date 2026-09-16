# Control Plane Phases 0 and 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two credential-path bugs, then make the runtime bundle resolve per persona so a multi-persona deployment scales horizontally without handing sessions another agent's configuration.

**Architecture:** The gateway already mints a job token carrying a `persona` claim and already serves a runtime bundle over `/v1`. Today the bundle route is keyed on tenant only, the node caches on tenant only, and the tenant itself is hardcoded. This plan carries the real tenant end to end, adds a persona segment to the bundle route, keys the node cache on the pair, and gives `buildBundle` a three-tier resolution order (database persona, then filesystem persona, then environment) so multi-persona deployments get correct bundles immediately rather than waiting for the persona tables to be populated.

**Tech Stack:** Bun, TypeScript, `bun:test`, BullMQ over Redis, sqlite and Postgres behind a `DbClient` seam.

**Spec:** `docs/superpowers/specs/2026-09-17-control-plane-and-onboarding-design.md`

## Global Constraints

- Runtime is Bun. Tests run with `bun test <path>`; the whole suite is `bun test`.
- Public repository. No real names, employers, workspace names, channel IDs or tokens in code, tests, comments or commit messages. Use placeholders such as `#team-channel`, `Jane Doe`, `U000TEST001`.
- No AI co-authorship trailers on any commit.
- One logical change per commit.
- `"default"` remains the fallback tenant and the fallback persona everywhere. No deployment may change behaviour by upgrading without configuration changes.
- The old `/v1/tenants/:id/runtime` route must keep working, so gateway and nodes can roll independently in either order.
- Approval and allowlist enforcement stay in the gateway. No task moves that boundary.
- Never weaken the existing job-token claim checks; new routes add checks rather than replacing them.

---

### Task 1: Loopback token persistence loses the persona

**Files:**
- Modify: `src/gateway/core/gateway.ts:814`
- Test: `tests/connect-mcp.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks rely on.

The loopback branch calls `persistTokens` without `personaName`, although `a.personaName` is in scope and the paste-back branch at line 794 passes it correctly. For a named persona the token lands in `oauth/<userId>`, which no session ever reads, because `resolveSessionConfigDir` always reads the persona-nested path. Connect reports success and the integration silently never works.

- [ ] **Step 1: Write the failing test**

Add to `tests/connect-mcp.test.ts`:

```ts
test("loopback connect writes the token under the persona directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "slaude-loopback-"));
  process.env.SLAUDE_HOME = home;

  await connectServer({
    sessionId: "S1",
    channelId: "C1",
    threadTs: "1.1",
    userId: "U000TEST001",
    serverName: "workbench",
    serverCfg: { url: "https://mcp.example.com/sse", headers: {} },
    scope: "initiator",
    personaName: "rina",
  });

  const nested = join(home, "oauth", "rina", "U000TEST001", ".credentials.json");
  const flat = join(home, "oauth", "U000TEST001", ".credentials.json");
  expect(existsSync(nested)).toBe(true);
  expect(existsSync(flat)).toBe(false);
});
```

The existing file already builds a `connectServer` with an injected `oauthConnect` stub, which forces loopback semantics. Reuse that harness rather than adding a new one; read the top of the file and follow its setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/connect-mcp.test.ts -t "under the persona directory"`
Expected: FAIL. The nested path does not exist and the flat path does.

- [ ] **Step 3: Write minimal implementation**

In `src/gateway/core/gateway.ts`, the loopback branch:

```ts
await persistTokens({ sessionId: a.sessionId, userId: a.userId, serverName: a.serverName, serverConfig, scope: a.scope, personaName: a.personaName }, tokens);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/connect-mcp.test.ts`
Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/gateway.ts tests/connect-mcp.test.ts
git commit -m "fix(mcp): persist loopback tokens under the session's persona

The loopback connect branch dropped personaName, so for a named persona the
token was written to oauth/<userId> while every session reads
oauth/<persona>/<userId>. Connect reported success and the integration never
worked. The paste-back branch already passed it."
```

---

### Task 2: Disconnect looks in the wrong directory

**Files:**
- Modify: `src/gateway/core/gateway.ts:1510`
- Test: `tests/connect-mcp.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks rely on.

Disconnect calls `ensureInitiatorConfigDir(userId)` with no persona while connect passes one. For a named persona, disconnect finds nothing, reports that the server was not connected, and leaves a working token in place. This is a false revocation: the person believes access is gone and it is not.

- [ ] **Step 1: Write the failing test**

```ts
test("disconnect removes the token stored under a named persona", () => {
  const home = mkdtempSync(join(tmpdir(), "slaude-disconnect-"));
  process.env.SLAUDE_HOME = home;
  const cfg = { type: "http" as const, url: "https://mcp.example.com/sse", headers: {} };
  const dir = ensureInitiatorConfigDir("U000TEST001", "rina");
  writeEntry(dir, "workbench", cfg, { accessToken: "at", expiresIn: 3600 });

  const removed = removeEntry(ensureInitiatorConfigDir("U000TEST001", "rina"), "workbench", cfg);

  expect(removed).toBe(true);
  expect(readEntry(dir, "workbench", cfg)).toBeUndefined();
});
```

This test pins the storage contract. It passes already. The behaviour that is broken lives in the slash-command branch, so also assert the resolution directly:

```ts
test("initiator config dir for a named persona is persona-nested", () => {
  const home = mkdtempSync(join(tmpdir(), "slaude-dir-"));
  process.env.SLAUDE_HOME = home;
  expect(initiatorConfigDir("U000TEST001", "rina")).toBe(join(home, "oauth", "rina", "U000TEST001"));
  expect(initiatorConfigDir("U000TEST001")).toBe(join(home, "oauth", "U000TEST001"));
});
```

Then extract the directory choice out of the slash handler so it is testable. Add to `src/gateway/core/gateway.ts` near the other helpers:

```ts
/** Config home a /mcp scope acts on. Global = the agent's shared identity;
 *  initiator = that user's home, nested under the persona when one is named. */
export function mcpScopeConfigDir(
  scope: "global" | "initiator",
  userId: string,
  personaName?: string,
): string {
  return scope === "global" ? agentConfigDir() : ensureInitiatorConfigDir(userId, personaName);
}
```

And the failing test:

```ts
test("mcp disconnect scope resolves to the persona-nested home", () => {
  const home = mkdtempSync(join(tmpdir(), "slaude-scope-"));
  process.env.SLAUDE_HOME = home;
  expect(mcpScopeConfigDir("initiator", "U000TEST001", "rina"))
    .toBe(join(home, "oauth", "rina", "U000TEST001"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/connect-mcp.test.ts -t "scope resolves"`
Expected: FAIL with `mcpScopeConfigDir is not exported` or `is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the helper above, then change the disconnect branch to use it with the persona the connect branch already computes:

```ts
const personaName = dispatch?.personaId && dispatch.personaId !== "default" ? dispatch.personaId : undefined;
const configDir = mcpScopeConfigDir(scope, userId, personaName);
```

Use the same helper in the connect branch's `mcpScopeConfigDir` call sites only where it does not change behaviour; do not refactor `connectServer`'s own signature in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/connect-mcp.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/gateway.ts tests/connect-mcp.test.ts
git commit -m "fix(mcp): disconnect the credential the session actually uses

/mcp disconnect resolved the initiator config home without the persona, so for
a named persona it searched oauth/<userId>, found nothing, and reported the
server was not connected while a working token remained at
oauth/<persona>/<userId>. The person believed access was revoked and it was
not. Scope resolution now goes through one helper both branches share."
```

---

### Task 3: Credential writes must survive a symlinked target

**Files:**
- Modify: `src/agent/mcp-oauth/store.ts`
- Test: `tests/mcp-oauth/store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `writeEntry` and `removeEntry` keep their existing signatures and become symlink-safe. Phase 3 of the spec depends on this.

Both writers rename a temp file over the target. A rename replaces a symlink with a regular file, which silently breaks any sharing built on top of it. Fix this before anything relies on it.

- [ ] **Step 1: Write the failing test**

```ts
test("writeEntry writes through a symlink instead of replacing it", () => {
  const root = mkdtempSync(join(tmpdir(), "slaude-symlink-"));
  const canonical = join(root, "canonical");
  const configDir = join(root, "config");
  mkdirSync(canonical, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const target = join(canonical, ".credentials.json");
  writeFileSync(target, JSON.stringify({ mcpOAuth: {} }), { mode: 0o600 });
  symlinkSync(target, join(configDir, ".credentials.json"));

  const cfg = { type: "http" as const, url: "https://mcp.example.com/sse", headers: {} };
  writeEntry(configDir, "workbench", cfg, { accessToken: "at", expiresIn: 3600 });

  expect(lstatSync(join(configDir, ".credentials.json")).isSymbolicLink()).toBe(true);
  const written = JSON.parse(readFileSync(target, "utf8"));
  expect(Object.keys(written.mcpOAuth)).toHaveLength(1);
});

test("removeEntry writes through a symlink instead of replacing it", () => {
  const root = mkdtempSync(join(tmpdir(), "slaude-symlink-rm-"));
  const canonical = join(root, "canonical");
  const configDir = join(root, "config");
  mkdirSync(canonical, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const target = join(canonical, ".credentials.json");
  writeFileSync(target, JSON.stringify({ mcpOAuth: {} }), { mode: 0o600 });
  symlinkSync(target, join(configDir, ".credentials.json"));
  const cfg = { type: "http" as const, url: "https://mcp.example.com/sse", headers: {} };
  writeEntry(configDir, "workbench", cfg, { accessToken: "at", expiresIn: 3600 });

  expect(removeEntry(configDir, "workbench", cfg)).toBe(true);

  expect(lstatSync(join(configDir, ".credentials.json")).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(target, "utf8")).mcpOAuth).toEqual({});
});
```

Create `tests/mcp-oauth/store.test.ts` if the directory has no store test yet; check `tests/mcp-oauth/` first and extend the existing file if one is there.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp-oauth/store.test.ts -t "symlink"`
Expected: FAIL. `isSymbolicLink()` returns false because the rename replaced the link.

- [ ] **Step 3: Write minimal implementation**

Add one helper to `src/agent/mcp-oauth/store.ts` and use it in both writers. Import `realpathSync` and `lstatSync` from `node:fs`.

```ts
/** Resolve the credential file to its real location so an atomic rename lands
 *  on the target rather than replacing a symlink with a regular file. The temp
 *  file must be created in the SAME directory as the resolved target, because
 *  rename is only atomic within one filesystem. */
function resolveCredentialTarget(configDir: string): { path: string; dir: string } {
  const path = join(configDir, ".credentials.json");
  try {
    if (lstatSync(path).isSymbolicLink()) {
      const real = realpathSync(path);
      return { path: real, dir: dirname(real) };
    }
  } catch {
    /* missing file or broken link — write in place */
  }
  return { path, dir: configDir };
}
```

In `writeEntry`, replace the path computation and the temp write:

```ts
const { path, dir } = resolveCredentialTarget(configDir);
```

and

```ts
const tmp = join(dir, `.credentials.json.tmp-${randomBytes(6).toString("hex")}`);
```

Make the identical change in `removeEntry`. `readEntry` needs no change, because reading follows a symlink already.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp-oauth/`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-oauth/store.ts tests/mcp-oauth/store.test.ts
git commit -m "fix(mcp-oauth): write credentials through a symlinked target

Both writers renamed a temp file over the credential path, which replaces a
symlink with a regular file. Resolve the link first and place the temp file
beside the real target so the rename stays atomic and the link survives."
```

---

### Task 4: Carry the real tenant end to end

**Files:**
- Modify: `src/gateway/core/dispatch.ts:28-36` (`DispatchMeta`), `:205`, `:223`
- Modify: `src/gateway/core/gateway.ts:2421` (the one existing `DispatchMeta` literal)
- Test: `tests/gateway/core/dispatch-tenant.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DispatchMeta` gains `tenantId?: string`. Task 5 relies on the job token's `tenant` claim being the real tenant rather than the literal `"default"`.

`slack_apps.tenant_id` is stored and never read on the execution path. Resolve it at dispatch, carry it into the job payload and the token, and default to `"default"`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/core/dispatch-tenant.test.ts`:

```ts
import { test, expect } from "bun:test";
import { verifyJobToken } from "../../../src/gateway/api/auth";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";

test("dispatch carries the meta tenant into the job and its token", async () => {
  process.env.SLAUDE_JOB_SECRET = "test-secret";
  const enqueued: any[] = [];
  const dispatch = makeQueueDispatch({
    infra: {
      turns: { enqueueTurn: async (job: any) => { enqueued.push(job); return { queue: "turns", jobId: "J1", coalesced: false }; } } as any,
      registry: { lookup: async () => null } as any,
      pubsub: { consumeAbortFlag: async () => null, appendEvent: async () => {}, readEvents: async () => [] } as any,
    },
  });

  await dispatch.dispatch({ id: "S1" } as any, "hello", {
    tenantId: "tenant-one",
    teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U000TEST001",
  });

  expect(enqueued[0].tenantId).toBe("tenant-one");
  const verified = verifyJobToken(enqueued[0].jobToken);
  expect(verified.ok).toBe(true);
  expect(verified.ok && verified.claims.tenant).toBe("tenant-one");
  await dispatch.close();
});

test("dispatch falls back to the default tenant when meta omits one", async () => {
  process.env.SLAUDE_JOB_SECRET = "test-secret";
  const enqueued: any[] = [];
  const dispatch = makeQueueDispatch({
    infra: {
      turns: { enqueueTurn: async (job: any) => { enqueued.push(job); return { queue: "turns", jobId: "J1", coalesced: false }; } } as any,
      registry: { lookup: async () => null } as any,
      pubsub: { consumeAbortFlag: async () => null, appendEvent: async () => {}, readEvents: async () => [] } as any,
    },
  });

  await dispatch.dispatch({ id: "S1" } as any, "hello", {
    teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U000TEST001",
  });

  expect(enqueued[0].tenantId).toBe("default");
  await dispatch.close();
});
```

Read the top of `src/gateway/core/dispatch.ts` for the exported factory's real name and the exact `infra` seam shape before writing the test, and match them. The factory is exported from that module; the `infra` option is documented on `QueueDispatchOpts` as the injected-infra test seam.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/core/dispatch-tenant.test.ts`
Expected: FAIL. The first test sees `tenantId` of `"default"` and a token claim of `"default"` instead of `"tenant-one"`.

- [ ] **Step 3: Write minimal implementation**

In `src/gateway/core/dispatch.ts`, add to `DispatchMeta`:

```ts
  /** Tenant that owns this conversation. Resolved from slack_apps at the
   *  transport layer; 'default' for single-tenant deployments. */
  tenantId?: string;
```

In `dispatch()`, beside the existing `personaId` line:

```ts
const tenantId = meta.tenantId ?? "default";
```

Use `tenantId` in both `mintJobToken({ tenant: tenantId, ... })` and the enqueued job's `tenantId` field.

Then populate it at the transport layer. In `src/gateway/slack/http-transport.ts`, the resolved `slack_apps` row is already in hand where the dispatch meta is built; pass `tenantId: app.tenant_id ?? "default"`. Update the `DispatchMeta` literal at `src/gateway/core/gateway.ts:2421` to thread the session's tenant through as well, reading `session.tenant_id` where the row is available and falling back to `"default"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gateway/core/dispatch-tenant.test.ts && bun test tests/queue tests/node`
Expected: PASS for the new file, and no regression in the queue or node suites.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/dispatch.ts src/gateway/slack/http-transport.ts src/gateway/core/gateway.ts tests/gateway/core/dispatch-tenant.test.ts
git commit -m "feat(gateway): carry the real tenant into turn jobs and job tokens

slack_apps.tenant_id was stored and never read on the execution path: dispatch
hardcoded 'default' in both the job payload and the token claim, so the tenancy
schema was inert. Resolve the tenant at the transport layer and thread it
through DispatchMeta. 'default' stays the fallback."
```

---

### Task 5: Resolve the runtime bundle per persona

**Files:**
- Modify: `src/gateway/api/tenants.ts`
- Modify: `src/gateway/api/index.ts:67-75`
- Modify: `src/node/client.ts:77`, `:143-160`
- Modify: `src/node/worker.ts:161-172`
- Test: `tests/gateway/api/runtime-persona.test.ts` (create), `tests/node/client.test.ts`

**Interfaces:**
- Consumes: the job token's `tenant` claim from Task 4.
- Produces:
  - `buildBundle(tenantId: string, personaId: string): Promise<RuntimeBundle | null>`
  - `handleTenantRuntime(req: Request, tenantId: string, personaId: string): Promise<Response>`
  - `NodeClient.getRuntime(tenantId: string, personaId: string, jobToken: string): Promise<RuntimeBundle>`
  - `NodeClient.bustRuntime(tenantId: string, personaId?: string): void` — omitting the persona drops every entry for that tenant, which is what the reload subscription needs.

This is the horizontal-scale fix. Two personas in one tenant currently share a cache entry, so whichever persona is fetched first serves every session on that node.

Resolution order becomes: the named persona row in the database, then the filesystem persona of that name, then the environment fallback. The middle tier is what makes this real today, because nothing populates the persona tables yet.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/api/runtime-persona.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mintJobToken } from "../../../src/gateway/api/auth";
import { makeV1Router } from "../../../src/gateway/api/index";

const token = (persona: string) => mintJobToken({
  tenant: "default", persona, session: "S1", team: "T1",
  channel: "C1", thread: "1.1", initiator: "U000TEST001", scope: "turn",
});

test("the bundle route is scoped to the persona in the job token", async () => {
  process.env.SLAUDE_JOB_SECRET = "test-secret";
  process.env.SLAUDE_NODE_TOKEN = "node-token";
  const router = makeV1Router({});
  const res = await router(new Request("http://x/v1/tenants/default/personas/rina/runtime", {
    headers: { authorization: "Bearer node-token", "x-slaude-job": token("rina") },
  }));
  expect(res.status).toBe(200);
  expect((await res.json()).personaId).toBe("rina");
});

test("a job token for one persona cannot fetch another persona's bundle", async () => {
  process.env.SLAUDE_JOB_SECRET = "test-secret";
  process.env.SLAUDE_NODE_TOKEN = "node-token";
  const router = makeV1Router({});
  const res = await router(new Request("http://x/v1/tenants/default/personas/other/runtime", {
    headers: { authorization: "Bearer node-token", "x-slaude-job": token("rina") },
  }));
  expect(res.status).toBe(403);
});

test("the legacy tenant route still resolves the default persona", async () => {
  process.env.SLAUDE_JOB_SECRET = "test-secret";
  process.env.SLAUDE_NODE_TOKEN = "node-token";
  const router = makeV1Router({});
  const res = await router(new Request("http://x/v1/tenants/default/runtime", {
    headers: { authorization: "Bearer node-token", "x-slaude-job": token("default") },
  }));
  expect(res.status).toBe(200);
  expect((await res.json()).personaId).toBe("default");
});
```

Read `src/gateway/api/index.ts` for the router factory's real exported name and options shape, and match them.

Add to `tests/node/client.test.ts`:

```ts
test("the runtime cache is keyed on tenant and persona together", async () => {
  const seen: string[] = [];
  const client = new NodeClient({
    baseUrl: "http://gw", token: "node-token",
    fetchImpl: async (url: any) => {
      seen.push(String(url));
      const persona = String(url).split("/personas/")[1]!.split("/")[0]!;
      return new Response(JSON.stringify({ tenantId: "default", personaId: persona, providerCreds: {} }),
        { status: 200, headers: { "content-type": "application/json", etag: `"${persona}"` } });
    },
  });

  const a = await client.getRuntime("default", "rina", "jt");
  const b = await client.getRuntime("default", "other", "jt");

  expect(a.personaId).toBe("rina");
  expect(b.personaId).toBe("other");
  expect(seen).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/api/runtime-persona.test.ts tests/node/client.test.ts`
Expected: FAIL. The persona route 404s, and `getRuntime` rejects the extra argument or returns the first persona for both calls.

- [ ] **Step 3: Write minimal implementation**

In `src/gateway/api/tenants.ts`, give `buildBundle` a persona parameter and a three-tier resolution.

```ts
async function buildBundle(tenantId: string, personaId: string): Promise<RuntimeBundle | null> {
  let tenant: { id: string } | null = null;
  let personas: PersonaRow[] = [];
  try {
    tenant = await db.one<{ id: string }>(`SELECT id FROM tenants WHERE id = ?`, [tenantId]);
    personas = await db.query<PersonaRow>(
      `SELECT * FROM personas WHERE tenant_id = ? AND name = ?`,
      [tenantId, personaId],
    );
  } catch {
    /* sqlite: no tenancy tables */
  }
  if (!tenant && tenantId !== "default") return null;
  const persona = personas[0];
  // ... existing persona branch unchanged, but it now returns the REQUESTED
  // persona rather than whichever sorted first.
```

Replace the `LIMIT 1` ordering query entirely. Selecting by name is the fix; there is no longer a "first persona" concept.

Then add the filesystem tier before the environment fallback, so a named persona that exists on disk but not in the database still gets its own soul and skills overlay:

```ts
  if (personaId !== "default") {
    const fsPersona = getPersonaRegistry().lookupByName(personaId);
    if (fsPersona) {
      let soulMd = "";
      try { soulMd = readFileSync(fsPersona.soulPath, "utf8"); } catch { /* no soul on disk */ }
      return {
        tenantId,
        personaId,
        providerCreds: envProviderCreds(),
        soulMd,
        soulJson: null,
        mcpJson: loadExternalMcp(),
        skillsPaths: [paths.skills, personaSkillsRoot(personaId)],
        defaultModel: env.model(),
      };
    }
    return null;
  }
```

Extract the existing environment credential block into `envProviderCreds()` so both the filesystem tier and the default fallback use it, rather than duplicating it.

Change the handler signature:

```ts
export async function handleTenantRuntime(req: Request, tenantId: string, personaId: string): Promise<Response> {
  const bundle = await buildBundle(tenantId, personaId);
  if (!bundle) return notFound("unknown tenant or persona");
  // ... unchanged ETag logic
```

In `src/gateway/api/index.ts`, keep the existing four-segment route and add the six-segment one:

```ts
      // /v1/tenants/:id/runtime — legacy alias, resolves the default persona.
      if (seg.length === 4 && seg[1] === "tenants" && seg[3] === "runtime") {
        if (req.method !== "GET") return methodNotAllowed();
        const job = requireJobToken(req);
        if ("response" in job) return job.response;
        if (job.claims.tenant !== seg[2]!) {
          return json(403, { error: "job token is not scoped to this tenant" });
        }
        return await handleTenantRuntime(req, seg[2]!, "default");
      }

      // /v1/tenants/:id/personas/:persona/runtime
      if (seg.length === 6 && seg[1] === "tenants" && seg[3] === "personas" && seg[5] === "runtime") {
        if (req.method !== "GET") return methodNotAllowed();
        const job = requireJobToken(req);
        if ("response" in job) return job.response;
        if (job.claims.tenant !== seg[2]!) {
          return json(403, { error: "job token is not scoped to this tenant" });
        }
        if (job.claims.persona !== seg[4]!) {
          return json(403, { error: "job token is not scoped to this persona" });
        }
        return await handleTenantRuntime(req, seg[2]!, seg[4]!);
      }
```

In `src/node/client.ts`, key the cache on the pair:

```ts
  /** `${tenantId} ${personaId}` → cached runtime bundle + its ETag. */
  #runtimeCache = new Map<string, { etag: string; bundle: RuntimeBundle }>();

  async getRuntime(tenantId: string, personaId: string, jobToken: string): Promise<RuntimeBundle> {
    const key = `${tenantId} ${personaId}`;
    const cached = this.#runtimeCache.get(key);
    const res = await this.request(`/v1/tenants/${tenantId}/personas/${personaId}/runtime`, {
      jobToken,
      headers: cached ? { "if-none-match": cached.etag } : {},
    });
    if (res.status === 304 && cached) return cached.bundle;
    const bundle = await this.#json<RuntimeBundle>(res);
    const etag = res.headers.get("etag");
    if (etag) this.#runtimeCache.set(key, { etag, bundle });
    return bundle;
  }

  bustRuntime(tenantId: string, personaId?: string): void {
    if (personaId !== undefined) {
      this.#runtimeCache.delete(`${tenantId} ${personaId}`);
      return;
    }
    for (const key of this.#runtimeCache.keys()) {
      if (key.startsWith(`${tenantId} `)) this.#runtimeCache.delete(key);
    }
  }
```

The null byte is the separator because it cannot appear in a tenant or persona identifier, so no pair of identifiers can collide on one key.

In `src/node/worker.ts`, the child-env resolver must pass the persona. The worker already tracks the tenant per session in a `tenants` map; add a parallel `personas` map populated from `data.personaId` wherever `tenants` is populated from `data.tenantId`, then:

```ts
    const bundle = await client.getRuntime(tenant, personas.get(sessionId) ?? "default", token);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gateway/api tests/node`
Expected: PASS, including every pre-existing test in both directories.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/api/tenants.ts src/gateway/api/index.ts src/node/client.ts src/node/worker.ts tests/gateway/api/runtime-persona.test.ts tests/node/client.test.ts
git commit -m "feat(runtime): resolve the runtime bundle per persona

buildBundle took the first persona of a tenant by name order and NodeClient
cached on tenant alone, so with more than one persona in a tenant every session
on a node received the first persona's bundle. Select the requested persona,
validate it against the job token's persona claim, and key the node cache on
the pair. Adds a filesystem tier between the database and the environment
fallback so multi-persona deployments are correct before the persona tables are
populated. The legacy route stays as a default-persona alias so gateway and
nodes can roll independently."
```

---

### Task 6: Make config reload reach every replica

**Files:**
- Modify: `src/node/worker.ts:184-196` (`ensureReloadSub`)
- Modify: `src/persona/registry.ts:76-88`
- Create: `src/gateway/core/config-reload.ts`
- Test: `tests/queue/reload-fanout.test.ts` (create)

**Interfaces:**
- Consumes: `NodeClient.bustRuntime(tenantId, personaId?)` from Task 5.
- Produces: `publishConfigReload(tenantId: string): Promise<void>` and `invalidatePersonaRegistry(): void`.

`publishReload` has no caller in `src/`; only tests call it. The subscriber is live. Wire it, and give the gateway's own persona map an invalidation hook so adding an agent stops requiring a restart of the gateway and every node.

- [ ] **Step 1: Write the failing test**

Create `tests/queue/reload-fanout.test.ts`:

```ts
import { test, expect } from "bun:test";
import { invalidatePersonaRegistry, getPersonaRegistry, setPersonaRegistry } from "../../src/persona/registry";

test("invalidating the persona registry forces a rebuild on next access", () => {
  const stub = { lookupByUserId: () => null, lookupByName: () => null, list: () => [], isMultiPersonaMode: () => false };
  setPersonaRegistry(stub as any);
  expect(getPersonaRegistry()).toBe(stub as any);

  invalidatePersonaRegistry();

  expect(getPersonaRegistry()).not.toBe(stub as any);
});

test("bustRuntime without a persona drops every persona of that tenant", async () => {
  const { NodeClient } = await import("../../src/node/client");
  let calls = 0;
  const client = new NodeClient({
    baseUrl: "http://gw", token: "t",
    fetchImpl: async (url: any) => {
      calls++;
      const persona = String(url).split("/personas/")[1]!.split("/")[0]!;
      return new Response(JSON.stringify({ tenantId: "default", personaId: persona, providerCreds: {} }),
        { status: 200, headers: { "content-type": "application/json", etag: `"v${calls}"` } });
    },
  });
  await client.getRuntime("default", "rina", "jt");
  await client.getRuntime("default", "other", "jt");
  const before = calls;

  client.bustRuntime("default");
  await client.getRuntime("default", "rina", "jt");
  await client.getRuntime("default", "other", "jt");

  expect(calls).toBe(before + 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/queue/reload-fanout.test.ts`
Expected: FAIL with `invalidatePersonaRegistry is not exported`.

- [ ] **Step 3: Write minimal implementation**

In `src/persona/registry.ts`:

```ts
/** Drop the memoized registry so the next access rebuilds it from disk. Called
 *  on a config-reload signal so adding a persona does not require a restart. */
export function invalidatePersonaRegistry(): void {
  registry = null;
}
```

Create `src/gateway/core/config-reload.ts`:

```ts
/**
 * One place that announces a configuration change. Nodes drop their runtime
 * bundle cache for the tenant; this gateway replica drops its persona map.
 * Other gateway replicas pick the change up through their own subscription.
 */
import { invalidatePersonaRegistry } from "../../persona/registry";
import type { PubSub } from "../../queue/pubsub";

export async function publishConfigReload(pubsub: PubSub, tenantId: string): Promise<void> {
  invalidatePersonaRegistry();
  try {
    await pubsub.publishReload(tenantId);
  } catch (e) {
    // A failed announcement must not fail the config write that triggered it:
    // ETag revalidation still converges every node on the next fetch.
    console.error(`[config-reload] publish failed tenant=${tenantId}:`, e);
  }
}
```

In `src/node/worker.ts`, the subscription already calls `client.bustRuntime(tenantId)`, which now clears every persona of that tenant given Task 5's signature. Leave the call as it is and update its comment to say so.

Call `publishConfigReload` from the persona import command once Task 5's plan successor adds one. Until then, wire it to the existing soul-override write path in `src/soul/overrides.ts`, which is the one config write that exists today, so the mechanism ships with a real caller rather than as another dangling subscriber.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/queue tests/node`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persona/registry.ts src/gateway/core/config-reload.ts src/node/worker.ts tests/queue/reload-fanout.test.ts
git commit -m "feat(config): announce config changes to every replica

publishReload had a live subscriber and no publisher, so a config change
reached other processes only when an ETag revalidation happened to run. Add one
announcement point that drops this replica's persona map and publishes to the
tenant channel, and let the node's existing subscription clear every persona of
that tenant."
```

---

### Task 7: Horizontal scale acceptance test

**Files:**
- Test: `tests/integration/multi-persona-scale.test.ts` (create)

**Interfaces:**
- Consumes: everything above.
- Produces: the executable form of the spec's section 8 criteria.

The spec lists horizontal scale requirements as acceptance criteria. This task turns the ones that are testable without a live cluster into one test file.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { NodeClient } from "../../src/node/client";

function fakeGateway() {
  const served: Array<{ tenant: string; persona: string }> = [];
  const fetchImpl = async (url: any, init?: any) => {
    const m = String(url).match(/\/v1\/tenants\/([^/]+)\/personas\/([^/]+)\/runtime/);
    if (!m) return new Response("not found", { status: 404 });
    const [, tenant, persona] = m as unknown as [string, string, string];
    served.push({ tenant, persona });
    const etag = `"${tenant}:${persona}"`;
    if (init?.headers?.["if-none-match"] === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(
      JSON.stringify({ tenantId: tenant, personaId: persona, providerCreds: { apiKey: `key-${persona}` } }),
      { status: 200, headers: { "content-type": "application/json", etag } },
    );
  };
  return { served, fetchImpl };
}

test("two personas on one node each receive their own credentials", async () => {
  const gw = fakeGateway();
  const node = new NodeClient({ baseUrl: "http://gw", token: "t", fetchImpl: gw.fetchImpl as any });

  const rina = await node.getRuntime("default", "rina", "jt");
  const other = await node.getRuntime("default", "other", "jt");

  expect(rina.providerCreds.apiKey).toBe("key-rina");
  expect(other.providerCreds.apiKey).toBe("key-other");
});

test("two nodes resolve the same persona identically", async () => {
  const gw = fakeGateway();
  const a = new NodeClient({ baseUrl: "http://gw", token: "t", fetchImpl: gw.fetchImpl as any });
  const b = new NodeClient({ baseUrl: "http://gw", token: "t", fetchImpl: gw.fetchImpl as any });

  expect((await a.getRuntime("default", "rina", "jt")).providerCreds.apiKey)
    .toBe((await b.getRuntime("default", "rina", "jt")).providerCreds.apiKey);
});

test("a cached bundle revalidates rather than going stale", async () => {
  const gw = fakeGateway();
  const node = new NodeClient({ baseUrl: "http://gw", token: "t", fetchImpl: gw.fetchImpl as any });

  await node.getRuntime("default", "rina", "jt");
  await node.getRuntime("default", "rina", "jt");

  expect(gw.served).toHaveLength(2);
});

test("separate tenants never share a cache entry", async () => {
  const gw = fakeGateway();
  const node = new NodeClient({ baseUrl: "http://gw", token: "t", fetchImpl: gw.fetchImpl as any });

  const one = await node.getRuntime("tenant-one", "rina", "jt");
  const two = await node.getRuntime("tenant-two", "rina", "jt");

  expect(one.tenantId).toBe("tenant-one");
  expect(two.tenantId).toBe("tenant-two");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/multi-persona-scale.test.ts`
Expected: FAIL before Tasks 5 and 6 land; PASS after.

- [ ] **Step 3: Write minimal implementation**

No implementation. If any assertion fails, the defect is in Task 5 or Task 6 and belongs there.

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS. Record the failing output verbatim if not, and fix before committing.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/multi-persona-scale.test.ts
git commit -m "test(scale): pin the multi-persona horizontal scale criteria

Executable form of the design's acceptance criteria: per-persona credential
isolation on one node, identical resolution across nodes, ETag revalidation
rather than stale cache, and no cross-tenant cache sharing."
```

---

### Task 8: Documentation and version footer

**Files:**
- Modify: `README.md:79`
- Create: `docs/site/_content/field-notes/2026-09-17-control-plane-per-persona-runtime.md`
- Modify: `CLAUDE.md` (Findings Log index, newest first)

**Interfaces:**
- Consumes: the outcome of every task above.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the field note**

Cover the mechanism, not any deployment specifics: the two credential-path bugs and why they were mutually exclusive by deployment mode, the writer boundary that decides what lives on the volume, why the bundle cache key was the horizontal scale defect, and why credentials cannot move into the database. Link the spec.

- [ ] **Step 2: Index it in CLAUDE.md**

Add one line at the top of the Findings Log list, matching the existing format.

- [ ] **Step 3: Fix the stale version footer**

`README.md:79` reads `slaude v0.41.0` while `package.json` is `0.44.0`.

- [ ] **Step 4: Verify**

Run: `bun test && git diff --cached -U0 | grep -nIiE 'acme|\.slack\.com|\b[CUTGW]0[A-Z0-9]{8,}\b|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|vault' || echo clean`
Expected: tests PASS and the leak scan prints `clean`.

Note: keep test fixture names generic (`tenant-one`, `U000TEST001`); never use a real organisation name, or the leak scan will trip.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/site/_content/field-notes/2026-09-17-control-plane-per-persona-runtime.md CLAUDE.md
git commit -m "docs: field note on the per-persona runtime bundle and credential paths"
```

---

## Out of scope for this plan

These come from the same spec and get their own plans:

- Database as the source of truth for personas, with the import command that seeds from existing folders. Large enough to stand alone, and Task 5's filesystem tier makes it non-urgent.
- Moving soul and skills out of the shared volume and into the bundle, so nodes stop reading persona directories.
- Phase 2 identity: account records, single sign-on for ordinary users, the signed-link Slack binding.
- Phase 3 per-user credential store. Task 3 is its prerequisite and is included here because it is a correctness fix on its own.
- Phase 4 portal onboarding and the 1:1 entry check.
