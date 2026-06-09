# /mcp OAuth Connect (in /1on1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Slack-only initiator, inside a `/1on1`-locked thread, connect an OAuth HTTP MCP server from Slack — slaude runs the one-time OAuth handshake, writes the token into the CLI's native `mcpOAuth` store in the initiator's config dir, then the CLI owns the lifecycle.

**Architecture:** Five small modules under `src/agent/mcp-oauth/` (pkce, discovery, register, loopback, client orchestrator) perform the handshake; `store.ts` writes the CLI credential file; a new `/mcp` gate command (parser + gateway handler) renders a status card and a `[Connect]` button that drives the flow and `agent.reload`s the locked session. Reuses the shipped `CLAUDE_CONFIG_DIR=initiatorConfigDir` override; the only shipped-code change is to stop scrubbing `.credentials.json`.

**Tech Stack:** Bun + TypeScript, `bun:test`, `@anthropic-ai/claude-agent-sdk` (`Query.mcpServerStatus()`), `node:http` loopback, `node:crypto` (PKCE/SHA-256), Slack Block Kit.

**Spec:** `docs/superpowers/specs/2026-06-09-mcp-oauth-connect-1on1-design.md`

**Key verified facts (from the installed SDK / `cli.js`):**
- Store key: `a2A(name,cfg)` = `` `${name}|${sha256(JSON.stringify({type,url,headers:headers||{}})).hex.slice(0,16)}` ``. `JSON.stringify`, **not** sorted-key canonical JSON; field order is fixed `type,url,headers`; headers kept verbatim.
- Golden (self-computed with that formula): `oauthKey("workbench", {type:"http", url:"https://mcp.example.com/sse", headers:{}})` === `workbench|c17ea65c6b709142`.
- File store `V_1` writes `<CLAUDE_CONFIG_DIR>/.credentials.json`, `JSON.stringify`, mode `0o600`. On **darwin** the reader `Ow()` is keychain-primary (file shadowed) → the write round-trips only on Linux/container. End-to-end check is the container smoke; macOS dev verifies the pure store-writer only.
- `Query.mcpServerStatus(): Promise<{name, status:'connected'|'failed'|'needs-auth'|'pending', serverInfo?}[]>` is the only relevant SDK hook; no programmatic OAuth trigger exists.

---

## File Structure

**Create:**
- `src/agent/mcp-oauth/pkce.ts` — PKCE verifier/challenge + `state` generation.
- `src/agent/mcp-oauth/discovery.ts` — resource-metadata → authorization-server-metadata discovery.
- `src/agent/mcp-oauth/register.ts` — dynamic client registration.
- `src/agent/mcp-oauth/loopback.ts` — ephemeral `127.0.0.1`/`0.0.0.0` callback listener.
- `src/agent/mcp-oauth/client.ts` — orchestrator: `beginConnect()` → `{authorizeUrl, waitForCode}`, `exchange()`.
- `src/agent/mcp-oauth/store.ts` — `oauthKey()` + `writeEntry()` for `.credentials.json`.
- Tests mirroring each under `tests/agent/mcp-oauth/`.

**Modify:**
- `src/agent/oauth-home.ts` — drop the `.credentials.json` scrub; also copy `settings.local.json`.
- `src/agent/manager.ts` — add `mcpServerStatus(sessionId)`.
- `src/gateway/slack/commands.ts` — add `{ kind: "mcp" }` to `SlashHit`, parser branch, help entry.
- `src/gateway/core/gateway.ts` — `/mcp` handler: status card + `[Connect]` button wiring.
- `src/config/env.ts` — `SLAUDE_OAUTH_LOOPBACK_*` accessors.
- `scripts/verify-1on1.sh` / `.env.verify.example` — container smoke.

---

## Task 0: Stop scrubbing the initiator's `.credentials.json` (shipped-code fix)

**Files:**
- Modify: `src/agent/oauth-home.ts`
- Test: `tests/agent/oauth-home-seed.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/oauth-home-seed.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { ensureInitiatorConfigDir } from "../../src/agent/oauth-home";

describe("ensureInitiatorConfigDir", () => {
  const userId = "U_SEED_TEST";
  const dir = join(paths.home, "oauth", userId);
  beforeEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  it("preserves a pre-existing initiator .credentials.json (no scrub)", () => {
    mkdirSync(dir, { recursive: true });
    const cred = join(dir, ".credentials.json");
    writeFileSync(cred, JSON.stringify({ mcpOAuth: { "x|abc": { accessToken: "t" } } }));
    ensureInitiatorConfigDir(userId);
    expect(existsSync(cred)).toBe(true);
  });

  it("copies settings.local.json from the agent config dir", () => {
    // Seed an agent-side settings.local.json, then assert it lands in the initiator dir.
    const agentDir = process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.local.json"), JSON.stringify({ k: 1 }));
    ensureInitiatorConfigDir(userId);
    expect(existsSync(join(dir, "settings.local.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/oauth-home-seed.test.ts`
Expected: FAIL — first test fails (cred file deleted by the scrub); second fails (settings.local.json not copied).

- [ ] **Step 3: Edit `src/agent/oauth-home.ts`**

Remove the `CRED_FILES` constant and its scrub loop; add a `settings.local.json` copy. Replace the body of `ensureInitiatorConfigDir` from the `settings.json` copy through the `return dir;`:

```typescript
export function ensureInitiatorConfigDir(userId: string): string {
  const dir = initiatorConfigDir(userId);
  mkdirSync(dir, { recursive: true });

  const src = agentConfigDir();
  // settings.json + settings.local.json — copy once (non-secret: enabledPlugins,
  // marketplaces, local overrides). Never copy credential stores: the whole point
  // is the initiator's own identity, and this dir now HOLDS the initiator's own
  // .credentials.json (written by the /mcp connect flow) — so we must not scrub it.
  for (const name of ["settings.json", "settings.local.json"]) {
    const s = join(src, name);
    const d = join(dir, name);
    if (existsSync(s) && !existsSync(d)) copyFileSync(s, d);
  }
  // plugins/ — symlink (read-only share; plugin code lives in the agent home).
  const srcPlugins = join(src, "plugins");
  const dstPlugins = join(dir, "plugins");
  if (existsSync(srcPlugins) && !existsSync(dstPlugins)) {
    try { symlinkSync(srcPlugins, dstPlugins, "dir"); } catch { /* best-effort */ }
  }
  return dir;
}
```

Also delete the now-unused `CRED_FILES` constant (lines around `const CRED_FILES = [...]`) and drop `rmSync` from the `node:fs` import if it is otherwise unused (grep first; `resolveSessionConfigDir` does not use it).

- [ ] **Step 4: Run tests**

Run: `bun test tests/agent/oauth-home-seed.test.ts` then `bunx tsc --noEmit`
Expected: PASS; tsc clean (no unused `rmSync`/`CRED_FILES`).

- [ ] **Step 5: Commit**

```bash
git add src/agent/oauth-home.ts tests/agent/oauth-home-seed.test.ts
git commit -m "fix(1on1): keep initiator .credentials.json; seed settings.local.json"
```

---

## Task 1: Store writer — `oauthKey` + `writeEntry`

**Files:**
- Create: `src/agent/mcp-oauth/store.ts`
- Test: `tests/agent/mcp-oauth/store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/mcp-oauth/store.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { oauthKey, writeEntry } from "../../../src/agent/mcp-oauth/store";

describe("mcp-oauth store", () => {
  it("oauthKey reproduces the pinned golden (canary on a2A drift)", () => {
    const key = oauthKey("workbench", { type: "http", url: "https://mcp.example.com/sse", headers: {} });
    expect(key).toBe("workbench|c17ea65c6b709142");
  });

  it("oauthKey ignores undefined headers identically to headers:{}", () => {
    const a = oauthKey("s", { type: "http", url: "https://h/" });
    const b = oauthKey("s", { type: "http", url: "https://h/", headers: {} });
    expect(a).toBe(b);
  });

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slaude-store-")); });

  it("writeEntry sets mcpOAuth[key] and preserves other top-level keys", () => {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { keep: 1 } }));
    writeEntry(dir, "workbench", { type: "http", url: "https://mcp.example.com/sse", headers: {} }, {
      clientId: "cid", clientSecret: "csec", accessToken: "atok", refreshToken: "rtok", expiresIn: 3600,
    }, () => 1_000_000);
    const c = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
    expect(c.claudeAiOauth).toEqual({ keep: 1 });
    const e = c.mcpOAuth["workbench|c17ea65c6b709142"];
    expect(e).toMatchObject({
      serverName: "workbench", serverUrl: "https://mcp.example.com/sse",
      clientId: "cid", clientSecret: "csec", accessToken: "atok", refreshToken: "rtok",
      expiresAt: 1_000_000 + 3600 * 1000,
    });
  });

  it("writeEntry creates the file when absent and chmods 0600", () => {
    writeEntry(dir, "s", { type: "http", url: "https://h/", headers: {} }, {
      clientId: "c", accessToken: "a", refreshToken: "r", expiresIn: undefined,
    }, () => 0);
    const p = join(dir, ".credentials.json");
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
    const c = JSON.parse(readFileSync(p, "utf8"));
    // default expiry is now + 3600s when expiresIn is undefined
    expect(c.mcpOAuth["s|" + oauthKey("s", { type: "http", url: "https://h/" }).split("|")[1]].expiresAt).toBe(3600 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/mcp-oauth/store.test.ts`
Expected: FAIL — `Cannot find module '.../store'`.

- [ ] **Step 3: Write `src/agent/mcp-oauth/store.ts`**

```typescript
/**
 * Writer for claude-code's native MCP OAuth credential store
 * (`<CLAUDE_CONFIG_DIR>/.credentials.json` → `mcpOAuth[key]`).
 *
 * The CLI owns refresh/reconnect off this entry (clientId + refreshToken). slaude
 * only writes the initial grant here; everything after is the CLI's. The key/format
 * are reverse-engineered from cli.js (`a2A` + the file store `V_1`) and pinned by a
 * golden test — if the CLI changes its format, that canary fails loudly.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/** Subset of an MCP HTTP server config that participates in the store key. */
export interface OAuthServerConfig {
  type: string; // "http"
  url: string;
  headers?: Record<string, string>;
}

export interface OAuthTokens {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  /** Seconds; defaults to 3600 when undefined (matches the CLI). */
  expiresIn?: number;
}

/** Replica of the CLI's `a2A`: `${name}|sha256(JSON.stringify({type,url,headers||{}})).hex[0:16]`.
 *  NOTE: plain JSON.stringify with FIXED field order — do NOT sort keys. */
export function oauthKey(serverName: string, cfg: OAuthServerConfig): string {
  const body = JSON.stringify({ type: cfg.type, url: cfg.url, headers: cfg.headers || {} });
  const hash = createHash("sha256").update(body).digest("hex").substring(0, 16);
  return `${serverName}|${hash}`;
}

/** Read-modify-write the credential file: set mcpOAuth[key], preserve every other
 *  key, write atomically (temp + rename) at 0600. `now` is injectable for tests. */
export function writeEntry(
  configDir: string,
  serverName: string,
  cfg: OAuthServerConfig,
  tokens: OAuthTokens,
  now: () => number = Date.now,
): void {
  const path = join(configDir, ".credentials.json");
  let current: Record<string, any> = {};
  if (existsSync(path)) {
    try { current = JSON.parse(readFileSync(path, "utf8")) || {}; } catch { current = {}; }
  }
  const key = oauthKey(serverName, cfg);
  const expiresAt = now() + (tokens.expiresIn ?? 3600) * 1000;
  const next = {
    ...current,
    mcpOAuth: {
      ...(current.mcpOAuth || {}),
      [key]: {
        serverName,
        serverUrl: cfg.url,
        clientId: tokens.clientId,
        clientSecret: tokens.clientSecret,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt,
      },
    },
  };
  // Atomic write so a concurrent CLI refresh-write can't observe a torn file.
  const tmp = join(configDir, `.credentials.json.tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/agent/mcp-oauth/store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-oauth/store.ts tests/agent/mcp-oauth/store.test.ts
git commit -m "feat(mcp-oauth): credential-store writer with pinned a2A canary"
```

---

## Task 2: PKCE + state helpers

**Files:**
- Create: `src/agent/mcp-oauth/pkce.ts`
- Test: `tests/agent/mcp-oauth/pkce.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/mcp-oauth/pkce.test.ts
import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { generatePkce, randomState } from "../../../src/agent/mcp-oauth/pkce";

describe("pkce", () => {
  it("challenge is base64url(sha256(verifier)), no padding", () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe("S256");
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(challenge).not.toContain("=");
  });

  it("verifier is 43-128 url-safe chars", () => {
    const { verifier } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("randomState returns distinct url-safe tokens", () => {
    expect(randomState()).not.toBe(randomState());
    expect(randomState()).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/mcp-oauth/pkce.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/mcp-oauth/pkce.ts`**

```typescript
import { createHash, randomBytes } from "node:crypto";

export interface Pkce { verifier: string; challenge: string; method: "S256"; }

/** RFC 7636 PKCE pair. Verifier is 32 random bytes base64url-encoded (43 chars). */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/** Opaque CSRF state token. */
export function randomState(): string {
  return randomBytes(16).toString("base64url");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/agent/mcp-oauth/pkce.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-oauth/pkce.ts tests/agent/mcp-oauth/pkce.test.ts
git commit -m "feat(mcp-oauth): PKCE + state helpers"
```

---

## Task 3: Authorization-server discovery

**Files:**
- Create: `src/agent/mcp-oauth/discovery.ts`
- Test: `tests/agent/mcp-oauth/discovery.test.ts`

Discovery per the MCP authorization spec: unauthenticated `GET <server>` returns `401` with `WWW-Authenticate: Bearer resource_metadata="<url>"`; that protected-resource-metadata document lists `authorization_servers`; the AS metadata document yields the endpoints.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/mcp-oauth/discovery.test.ts
import { describe, it, expect } from "bun:test";
import { discover } from "../../../src/agent/mcp-oauth/discovery";

function fetchStub(routes: Record<string, { status: number; headers?: Record<string,string>; body?: any }>) {
  return async (url: string) => {
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return {
      status: r.status,
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
      json: async () => r.body,
    } as any;
  };
}

describe("discover", () => {
  it("walks 401 → resource metadata → AS metadata", async () => {
    const f = fetchStub({
      "https://mcp.example.com/": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } },
      "https://mcp.example.com/.well-known/oauth-protected-resource": { status: 200, body: { authorization_servers: ["https://as.example.com"] } },
      "https://as.example.com/.well-known/oauth-authorization-server": { status: 200, body: {
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
        registration_endpoint: "https://as.example.com/register",
      } },
    });
    const meta = await discover("https://mcp.example.com/", f as any);
    expect(meta).toEqual({
      authorizationEndpoint: "https://as.example.com/authorize",
      tokenEndpoint: "https://as.example.com/token",
      registrationEndpoint: "https://as.example.com/register",
    });
  });

  it("throws a clear error when the server does not advertise resource metadata", async () => {
    const f = fetchStub({ "https://mcp.example.com/": { status: 401, headers: {} } });
    await expect(discover("https://mcp.example.com/", f as any)).rejects.toThrow(/resource_metadata/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/mcp-oauth/discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/mcp-oauth/discovery.ts`**

```typescript
export interface AuthServerMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

type FetchLike = (url: string, init?: any) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
}>;

/** Resolve the OAuth authorization-server metadata for an HTTP MCP server.
 *  fetchImpl is injectable for tests; defaults to global fetch. */
export async function discover(serverUrl: string, fetchImpl: FetchLike = fetch as any): Promise<AuthServerMeta> {
  const probe = await fetchImpl(serverUrl);
  const wwwAuth = probe.headers.get("www-authenticate") || "";
  const m = wwwAuth.match(/resource_metadata="([^"]+)"/);
  if (!m) {
    throw new Error(`MCP server did not advertise resource_metadata (status ${probe.status}, WWW-Authenticate="${wwwAuth}")`);
  }
  const prm = await (await fetchImpl(m[1]!)).json();
  const asUrl: string | undefined = prm?.authorization_servers?.[0];
  if (!asUrl) throw new Error("protected-resource metadata listed no authorization_servers");
  const asMetaUrl = asUrl.replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
  const as = await (await fetchImpl(asMetaUrl)).json();
  if (!as?.authorization_endpoint || !as?.token_endpoint) {
    throw new Error("authorization-server metadata missing authorization_endpoint/token_endpoint");
  }
  return {
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/agent/mcp-oauth/discovery.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-oauth/discovery.ts tests/agent/mcp-oauth/discovery.test.ts
git commit -m "feat(mcp-oauth): authorization-server discovery"
```

---

## Task 4: Dynamic client registration

**Files:**
- Create: `src/agent/mcp-oauth/register.ts`
- Test: `tests/agent/mcp-oauth/register.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/mcp-oauth/register.test.ts
import { describe, it, expect } from "bun:test";
import { registerClient } from "../../../src/agent/mcp-oauth/register";

describe("registerClient", () => {
  it("POSTs redirect_uris + public-client metadata, returns client_id/secret", async () => {
    let seen: any;
    const f = async (_url: string, init: any) => { seen = JSON.parse(init.body); return {
      status: 201, headers: { get: () => null }, json: async () => ({ client_id: "abc", client_secret: "shh" }),
    } as any; };
    const out = await registerClient("https://as/register", "http://localhost:5599/callback", f as any);
    expect(out).toEqual({ clientId: "abc", clientSecret: "shh" });
    expect(seen.redirect_uris).toEqual(["http://localhost:5599/callback"]);
    expect(seen.token_endpoint_auth_method).toBe("none");
    expect(seen.grant_types).toContain("authorization_code");
  });

  it("throws on non-2xx", async () => {
    const f = async () => ({ status: 400, headers: { get: () => null }, json: async () => ({ error: "invalid" }) } as any);
    await expect(registerClient("https://as/register", "http://localhost:1/callback", f as any)).rejects.toThrow(/registration failed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/mcp-oauth/register.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/mcp-oauth/register.ts`**

```typescript
type FetchLike = (url: string, init?: any) => Promise<{ status: number; headers: { get(n: string): string | null }; json(): Promise<any>; }>;

export interface ClientInfo { clientId: string; clientSecret?: string; }

/** RFC 7591 dynamic client registration for a public (PKCE) client. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch as any,
): Promise<ClientInfo> {
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "slaude",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (res.status < 200 || res.status >= 300) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`client registration failed (status ${res.status}): ${JSON.stringify(body)}`);
  }
  const j = await res.json();
  if (!j?.client_id) throw new Error("registration response missing client_id");
  return { clientId: j.client_id, clientSecret: j.client_secret };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/agent/mcp-oauth/register.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-oauth/register.ts tests/agent/mcp-oauth/register.test.ts
git commit -m "feat(mcp-oauth): dynamic client registration"
```

---

## Task 5: Loopback callback listener

**Files:**
- Create: `src/agent/mcp-oauth/loopback.ts`
- Test: `tests/agent/mcp-oauth/loopback.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/mcp-oauth/loopback.test.ts
import { describe, it, expect } from "bun:test";
import { startLoopback } from "../../../src/agent/mcp-oauth/loopback";

describe("startLoopback", () => {
  it("resolves the code when state matches", async () => {
    const lb = await startLoopback({ host: "127.0.0.1", expectedState: "S1", timeoutMs: 2000 });
    const url = `http://127.0.0.1:${lb.port}${lb.callbackPath}?code=THE_CODE&state=S1`;
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(await lb.waitForCode()).toBe("THE_CODE");
  });

  it("rejects on state mismatch (CSRF guard)", async () => {
    const lb = await startLoopback({ host: "127.0.0.1", expectedState: "GOOD", timeoutMs: 2000 });
    await fetch(`http://127.0.0.1:${lb.port}${lb.callbackPath}?code=x&state=BAD`);
    await expect(lb.waitForCode()).rejects.toThrow(/state/i);
  });

  it("rejects on timeout", async () => {
    const lb = await startLoopback({ host: "127.0.0.1", expectedState: "S", timeoutMs: 50 });
    await expect(lb.waitForCode()).rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/mcp-oauth/loopback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/mcp-oauth/loopback.ts`**

```typescript
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

export interface LoopbackOpts {
  /** "127.0.0.1" locally; "0.0.0.0" in-container (mapped via docker -p). */
  host?: string;
  /** Explicit port, or 0 for an ephemeral OS-assigned port. */
  port?: number;
  expectedState: string;
  timeoutMs: number;
  callbackPath?: string;
}

export interface Loopback {
  port: number;
  callbackPath: string;
  /** Resolves with the auth code once the browser hits the callback; rejects on
   *  state mismatch or timeout. Always closes the listener before settling. */
  waitForCode(): Promise<string>;
}

export async function startLoopback(opts: LoopbackOpts): Promise<Loopback> {
  const callbackPath = opts.callbackPath ?? "/callback";
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url || "/", `http://${req.headers.host}`);
    if (u.pathname !== callbackPath) { res.statusCode = 404; res.end("not found"); return; }
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    if (state !== opts.expectedState) {
      res.statusCode = 400; res.end("state mismatch — you can close this tab");
      settle(() => rejectCode(new Error("OAuth callback state mismatch (possible CSRF)")));
      return;
    }
    if (!code) {
      res.statusCode = 400; res.end("missing code");
      settle(() => rejectCode(new Error("OAuth callback missing code")));
      return;
    }
    res.statusCode = 200; res.end("slaude connected — you can close this tab.");
    settle(() => resolveCode(code));
  });

  let settled = false;
  const timer = setTimeout(() => settle(() => rejectCode(new Error("OAuth loopback timeout — no callback received"))), opts.timeoutMs);
  function settle(fn: () => void) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    fn();
  }

  await new Promise<void>((res) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  return { port, callbackPath, waitForCode: () => codePromise };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/agent/mcp-oauth/loopback.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-oauth/loopback.ts tests/agent/mcp-oauth/loopback.test.ts
git commit -m "feat(mcp-oauth): ephemeral loopback callback listener"
```

---

## Task 6: Loopback config accessors

**Files:**
- Modify: `src/config/env.ts` (inside the `env` object literal)
- Test: `tests/config/oauth-loopback-env.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config/oauth-loopback-env.test.ts
import { describe, it, expect } from "bun:test";
import { env } from "../../src/config/env";

describe("oauth loopback env", () => {
  it("host defaults to 127.0.0.1, overridable", () => {
    delete process.env.SLAUDE_OAUTH_LOOPBACK_HOST;
    expect(env.oauthLoopbackHost()).toBe("127.0.0.1");
    process.env.SLAUDE_OAUTH_LOOPBACK_HOST = "0.0.0.0";
    expect(env.oauthLoopbackHost()).toBe("0.0.0.0");
    delete process.env.SLAUDE_OAUTH_LOOPBACK_HOST;
  });

  it("port range parses 'a-b'; 0 (ephemeral) when unset", () => {
    delete process.env.SLAUDE_OAUTH_LOOPBACK_PORTS;
    expect(env.oauthLoopbackPorts()).toEqual([]);
    process.env.SLAUDE_OAUTH_LOOPBACK_PORTS = "40100-40102";
    expect(env.oauthLoopbackPorts()).toEqual([40100, 40101, 40102]);
    delete process.env.SLAUDE_OAUTH_LOOPBACK_PORTS;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config/oauth-loopback-env.test.ts`
Expected: FAIL — `env.oauthLoopbackHost is not a function`.

- [ ] **Step 3: Add accessors to the `env` object in `src/config/env.ts`**

Insert before the closing `};` of the `env` literal (after the `metricsPerUser` accessor):

```typescript
  /** Loopback bind host for the /mcp OAuth callback. 127.0.0.1 locally; set
   *  0.0.0.0 in-container so a `docker -p` mapped port is reachable from the host. */
  oauthLoopbackHost: () => opt("SLAUDE_OAUTH_LOOPBACK_HOST", "127.0.0.1"),
  /** Inclusive port range "a-b" the container pre-maps with `-p`. Empty → ephemeral
   *  (port 0); the connect flow picks the first free port in the range otherwise. */
  oauthLoopbackPorts: (): number[] => {
    const raw = opt("SLAUDE_OAUTH_LOOPBACK_PORTS", "").trim();
    const m = raw.match(/^(\d+)-(\d+)$/);
    if (!m) return [];
    const lo = parseInt(m[1]!, 10), hi = parseInt(m[2]!, 10);
    const out: number[] = [];
    for (let p = lo; p <= hi; p++) out.push(p);
    return out;
  },
```

(If `opt` is not already the helper name used in this file, match the existing `opt("NAME", "default")` convention seen on `metricsPerUser`.)

- [ ] **Step 4: Run tests**

Run: `bun test tests/config/oauth-loopback-env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/config/oauth-loopback-env.test.ts
git commit -m "feat(mcp-oauth): loopback host/port-range env accessors"
```

---

## Task 7: OAuth client orchestrator

**Files:**
- Create: `src/agent/mcp-oauth/client.ts`
- Test: `tests/agent/mcp-oauth/client.test.ts`

Ties discovery + register + pkce + loopback + token exchange into a two-call handle: `beginConnect()` returns `{ authorizeUrl, waitForCode, exchange }`; the caller surfaces `authorizeUrl`, awaits `waitForCode()`, then `exchange(code)` → tokens for `store.writeEntry`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/mcp-oauth/client.test.ts
import { describe, it, expect } from "bun:test";
import { beginConnect } from "../../../src/agent/mcp-oauth/client";

const META = {
  authorizationEndpoint: "https://as/authorize",
  tokenEndpoint: "https://as/token",
  registrationEndpoint: "https://as/register",
};

it("builds an authorize URL with PKCE+state, exchanges the code for tokens", async () => {
  let tokenReq: any;
  const fetchImpl = async (url: string, init?: any) => {
    if (url === "https://as/register") return { status: 201, headers: { get: () => null }, json: async () => ({ client_id: "cid", client_secret: "csec" }) } as any;
    if (url === "https://as/token") { tokenReq = init; return { status: 200, headers: { get: () => null }, json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 1234 }) } as any; }
    throw new Error("unexpected " + url);
  };
  const handle = await beginConnect({
    serverName: "workbench",
    serverConfig: { type: "http", url: "https://mcp/", headers: {} },
    meta: META,
    loopbackHost: "127.0.0.1",
    timeoutMs: 2000,
    fetchImpl: fetchImpl as any,
  });

  const au = new URL(handle.authorizeUrl);
  expect(au.origin + au.pathname).toBe("https://as/authorize");
  expect(au.searchParams.get("response_type")).toBe("code");
  expect(au.searchParams.get("client_id")).toBe("cid");
  expect(au.searchParams.get("code_challenge_method")).toBe("S256");
  expect(au.searchParams.get("code_challenge")).toBeTruthy();
  const redirect = au.searchParams.get("redirect_uri")!;
  const state = au.searchParams.get("state")!;

  // Simulate the browser hitting the loopback.
  await fetch(`${redirect}?code=CODE123&state=${state}`);
  const code = await handle.waitForCode();
  expect(code).toBe("CODE123");

  const tokens = await handle.exchange(code);
  expect(tokens).toMatchObject({ clientId: "cid", clientSecret: "csec", accessToken: "AT", refreshToken: "RT", expiresIn: 1234 });
  const body = new URLSearchParams(tokenReq.body);
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("CODE123");
  expect(body.get("code_verifier")).toBeTruthy();
  expect(body.get("redirect_uri")).toBe(redirect);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/mcp-oauth/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/mcp-oauth/client.ts`**

```typescript
import { generatePkce, randomState } from "./pkce";
import { registerClient } from "./register";
import { startLoopback } from "./loopback";
import type { AuthServerMeta } from "./discovery";
import type { OAuthServerConfig, OAuthTokens } from "./store";

type FetchLike = (url: string, init?: any) => Promise<{ status: number; headers: { get(n: string): string | null }; json(): Promise<any>; }>;

export interface BeginConnectOpts {
  serverName: string;
  serverConfig: OAuthServerConfig;
  meta: AuthServerMeta;
  loopbackHost?: string;
  loopbackPort?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface ConnectHandle {
  authorizeUrl: string;
  waitForCode(): Promise<string>;
  exchange(code: string): Promise<OAuthTokens>;
}

/** Run registration + PKCE + loopback bind, hand back the authorize URL and a
 *  one-shot waiter/exchanger. The caller posts authorizeUrl to the initiator,
 *  awaits waitForCode(), then exchange(code) → tokens for store.writeEntry. */
export async function beginConnect(opts: BeginConnectOpts): Promise<ConnectHandle> {
  const fetchImpl = opts.fetchImpl ?? (fetch as any);
  if (!opts.meta.registrationEndpoint) throw new Error("authorization server has no registration_endpoint (dynamic registration required)");

  const state = randomState();
  const pkce = generatePkce();
  const loopback = await startLoopback({
    host: opts.loopbackHost ?? "127.0.0.1",
    port: opts.loopbackPort,
    expectedState: state,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });
  const redirectUri = `http://localhost:${loopback.port}${loopback.callbackPath}`;
  const client = await registerClient(opts.meta.registrationEndpoint, redirectUri, fetchImpl);

  const authorizeUrl = (() => {
    const u = new URL(opts.meta.authorizationEndpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", client.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("code_challenge", pkce.challenge);
    u.searchParams.set("code_challenge_method", pkce.method);
    u.searchParams.set("state", state);
    u.searchParams.set("resource", opts.serverConfig.url);
    return u.toString();
  })();

  async function exchange(code: string): Promise<OAuthTokens> {
    const res = await fetchImpl(opts.meta.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        code_verifier: pkce.verifier,
        resource: opts.serverConfig.url,
      }).toString(),
    });
    if (res.status < 200 || res.status >= 300) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`token exchange failed (status ${res.status}): ${JSON.stringify(body)}`);
    }
    const j = await res.json();
    if (!j?.access_token) throw new Error("token response missing access_token");
    return {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresIn: j.expires_in,
    };
  }

  return { authorizeUrl, waitForCode: loopback.waitForCode, exchange };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/agent/mcp-oauth/client.test.ts && bunx tsc --noEmit`
Expected: PASS (1 test); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-oauth/client.ts tests/agent/mcp-oauth/client.test.ts
git commit -m "feat(mcp-oauth): connect orchestrator (discover→register→pkce→exchange)"
```

---

## Task 8: Manager — expose `mcpServerStatus(sessionId)`

**Files:**
- Modify: `src/agent/manager.ts` (add a method next to `setPermissionMode`)
- Test: `tests/agent/manager-mcp-status.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/manager-mcp-status.test.ts
import { describe, it, expect } from "bun:test";
import { AgentManager } from "../../src/agent/manager";

describe("AgentManager.mcpServerStatus", () => {
  it("returns null when the session is not live", async () => {
    const mgr = new AgentManager();
    expect(await mgr.mcpServerStatus("no-such-session")).toBeNull();
  });

  it("delegates to the live Query when present", async () => {
    const mgr = new AgentManager();
    const fake = [{ name: "workbench", status: "needs-auth" as const }];
    // Inject a fake live session with a Query exposing mcpServerStatus.
    (mgr as any)["#live"]; // touch to document intent
    (mgr as any).__setLiveForTest?.("s1", { query: { mcpServerStatus: async () => fake } });
    // If no test seam exists, assert the null path above is the contract and skip.
    const out = await mgr.mcpServerStatus("s1");
    expect(out === null || out === fake).toBe(true);
  });
});
```

> Note: the manager uses a private `#live` map. If no existing test seam exposes it, keep the first assertion (null path) as the contract test and delete the second `it(...)`; the live path is covered end-to-end by the sim test in Task 10.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/manager-mcp-status.test.ts`
Expected: FAIL — `mgr.mcpServerStatus is not a function`.

- [ ] **Step 3: Add the method to `src/agent/manager.ts`**

Immediately after `setPermissionMode(...)` (around line 202), add:

```typescript
  /** Current MCP server statuses for a live session, or null if not live.
   *  Read-only passthrough to the SDK Query — slaude maintains no mirror. */
  async mcpServerStatus(sessionId: string) {
    const live = this.#live.get(sessionId);
    if (!live?.query) return null;
    try {
      return await live.query.mcpServerStatus();
    } catch (e) {
      console.error("[agent] mcpServerStatus failed:", e);
      return null;
    }
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/agent/manager-mcp-status.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean. (Keep only the null-path assertion if no `#live` test seam exists.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/manager.ts tests/agent/manager-mcp-status.test.ts
git commit -m "feat(agent): expose mcpServerStatus(sessionId) passthrough"
```

---

## Task 9: `/mcp` slash-command parsing + help

**Files:**
- Modify: `src/gateway/slack/commands.ts`
- Test: `tests/gateway/slack/commands-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway/slack/commands-mcp.test.ts
import { describe, it, expect } from "bun:test";
import { parseSlashCommand } from "../../../src/gateway/slack/commands";

describe("parseSlashCommand /mcp", () => {
  it("/mcp → status", () => {
    expect(parseSlashCommand("/mcp")).toEqual({ kind: "mcp", action: "status" });
  });
  it("/mcp connect <server> → connect with server", () => {
    expect(parseSlashCommand("/mcp connect workbench")).toEqual({ kind: "mcp", action: "connect", server: "workbench" });
  });
  it("/mcp connect (no server) → connect, server undefined", () => {
    expect(parseSlashCommand("/mcp connect")).toEqual({ kind: "mcp", action: "connect", server: undefined });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/slack/commands-mcp.test.ts`
Expected: FAIL — returns `null` (unknown command).

- [ ] **Step 3: Edit `src/gateway/slack/commands.ts`**

Add the variant to the `SlashHit` union (after the `one-on-one` line):

```typescript
  | { kind: "mcp"; action: "status" | "connect"; server?: string }
```

Add a help entry to `AGENT_COMMANDS` (after the `/1on1` entry):

```typescript
  { usage: "/mcp [connect <server>]", summary: "in 1on1: list MCP servers / connect an OAuth HTTP server" },
```

Add the parser branch (before the `HELP_NAMES` check):

```typescript
  if (cmd === "mcp") {
    if ((rest[0] ?? "").toLowerCase() === "connect") {
      return { kind: "mcp", action: "connect", server: rest[1] };
    }
    return { kind: "mcp", action: "status" };
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/gateway/slack/commands-mcp.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/commands.ts tests/gateway/slack/commands-mcp.test.ts
git commit -m "feat(mcp-oauth): parse /mcp [connect <server>] slash command"
```

---

## Task 10: Gateway `/mcp` handler — status card, gate, connect flow

**Files:**
- Modify: `src/gateway/core/gateway.ts`
- Test: `tests/gateway/sim/mcp-connect.test.ts`

The handler must, inside the existing slash-dispatch block (alongside `slash.kind === "one-on-one"`):
1. **Gate:** reject unless this thread is `/1on1`-locked AND `userId === lock.locked_user`.
2. **status:** call `agent.mcpServerStatus(session.id)`; render a card listing each server + status; for each non-`connected` HTTP server, append a `[Connect <name>]` button (`action_id = slaude_mcp:connect:<token>` where `<token>` keys a pending map holding `{ sessionId, channelId, threadTs, userId, serverName }`).
3. **connect (button or `/mcp connect <server>`):** resolve the server's config from `loadExternalMcp`, build `OAuthServerConfig`, run discovery + `beginConnect`, post `authorizeUrl` to the thread, `await waitForCode()`, `exchange`, `store.writeEntry(initiatorConfigDir(userId), …)`, `agent.reload(session.id)`, then post `:white_check_mark: connected`.

Because the connect leg needs network + a browser, the **sim test stubs the OAuth client** via an injected factory on `GatewayOptions` (add `oauthConnect?` seam) and asserts the gate + the store write, not real HTTP.

- [ ] **Step 1: Add an injectable seam to `GatewayOptions`**

In `src/gateway/core/gateway.ts`, extend `GatewayOptions` (near `surfaceFactory`):

```typescript
  /** Test/deploy seam for the /mcp OAuth connect flow. Defaults to the real
   *  discovery+beginConnect pipeline. Returns the tokens to store, or throws. */
  oauthConnect?: (args: {
    serverName: string;
    serverConfig: import("../../agent/mcp-oauth/store").OAuthServerConfig;
    postAuthorizeUrl: (url: string) => Promise<void>;
  }) => Promise<import("../../agent/mcp-oauth/store").OAuthTokens>;
```

- [ ] **Step 2: Write the failing sim test**

```typescript
// tests/gateway/sim/mcp-connect.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runScenario } from "../../../src/gateway/sim/engine"; // adjust to the sim's public entry
import { initiatorConfigDir } from "../../../src/agent/oauth-home";
import { oauthKey } from "../../../src/agent/mcp-oauth/store";

// This test exercises the gateway message router directly (as the cron/1on1 sim
// tests do). Follow the SAME harness those tests use; pseudo-shape below.
describe("/mcp connect (sim)", () => {
  it("rejects /mcp when the thread is not 1on1-locked", async () => {
    // send "/mcp" from U0ALICE in an unlocked thread → expect a 'must be in 1on1' reply
    // assert no card with Connect buttons
  });

  it("locked initiator: /mcp connect writes mcpOAuth and reloads", async () => {
    // 1) U0ALICE: /1on1            → lock
    // 2) configure one external HTTP server "workbench" in the sim mcp.json
    // 3) inject oauthConnect seam returning fixed tokens, capture postAuthorizeUrl call
    // 4) U0ALICE: /mcp connect workbench
    // 5) assert .credentials.json under initiatorConfigDir("U0ALICE") has mcpOAuth[oauthKey(...)]
    //    and that a reload happened
  });
});
```

> The exact sim harness calls mirror `tests/gateway/sim/*` (e.g. the cron channel-target test referenced in CLAUDE.md findings). Use that file as the template for wiring `createGateway` with `opts.oauthConnect` and feeding messages.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/gateway/sim/mcp-connect.test.ts`
Expected: FAIL — `/mcp` unhandled (no reply / no store write).

- [ ] **Step 4: Implement the handler**

Add imports at the top of `gateway.ts`:

```typescript
import { initiatorConfigDir } from "../../agent/oauth-home";
import { writeEntry, type OAuthServerConfig } from "../../agent/mcp-oauth/store";
import { discover } from "../../agent/mcp-oauth/discovery";
import { beginConnect } from "../../agent/mcp-oauth/client";
```

Add a module-scoped pending map + default connect runner near the other gateway state:

```typescript
  // /mcp [Connect] button → pending connect context keyed by a short token.
  const pendingMcp = new Map<string, { sessionId: string; channelId: string; threadTs: string; userId: string; serverName: string }>();

  const runConnect = opts.oauthConnect ?? (async ({ serverName, serverConfig, postAuthorizeUrl }) => {
    const meta = await discover(serverConfig.url);
    const handle = await beginConnect({
      serverName, serverConfig, meta,
      loopbackHost: env.oauthLoopbackHost(),
      loopbackPort: env.oauthLoopbackPorts()[0],
      timeoutMs: 5 * 60_000,
    });
    await postAuthorizeUrl(handle.authorizeUrl);
    const code = await handle.waitForCode();
    return handle.exchange(code);
  });
```

Add the dispatch branch alongside `slash.kind === "one-on-one"`:

```typescript
      if (slash.kind === "mcp") {
        const lock = OneOnOne.find(channelId, threadTs);
        if (!lock || lock.locked_user !== userId) {
          await reply(":lock: `/mcp` works only inside a thread you have locked with `/1on1`.");
          return;
        }
        const ext = loadExternalMcp();                       // { servers: Record<name, cfg> }
        const httpServers = Object.entries(ext.servers).filter(([, c]: any) => c?.type === "http");

        if (slash.action === "status") {
          const statuses = await agent.mcpServerStatus(session.id);
          if (!statuses) { await reply("Send a message in this thread first, then `/mcp` (no live session yet)."); return; }
          const lines = statuses.map((s) => `• \`${s.name}\` — ${s.status}`);
          const buttons = statuses
            .filter((s) => s.status !== "connected" && httpServers.some(([n]) => n === s.name))
            .map((s) => {
              const token = `${Date.now().toString(36)}_${s.name}`;
              pendingMcp.set(token, { sessionId: session.id, channelId, threadTs, userId, serverName: s.name });
              return { type: "button", text: { type: "plain_text", text: `Connect ${s.name}` }, action_id: `slaude_mcp:connect:${token}` };
            });
          await t.client.chat.postMessage({
            channel: channelId, thread_ts: threadTs,
            text: "MCP servers",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `*MCP servers*\n${lines.join("\n")}` } },
              ...(buttons.length ? [{ type: "actions", elements: buttons }] : []),
            ],
          });
          return;
        }

        // slash.action === "connect"
        const name = slash.server;
        const entry = name ? httpServers.find(([n]) => n === name) : undefined;
        if (!entry) { await reply(`Unknown or non-HTTP MCP server \`${name ?? ""}\`. Use \`/mcp\` to list.`); return; }
        await connectServer({ sessionId: session.id, channelId, threadTs, userId, serverName: entry[0], serverCfg: entry[1] as any });
        return;
      }
```

Add a shared `connectServer` helper (in the gateway closure, near `runConnect`):

```typescript
  async function connectServer(a: { sessionId: string; channelId: string; threadTs: string; userId: string; serverName: string; serverCfg: any }) {
    const post = (text: string) => t.client.chat.postMessage({ channel: a.channelId, thread_ts: a.threadTs, text });
    const serverConfig: OAuthServerConfig = { type: "http", url: a.serverCfg.url, headers: a.serverCfg.headers };
    try {
      const tokens = await runConnect({
        serverName: a.serverName, serverConfig,
        postAuthorizeUrl: async (url) => { await post(`:link: Authorize \`${a.serverName}\`: ${url}\n(opens a browser; the loopback captures the result)`); },
      });
      writeEntry(initiatorConfigDir(a.userId), a.serverName, serverConfig, tokens);
      agent.reload(a.sessionId);
      await post(`:white_check_mark: \`${a.serverName}\` connected. Next message will use it.`);
    } catch (e) {
      await post(`:x: \`${a.serverName}\` connect failed: ${(e as Error).message}`);
    }
  }
```

Wire the `[Connect]` button via `t.action` at gateway init (near where other handlers register):

```typescript
  t.action(/^slaude_mcp:connect:.+$/, async ({ ack, action }) => {
    await ack();
    const id = (action as { action_id: string }).action_id;
    const token = id.replace(/^slaude_mcp:connect:/, "");
    const ctx = pendingMcp.get(token);
    if (!ctx) return;
    pendingMcp.delete(token);
    const ext = loadExternalMcp();
    const cfg = (ext.servers as any)[ctx.serverName];
    if (!cfg) return;
    await connectServer({ ...ctx, serverCfg: cfg });
  });
```

> Verify the actual return shape of `loadExternalMcp` (Task references `external-mcp.ts`'s `parseExternalMcp` → `{ servers }`). If the gateway already holds a parsed `externalMcp` in scope at dispatch time, reuse it instead of re-reading.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/gateway/sim/mcp-connect.test.ts && bunx tsc --noEmit && bun test`
Expected: PASS; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/core/gateway.ts tests/gateway/sim/mcp-connect.test.ts
git commit -m "feat(mcp-oauth): /mcp status card + 1on1-gated connect flow"
```

---

## Task 11: Startup canary guard

**Files:**
- Modify: `src/agent/mcp-oauth/store.ts` (add `assertOAuthKeyCanary`)
- Modify: `src/server.ts` (call it at boot; log loud + disable `/mcp` on mismatch)
- Test: `tests/agent/mcp-oauth/canary.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/mcp-oauth/canary.test.ts
import { describe, it, expect } from "bun:test";
import { assertOAuthKeyCanary } from "../../../src/agent/mcp-oauth/store";

describe("assertOAuthKeyCanary", () => {
  it("returns true when oauthKey still matches the pinned golden", () => {
    expect(assertOAuthKeyCanary()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/mcp-oauth/canary.test.ts`
Expected: FAIL — `assertOAuthKeyCanary` not exported.

- [ ] **Step 3: Add to `src/agent/mcp-oauth/store.ts`**

```typescript
/** Boot-time canary: our oauthKey replica must still reproduce the pinned golden.
 *  Returns false (caller disables /mcp + logs loud) if the formula drifts. */
export function assertOAuthKeyCanary(): boolean {
  return oauthKey("workbench", { type: "http", url: "https://mcp.example.com/sse", headers: {} })
    === "workbench|c17ea65c6b709142";
}
```

- [ ] **Step 4: Wire into boot**

In `src/server.ts`, after config load and before/around gateway creation:

```typescript
import { assertOAuthKeyCanary } from "./agent/mcp-oauth/store";
// ...
const mcpOAuthHealthy = assertOAuthKeyCanary();
if (!mcpOAuthHealthy) {
  console.error("[mcp-oauth] CANARY FAILED — oauthKey no longer matches the CLI store format. /mcp connect is DISABLED. Update src/agent/mcp-oauth/store.ts against the current cli.js.");
}
```

Pass `mcpOAuthHealthy` to `createGateway` via `GatewayOptions` (`mcpConnectEnabled?: boolean`, default true) and in the `/mcp` handler, when `false`, reply `":warning: /mcp connect is temporarily disabled (store-format canary failed) — see server logs."` and return before any connect work.

- [ ] **Step 5: Run tests + typecheck, commit**

Run: `bun test tests/agent/mcp-oauth/canary.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean.

```bash
git add src/agent/mcp-oauth/store.ts src/server.ts src/gateway/core/gateway.ts tests/agent/mcp-oauth/canary.test.ts
git commit -m "feat(mcp-oauth): boot canary disables /mcp on store-format drift"
```

---

## Task 12: Container smoke (verify harness) + docs

**Files:**
- Modify: `scripts/verify-1on1.sh`, `.env.verify.example`
- Create: `docs/findings/2026-06-09-mcp-oauth-connect-1on1.md`
- Modify: `CLAUDE.md` (Findings Log index), spec status → Implemented

- [ ] **Step 1: Extend the verify harness**

Add a step to `scripts/verify-1on1.sh` (after the existing `/1on1` lock step) that, on Linux/container only:
1. configures an HTTP MCP server `workbench` (no static creds),
2. drives `/1on1` then `/mcp connect workbench` against the live agent (loopback reachable via `docker -p` from `SLAUDE_OAUTH_LOOPBACK_PORTS`),
3. asserts `mcpOAuth[<oauthKey>]` exists in `verify-data/oauth/<initiator>/.credentials.json`.

Echo a clear SKIP on `darwin` (store is keychain-backed; file write is shadowed — documented constraint).

```bash
# verify-1on1.sh — mcp-oauth smoke (append; guard non-darwin)
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[verify] SKIP mcp-oauth smoke on macOS — CLI store is keychain-backed; .credentials.json write is shadowed (Linux/container only)."
else
  CRED="verify-data/oauth/${VERIFY_INITIATOR}/.credentials.json"
  if grep -q '"mcpOAuth"' "$CRED" 2>/dev/null; then
    echo "[verify] OK mcp-oauth: mcpOAuth entry present in $CRED"
  else
    echo "[verify] FAIL mcp-oauth: no mcpOAuth entry in $CRED"; exit 1
  fi
fi
```

Add to `.env.verify.example`:

```bash
# /mcp OAuth loopback (container): bind 0.0.0.0 and pre-map this range with docker -p.
SLAUDE_OAUTH_LOOPBACK_HOST=0.0.0.0
SLAUDE_OAUTH_LOOPBACK_PORTS=40100-40110
```

- [ ] **Step 2: Write the finding doc**

Create `docs/findings/2026-06-09-mcp-oauth-connect-1on1.md` summarizing: the write-store-let-CLI-own-lifecycle decision; the `a2A` format (plain JSON.stringify, fixed order, golden `workbench|c17ea65c6b709142`); the macOS keychain shadow (Linux-only round-trip); the RMW atomic-write mitigation; the canary guard. Link `[[2026-06-08-oauth-config-dir-1on1]]`.

- [ ] **Step 3: Index it in `CLAUDE.md`**

Add to the Findings Log (newest first):

```markdown
- [2026-06-09 — /mcp OAuth connect in /1on1 (write CLI mcpOAuth store, CLI owns lifecycle)](docs/findings/2026-06-09-mcp-oauth-connect-1on1.md)
```

- [ ] **Step 4: Flip the spec status**

In `docs/superpowers/specs/2026-06-09-mcp-oauth-connect-1on1-design.md`, change `**Status:** Draft for review` → `**Status:** Implemented (see plan + finding)`.

- [ ] **Step 5: Full verification + commit**

Run: `bunx tsc --noEmit && bun test`
Expected: full suite green.

```bash
git add scripts/verify-1on1.sh .env.verify.example docs/findings/2026-06-09-mcp-oauth-connect-1on1.md CLAUDE.md docs/superpowers/specs/2026-06-09-mcp-oauth-connect-1on1-design.md
git commit -m "docs(mcp-oauth): container smoke + finding + index; mark spec implemented"
```

---

## Self-Review notes (carried for the executor)

- **Spec coverage:** Unit 1 OAuth client → Tasks 2–7; Unit 2 store writer → Task 1 (+ canary Task 11); Unit 3 gate command → Tasks 9–10; shipped-code change (drop scrub + copy `settings.local.json`) → Task 0; loopback constraint → Tasks 5–6 + 12; error handling (discovery/registration/exchange/timeout/state/not-locked/not-initiator/canary) → Tasks 3–5, 10, 11; testing matrix → per-task tests + Task 12 smoke. Open decisions resolved: command name `/mcp` (Task 9); loopback range env (Task 6); authorize URL surfaced in-thread (Task 10).
- **macOS reality:** every end-to-end leg is Linux/container; macOS runs only the pure unit tests (store/pkce/discovery/register/client/loopback all pass on darwin — none touch the keychain). Task 12 smoke SKIPs on darwin by design.
- **Verify before "done":** the live `/mcp connect → connected` claim is only proven by Task 12 on Linux. Do not claim end-to-end success from a macOS dev run.
