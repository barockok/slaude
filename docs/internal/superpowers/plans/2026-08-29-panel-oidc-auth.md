# Panel OIDC Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the control panel's trusted-ingress-header auth with the panel acting as an OIDC relying party that mints its own session tokens and resolves operator roles from config.

**Architecture:** A new `src/gateway/panel/auth/` directory holds six focused modules — `oidc.ts` (provider protocol), `session.ts` (self-issued tokens + cookies), `roles.ts` (pure identity→role resolver), `routes.ts` (`/panel/auth/*`), `guard.ts` (per-request gate), `audit.ts` (JSON audit lines). `api.ts` swaps `authenticateOperator` for `guard.ts` and adds per-action role checks. No database and no user records: identity comes from an ID-token claim, roles from a YAML file or env lists.

**Tech Stack:** Bun + TypeScript, `node:crypto` (HS256, hand-rolled — no JWT library), `yaml` (already a dependency), Zod for body schemas, React 19 + Vite for the web app, Playwright for e2e, Docker Compose + Keycloak for the dev provider.

**Spec:** `docs/superpowers/specs/2026-08-29-panel-oidc-auth-design.md`

## Global Constraints

- **Public repo.** No real names, employers, org names, internal channel or service identifiers in code, tests, comments, docs, or commit messages. Use `example.com`, `alice@example.com`, `lead@example.com`.
- **No AI co-authorship trailers** in any commit. The `.githooks/commit-msg` hook enforces this.
- **Granular commits** — one logical change per commit, as each task's final step specifies.
- **Fail closed.** Every ambiguous auth outcome is a refusal. No authentication bypass flag may exist anywhere in the codebase.
- **Never logged:** tokens, cookie values, the authorization `code`, the client secret, chat message content.
- **HS256 only.** The header's `alg` is ignored on verification and HS256 is always enforced — mirroring `src/gateway/api/auth.ts`.
- **Branch:** `feat/session-control-panel` (PR #96, unmerged). This work lands as follow-up commits on that branch.
- **Test commands:** `bun test <path>` for server tests, `bun run typecheck` for types, `bun run test:web` for Playwright.
- Every cookie the panel sets is `HttpOnly; Secure; SameSite=Lax` with the path specified per cookie in Task 3.

---

### Task 1: Panel auth configuration and boot validation

Replaces the header-trust env surface with the OIDC surface, and makes a misconfigured panel refuse to start.

**Files:**
- Modify: `src/config/env.ts:287-308` (the `panel` block)
- Create: `src/gateway/panel/auth/config.ts`
- Test: `tests/panel/auth-config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `env.panel.oidcIssuer(): string`, `.oidcClientId(): string`, `.oidcClientSecret(): string`, `.publicUrl(): string`, `.secret(): string`, `.userClaim(): string`, `.rolesFile(): string`, `.superadmins(): string[]`, `.operators(): string[]` — all in `src/config/env.ts`.
  - `assertPanelConfig(): void` in `src/gateway/panel/auth/config.ts` — throws `Error` with an operator-readable message when the panel is enabled but misconfigured.
  - `panelRedirectUri(): string` in the same file — `${publicUrl}/panel/auth/callback`, with any trailing slash on `publicUrl` stripped.

- [ ] **Step 1: Write the failing test**

Create `tests/panel/auth-config.test.ts`:

```ts
import { afterEach, describe, it, expect } from "bun:test";
import { assertPanelConfig, panelRedirectUri } from "../../src/gateway/panel/auth/config";

const VARS = [
  "SLAUDE_PANEL",
  "SLAUDE_PANEL_OIDC_ISSUER",
  "SLAUDE_PANEL_OIDC_CLIENT_ID",
  "SLAUDE_PANEL_OIDC_CLIENT_SECRET",
  "SLAUDE_PANEL_PUBLIC_URL",
  "SLAUDE_PANEL_SECRET",
  "SLAUDE_PANEL_SUPERADMIN",
  "SLAUDE_PANEL_OPERATORS",
  "SLAUDE_PANEL_ALLOW",
  "SLAUDE_PANEL_ROLES_FILE",
];

afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

function configureValid() {
  process.env.SLAUDE_PANEL = "1";
  process.env.SLAUDE_PANEL_OIDC_ISSUER = "https://idp.example.com/realms/slaude";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_ID = "slaude-panel";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_SECRET = "s3cret";
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://panel.example.com/";
  process.env.SLAUDE_PANEL_SECRET = "x".repeat(32);
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
}

describe("panel auth config", () => {
  it("accepts a fully configured panel", () => {
    configureValid();
    expect(() => assertPanelConfig()).not.toThrow();
  });

  it("is a no-op when the panel is disabled", () => {
    expect(() => assertPanelConfig()).not.toThrow();
  });

  it("refuses each missing required variable by name", () => {
    for (const missing of [
      "SLAUDE_PANEL_OIDC_ISSUER",
      "SLAUDE_PANEL_OIDC_CLIENT_ID",
      "SLAUDE_PANEL_OIDC_CLIENT_SECRET",
      "SLAUDE_PANEL_PUBLIC_URL",
      "SLAUDE_PANEL_SECRET",
    ]) {
      configureValid();
      delete process.env[missing];
      expect(() => assertPanelConfig()).toThrow(new RegExp(missing));
    }
  });

  it("requires a secret of at least 32 characters", () => {
    configureValid();
    process.env.SLAUDE_PANEL_SECRET = "short";
    expect(() => assertPanelConfig()).toThrow(/at least 32/);
  });

  it("refuses when no role list yields any entry", () => {
    configureValid();
    delete process.env.SLAUDE_PANEL_SUPERADMIN;
    expect(() => assertPanelConfig()).toThrow(/SLAUDE_PANEL_SUPERADMIN/);
  });

  it("refuses a leftover SLAUDE_PANEL_ALLOW with a migration message", () => {
    configureValid();
    process.env.SLAUDE_PANEL_ALLOW = "lead@example.com";
    expect(() => assertPanelConfig()).toThrow(/SLAUDE_PANEL_ALLOW is no longer used/);
  });

  it("derives the redirect URI without a doubled slash", () => {
    configureValid();
    expect(panelRedirectUri()).toBe("https://panel.example.com/panel/auth/callback");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/panel/auth-config.test.ts`
Expected: FAIL — cannot resolve module `src/gateway/panel/auth/config`.

- [ ] **Step 3: Replace the `panel` block in `src/config/env.ts`**

Replace the whole existing `panel: { ... }` block (currently `enabled`, `header`, `allow`, `trustHeader`) with:

```ts
  /**
   * Session control panel (operator web surface, gateway-tier only). Mounts
   * `/panel/*` on the gateway Bun.serve when enabled and the role is not
   * `node`. The panel is its own OIDC relying party: it authenticates the
   * operator against a single issuer and mints its own session tokens. It
   * stores no operator records — roles come from `rolesFile` or the env lists.
   */
  panel: {
    /** Enable the panel surface. Default off. */
    enabled: () => {
      const raw = opt("SLAUDE_PANEL", "0").toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    },
    /** OIDC issuer URL; endpoints are read from its discovery document. */
    oidcIssuer: () => opt("SLAUDE_PANEL_OIDC_ISSUER").trim().replace(/\/+$/, ""),
    oidcClientId: () => opt("SLAUDE_PANEL_OIDC_CLIENT_ID").trim(),
    oidcClientSecret: () => opt("SLAUDE_PANEL_OIDC_CLIENT_SECRET"),
    /** Public base URL of this panel; the redirect URI is derived from it and
     *  must match the provider registration exactly. */
    publicUrl: () => opt("SLAUDE_PANEL_PUBLIC_URL").trim().replace(/\/+$/, ""),
    /** HMAC key for the session and flow cookies. */
    secret: () => opt("SLAUDE_PANEL_SECRET"),
    /** Which ID-token claim becomes the operator identity. */
    userClaim: () => opt("SLAUDE_PANEL_USER_CLAIM", "email").trim(),
    /** Role list file; empty string means "use $SLAUDE_HOME/panel-roles.yaml". */
    rolesFile: () => opt("SLAUDE_PANEL_ROLES_FILE").trim(),
    /** Env fallbacks used only when the roles file is absent. */
    superadmins: () => csv(opt("SLAUDE_PANEL_SUPERADMIN")),
    operators: () => csv(opt("SLAUDE_PANEL_OPERATORS")),
  },
```

Add this helper next to `opt` near the top of the file (after the `opt` definition at line 28-30):

```ts
/** Split a comma-separated env list into trimmed, non-empty entries. */
function csv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
```

- [ ] **Step 4: Create `src/gateway/panel/auth/config.ts`**

```ts
/**
 * Boot-time configuration guard for panel auth.
 *
 * The panel is fail-closed by construction: with SLAUDE_PANEL=1, any missing
 * required setting stops the process rather than serving a half-configured
 * auth surface. Called once from server.ts before the panel is mounted.
 */
import { env } from "../../../config/env";

/** The redirect URI registered with the identity provider. */
export function panelRedirectUri(): string {
  return `${env.panel.publicUrl()}/panel/auth/callback`;
}

const REQUIRED: Array<[name: string, read: () => string]> = [
  ["SLAUDE_PANEL_OIDC_ISSUER", () => env.panel.oidcIssuer()],
  ["SLAUDE_PANEL_OIDC_CLIENT_ID", () => env.panel.oidcClientId()],
  ["SLAUDE_PANEL_OIDC_CLIENT_SECRET", () => env.panel.oidcClientSecret()],
  ["SLAUDE_PANEL_PUBLIC_URL", () => env.panel.publicUrl()],
  ["SLAUDE_PANEL_SECRET", () => env.panel.secret()],
];

/**
 * Validate the panel auth configuration. Throws with an operator-readable
 * message when the panel is enabled but cannot serve safely. No-op when the
 * panel is disabled.
 */
export function assertPanelConfig(): void {
  if (!env.panel.enabled()) return;

  // The header-trust surface is gone; a leftover allowlist would silently stop
  // granting the access its operator believes it grants.
  if (process.env.SLAUDE_PANEL_ALLOW) {
    throw new Error(
      "SLAUDE_PANEL_ALLOW is no longer used — the panel now authenticates via OIDC and reads roles from " +
        "SLAUDE_PANEL_ROLES_FILE (or SLAUDE_PANEL_SUPERADMIN / SLAUDE_PANEL_OPERATORS). Remove it.",
    );
  }
  for (const [name, read] of REQUIRED) {
    if (!read()) throw new Error(`${name} is required when SLAUDE_PANEL=1`);
  }
  if (env.panel.secret().length < 32) {
    throw new Error("SLAUDE_PANEL_SECRET must be at least 32 characters");
  }
  // A panel nobody can reach is a misconfiguration, not a safe default. The
  // roles file is checked in roles.ts at load time; here we only guarantee
  // that *some* source is configured.
  const hasFile = env.panel.rolesFile().length > 0;
  if (!hasFile && env.panel.superadmins().length === 0 && env.panel.operators().length === 0) {
    throw new Error(
      "no panel operators configured: set SLAUDE_PANEL_SUPERADMIN (and/or SLAUDE_PANEL_OPERATORS), " +
        "or point SLAUDE_PANEL_ROLES_FILE at a role list",
    );
  }
}
```

Note: this task's check treats a configured `rolesFile` as sufficient; Task 2 validates the file's contents at load.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/panel/auth-config.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/gateway/panel/auth/config.ts tests/panel/auth-config.test.ts
git commit -m "feat(panel): OIDC config surface + fail-closed boot validation

Replaces the header-trust env block with the OIDC settings. Any missing
required variable, a short secret, an empty role source, or a leftover
SLAUDE_PANEL_ALLOW now stops the process instead of serving a
half-configured auth surface."
```

---

### Task 2: Role resolver

Pure identity→role resolution over a YAML file with env fallback, cached by mtime.

**Files:**
- Create: `src/gateway/panel/auth/roles.ts`
- Test: `tests/panel/roles.test.ts`

**Interfaces:**
- Consumes: `env.panel.rolesFile()`, `.superadmins()`, `.operators()` (Task 1).
- Produces:
  - `type PanelRole = "superadmin" | "operator"`
  - `interface RoleConfig { superadmin: string[]; operator: string[] }`
  - `parseRoleConfig(yamlText: string): RoleConfig` — throws on malformed input
  - `resolveRole(identity: string, cfg: RoleConfig): PanelRole | null`
  - `loadRoleConfig(): RoleConfig` — mtime-cached file read, env fallback
  - `resolveRoleForIdentity(identity: string): PanelRole | null` — the convenience used by `guard.ts` and `routes.ts`
  - `__resetRoleCache(): void` — test hook

- [ ] **Step 1: Write the failing test**

Create `tests/panel/roles.test.ts`:

```ts
import { afterEach, describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseRoleConfig,
  resolveRole,
  loadRoleConfig,
  resolveRoleForIdentity,
  __resetRoleCache,
} from "../../src/gateway/panel/auth/roles";

const dir = mkdtempSync(join(tmpdir(), "slaude-roles-"));
const write = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

afterEach(() => {
  delete process.env.SLAUDE_PANEL_ROLES_FILE;
  delete process.env.SLAUDE_PANEL_SUPERADMIN;
  delete process.env.SLAUDE_PANEL_OPERATORS;
  __resetRoleCache();
});

describe("parseRoleConfig", () => {
  it("parses both lists", () => {
    const cfg = parseRoleConfig("superadmin:\n  - lead@example.com\noperator:\n  - alice@example.com\n");
    expect(cfg.superadmin).toEqual(["lead@example.com"]);
    expect(cfg.operator).toEqual(["alice@example.com"]);
  });

  it("tolerates a missing list", () => {
    expect(parseRoleConfig("superadmin:\n  - lead@example.com\n").operator).toEqual([]);
  });

  it("throws on a non-mapping document", () => {
    expect(() => parseRoleConfig("- just\n- a list\n")).toThrow(/mapping/);
  });

  it("throws when a list holds a non-string", () => {
    expect(() => parseRoleConfig("operator:\n  - 42\n")).toThrow(/string/);
  });
});

describe("resolveRole", () => {
  const cfg = { superadmin: ["Lead@Example.com"], operator: ["alice@example.com"] };

  it("matches case-insensitively", () => {
    expect(resolveRole("lead@EXAMPLE.com", cfg)).toBe("superadmin");
    expect(resolveRole("Alice@example.com", cfg)).toBe("operator");
  });

  it("returns null for an unlisted identity", () => {
    expect(resolveRole("eve@example.com", cfg)).toBeNull();
  });

  it("returns null for an empty identity", () => {
    expect(resolveRole("", cfg)).toBeNull();
  });

  it("prefers superadmin when listed in both", () => {
    expect(resolveRole("both@example.com", {
      superadmin: ["both@example.com"],
      operator: ["both@example.com"],
    })).toBe("superadmin");
  });
});

describe("loadRoleConfig", () => {
  it("reads the configured file", () => {
    process.env.SLAUDE_PANEL_ROLES_FILE = write("ok.yaml", "operator:\n  - alice@example.com\n");
    expect(loadRoleConfig().operator).toEqual(["alice@example.com"]);
  });

  it("falls back to env lists when no file is configured", () => {
    process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
    process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com, bob@example.com";
    const cfg = loadRoleConfig();
    expect(cfg.superadmin).toEqual(["lead@example.com"]);
    expect(cfg.operator).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("throws when the configured file is absent", () => {
    process.env.SLAUDE_PANEL_ROLES_FILE = join(dir, "nope.yaml");
    expect(() => loadRoleConfig()).toThrow(/panel role file/);
  });

  it("throws on malformed YAML with no previously good config", () => {
    process.env.SLAUDE_PANEL_ROLES_FILE = write("bad.yaml", "operator:\n  - [unclosed\n");
    expect(() => loadRoleConfig()).toThrow();
  });

  it("keeps the last good config when the file becomes malformed", () => {
    const p = write("live.yaml", "operator:\n  - alice@example.com\n");
    process.env.SLAUDE_PANEL_ROLES_FILE = p;
    expect(loadRoleConfig().operator).toEqual(["alice@example.com"]);
    writeFileSync(p, "operator:\n  - [unclosed\n");
    expect(loadRoleConfig().operator).toEqual(["alice@example.com"]);
  });

  it("picks up a role change without a restart", () => {
    const p = write("change.yaml", "operator:\n  - alice@example.com\n");
    process.env.SLAUDE_PANEL_ROLES_FILE = p;
    expect(resolveRoleForIdentity("alice@example.com")).toBe("operator");
    writeFileSync(p, "superadmin:\n  - alice@example.com\n");
    expect(resolveRoleForIdentity("alice@example.com")).toBe("superadmin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/panel/roles.test.ts`
Expected: FAIL — cannot resolve module `src/gateway/panel/auth/roles`.

- [ ] **Step 3: Create `src/gateway/panel/auth/roles.ts`**

```ts
/**
 * Operator role resolution (design §Authorization).
 *
 * Roles are declared by the deployment operator, never derived from provider
 * claims and never stored: a YAML file of two lists, or env fallbacks. The
 * resolver is pure — it knows nothing of HTTP, cookies, crypto, or the
 * provider — and is re-run on every request so a demotion lands immediately
 * rather than at the next token refresh.
 *
 * Failure policy is asymmetric on purpose. A malformed file at boot is fatal
 * (Task 1's guard plus the throw below). A file that *becomes* malformed while
 * running keeps the last good config: a typo mid-shift must not lock every
 * operator out of a live fleet.
 */
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { env } from "../../../config/env";
import { SLAUDE_HOME } from "../../../config/home";

export type PanelRole = "superadmin" | "operator";

export interface RoleConfig {
  superadmin: string[];
  operator: string[];
}

function readList(doc: Record<string, unknown>, key: keyof RoleConfig): string[] {
  const raw = doc[key];
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`panel role file: '${key}' must be a list`);
  return raw.map((v) => {
    if (typeof v !== "string") throw new Error(`panel role file: '${key}' entries must be string identities`);
    return v.trim();
  }).filter(Boolean);
}

/** Parse a role file's text. Throws on anything that is not two string lists. */
export function parseRoleConfig(yamlText: string): RoleConfig {
  const doc = parseYaml(yamlText);
  if (doc == null) return { superadmin: [], operator: [] };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("panel role file: top level must be a mapping of role name to list");
  }
  const rec = doc as Record<string, unknown>;
  return { superadmin: readList(rec, "superadmin"), operator: readList(rec, "operator") };
}

/** Identity → role. Exact, case-insensitive; superadmin wins over operator. */
export function resolveRole(identity: string, cfg: RoleConfig): PanelRole | null {
  const needle = identity.trim().toLowerCase();
  if (!needle) return null;
  if (cfg.superadmin.some((e) => e.toLowerCase() === needle)) return "superadmin";
  if (cfg.operator.some((e) => e.toLowerCase() === needle)) return "operator";
  return null;
}

let cached: { mtimeMs: number; path: string; cfg: RoleConfig } | null = null;

/** Test hook: forget the mtime cache. */
export function __resetRoleCache(): void {
  cached = null;
}

function rolesPath(): string | null {
  const explicit = env.panel.rolesFile();
  if (explicit) return explicit;
  const fallback = join(SLAUDE_HOME, "panel-roles.yaml");
  try {
    statSync(fallback);
    return fallback;
  } catch {
    return null;
  }
}

/**
 * Current role config. Reads the file when its mtime changed; falls back to the
 * env lists when no file is configured or discoverable.
 */
export function loadRoleConfig(): RoleConfig {
  const path = rolesPath();
  if (!path) return { superadmin: env.panel.superadmins(), operator: env.panel.operators() };

  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    if (cached && cached.path === path) return cached.cfg;
    throw new Error(`panel role file not readable: ${path}`);
  }
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.cfg;

  try {
    const cfg = parseRoleConfig(readFileSync(path, "utf8"));
    cached = { mtimeMs, path, cfg };
    return cfg;
  } catch (e) {
    // Keep serving the last good config; a live fleet must not lose every
    // operator to one bad edit.
    console.error(`[panel] role file invalid, keeping last good config: ${(e as Error).message}`);
    if (cached && cached.path === path) return cached.cfg;
    throw e;
  }
}

/** Convenience used by the guard and the auth routes. */
export function resolveRoleForIdentity(identity: string): PanelRole | null {
  return resolveRole(identity, loadRoleConfig());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/panel/roles.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/panel/auth/roles.ts tests/panel/roles.test.ts
git commit -m "feat(panel): config-declared operator roles

Identity resolves to superadmin | operator | null from a YAML role file
(env lists as fallback), re-read on mtime change so granting access is a
file edit rather than a redeploy. Malformed YAML at runtime keeps the
last good config — one bad edit must not lock out a live fleet."
```

---

### Task 3: Session tokens and cookies

The self-issued access/refresh pair and the cookie helpers.

**Files:**
- Create: `src/gateway/panel/auth/session.ts`
- Test: `tests/panel/session.test.ts`

**Interfaces:**
- Consumes: `env.panel.secret()` (Task 1).
- Produces:
  - `const AT_COOKIE = "panel_at"`, `RT_COOKIE = "panel_rt"`, `FLOW_COOKIE = "panel_flow"`
  - `const AT_PATH = "/panel"`, `RT_PATH = "/panel/auth/refresh"`, `FLOW_PATH = "/panel/auth"`
  - `const AT_TTL_SEC = 900`, `RT_TTL_SEC = 28800`, `FLOW_TTL_SEC = 600`
  - `type TokenType = "at" | "rt" | "flow"`
  - `interface SessionClaims { sub: string; email: string; typ: TokenType; iat: number; exp: number; jti?: string }`
  - `mintSession(claims: { sub: string; email: string }, typ: "at" | "rt", opts?: { secret?: string; now?: number; ttlSec?: number }): string`
  - `mintFlow(payload: FlowPayload, opts?): string` where `interface FlowPayload { state: string; nonce: string; verifier: string; returnTo: string }`
  - `verifySession(token, expect: "at" | "rt", opts?): { ok: true; claims: SessionClaims } | { ok: false; reason: VerifyReason }`
  - `verifyFlow(token, opts?): { ok: true; payload: FlowPayload } | { ok: false; reason: VerifyReason }`
  - `type VerifyReason = "missing" | "malformed" | "bad_signature" | "expired" | "wrong_type" | "unconfigured"`
  - `setCookie(name: string, value: string, opts: { path: string; maxAgeSec: number }): string`
  - `clearCookie(name: string, path: string): string`
  - `parseCookies(header: string | null): Record<string, string>`

- [ ] **Step 1: Write the failing test**

Create `tests/panel/session.test.ts`:

```ts
import { afterEach, describe, it, expect } from "bun:test";
import {
  mintSession, verifySession, mintFlow, verifyFlow,
  setCookie, clearCookie, parseCookies,
  AT_COOKIE, RT_COOKIE, AT_PATH, RT_PATH, AT_TTL_SEC,
} from "../../src/gateway/panel/auth/session";

const SECRET = "y".repeat(32);
const OTHER = "z".repeat(32);
const who = { sub: "provider-sub-1", email: "alice@example.com" };

afterEach(() => {
  delete process.env.SLAUDE_PANEL_SECRET;
});

describe("session tokens", () => {
  it("round-trips an access token", () => {
    const t = mintSession(who, "at", { secret: SECRET });
    const r = verifySession(t, "at", { secret: SECRET });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.email).toBe("alice@example.com");
      expect(r.claims.sub).toBe("provider-sub-1");
      expect(r.claims.typ).toBe("at");
      expect(r.claims.exp - r.claims.iat).toBe(AT_TTL_SEC);
    }
  });

  it("mints a jti unique per access token", () => {
    const a = verifySession(mintSession(who, "at", { secret: SECRET }), "at", { secret: SECRET });
    const b = verifySession(mintSession(who, "at", { secret: SECRET }), "at", { secret: SECRET });
    expect(a.ok && b.ok && a.claims.jti !== b.claims.jti).toBe(true);
  });

  it("refuses a refresh token presented as an access token", () => {
    const rt = mintSession(who, "rt", { secret: SECRET });
    const r = verifySession(rt, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_type");
  });

  it("refuses a token signed with a different secret", () => {
    const t = mintSession(who, "at", { secret: OTHER });
    const r = verifySession(t, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("refuses a tampered payload", () => {
    const t = mintSession(who, "at", { secret: SECRET });
    const [h, , s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...who, typ: "at", iat: 1, exp: 9e9 })).toString("base64url");
    const r = verifySession(`${h}.${forged}.${s}`, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("refuses an expired token", () => {
    const past = Date.now() - (AT_TTL_SEC + 60) * 1000;
    const t = mintSession(who, "at", { secret: SECRET, now: past });
    const r = verifySession(t, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("enforces HS256 regardless of the header alg", () => {
    // An 'alg: none' header with a valid HS256 signature must still verify as
    // HS256; an unsigned token must not verify at all.
    const payload = Buffer.from(JSON.stringify({ ...who, typ: "at", iat: 1, exp: 9e9 })).toString("base64url");
    const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const r = verifySession(`${head}.${payload}.`, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("reports missing and malformed distinctly", () => {
    const miss = verifySession(null, "at", { secret: SECRET });
    expect(miss.ok === false && miss.reason).toBe("missing");
    const bad = verifySession("not-a-token", "at", { secret: SECRET });
    expect(bad.ok === false && bad.reason).toBe("malformed");
  });

  it("reports unconfigured when no secret is set", () => {
    const r = verifySession("a.b.c", "at", {});
    expect(r.ok === false && r.reason).toBe("unconfigured");
  });
});

describe("flow token", () => {
  it("round-trips the login flow payload", () => {
    const p = { state: "st", nonce: "no", verifier: "ve", returnTo: "/panel/sessions/S-1" };
    const r = verifyFlow(mintFlow(p, { secret: SECRET }), { secret: SECRET });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual(p);
  });

  it("refuses a tampered flow token", () => {
    const t = mintFlow({ state: "st", nonce: "no", verifier: "ve", returnTo: "/panel" }, { secret: SECRET });
    const r = verifyFlow(t.replace(/\.[^.]+$/, ".deadbeef"), { secret: SECRET });
    expect(r.ok).toBe(false);
  });
});

describe("cookies", () => {
  it("sets the required flags and path", () => {
    const c = setCookie(AT_COOKIE, "v", { path: AT_PATH, maxAgeSec: 900 });
    expect(c).toContain("panel_at=v");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/panel");
    expect(c).toContain("Max-Age=900");
  });

  it("scopes the refresh cookie to its own endpoint", () => {
    expect(setCookie(RT_COOKIE, "v", { path: RT_PATH, maxAgeSec: 10 })).toContain("Path=/panel/auth/refresh");
  });

  it("clears with an immediate expiry", () => {
    const c = clearCookie(AT_COOKIE, AT_PATH);
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Path=/panel");
  });

  it("parses a cookie header", () => {
    const jar = parseCookies("panel_at=abc; panel_rt=def; other=1");
    expect(jar.panel_at).toBe("abc");
    expect(jar.panel_rt).toBe("def");
  });

  it("parses an absent header as empty", () => {
    expect(parseCookies(null)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/panel/session.test.ts`
Expected: FAIL — cannot resolve module `src/gateway/panel/auth/session`.

- [ ] **Step 3: Create `src/gateway/panel/auth/session.ts`**

```ts
/**
 * Self-issued panel session tokens (design §Data flow).
 *
 * The panel mints its own credentials so the identity provider is contacted
 * only during login. Two token types share one format and one secret,
 * distinguished by a `typ` claim so a refresh token can never be replayed as an
 * access token. A third, `flow`, carries the login round-trip state — there is
 * no server-side store to keep it in.
 *
 * HS256 over node:crypto rather than a JWT library: we are both minter and
 * verifier, so no algorithm negotiation surface should exist. The header's
 * `alg` is ignored and HS256 is always enforced, mirroring
 * src/gateway/api/auth.ts.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../../config/env";

export const AT_COOKIE = "panel_at";
export const RT_COOKIE = "panel_rt";
export const FLOW_COOKIE = "panel_flow";

export const AT_PATH = "/panel";
export const RT_PATH = "/panel/auth/refresh";
export const FLOW_PATH = "/panel/auth";

export const AT_TTL_SEC = 15 * 60;
/** Absolute, not sliding: refresh never re-issues the refresh cookie. */
export const RT_TTL_SEC = 8 * 60 * 60;
export const FLOW_TTL_SEC = 10 * 60;

export type TokenType = "at" | "rt" | "flow";

export interface SessionClaims {
  sub: string;
  email: string;
  typ: TokenType;
  iat: number;
  exp: number;
  jti?: string;
}

export interface FlowPayload {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

export type VerifyReason = "missing" | "malformed" | "bad_signature" | "expired" | "wrong_type" | "unconfigured";

const b64uJson = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

function sign(headerAndPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(headerAndPayload).digest("base64url");
}

/** Constant-time equality; hashing first equalizes lengths. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function encode(payload: object, secret: string): string {
  const head = b64uJson({ alg: "HS256", typ: "JWT" });
  const body = b64uJson(payload);
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

function decode<T>(
  token: string | null | undefined,
  secret: string | undefined,
  nowMs: number,
): { ok: true; payload: T & { exp: number } } | { ok: false; reason: VerifyReason } {
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];
  if (!timingSafeStringEqual(sign(`${head}.${body}`, secret), sig)) return { ok: false, reason: "bad_signature" };
  let payload: T & { exp: number };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

const ttlFor = (typ: "at" | "rt") => (typ === "at" ? AT_TTL_SEC : RT_TTL_SEC);

export function mintSession(
  who: { sub: string; email: string },
  typ: "at" | "rt",
  opts: { secret?: string; now?: number; ttlSec?: number } = {},
): string {
  const secret = opts.secret ?? env.panel.secret();
  if (!secret) throw new Error("SLAUDE_PANEL_SECRET is not set — cannot mint panel sessions");
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: SessionClaims = {
    sub: who.sub,
    email: who.email,
    typ,
    iat,
    exp: iat + (opts.ttlSec ?? ttlFor(typ)),
    ...(typ === "at" ? { jti: randomBytes(9).toString("base64url") } : {}),
  };
  return encode(claims, secret);
}

export function verifySession(
  token: string | null | undefined,
  expect: "at" | "rt",
  opts: { secret?: string; now?: number } = {},
): { ok: true; claims: SessionClaims } | { ok: false; reason: VerifyReason } {
  const r = decode<SessionClaims>(token, opts.secret ?? env.panel.secret(), opts.now ?? Date.now());
  if (!r.ok) return r;
  const claims = r.payload as SessionClaims;
  if (typeof claims.email !== "string" || typeof claims.sub !== "string") return { ok: false, reason: "malformed" };
  if (claims.typ !== expect) return { ok: false, reason: "wrong_type" };
  return { ok: true, claims };
}

export function mintFlow(payload: FlowPayload, opts: { secret?: string; now?: number } = {}): string {
  const secret = opts.secret ?? env.panel.secret();
  if (!secret) throw new Error("SLAUDE_PANEL_SECRET is not set — cannot mint panel sessions");
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  return encode({ ...payload, typ: "flow" as const, iat, exp: iat + FLOW_TTL_SEC }, secret);
}

export function verifyFlow(
  token: string | null | undefined,
  opts: { secret?: string; now?: number } = {},
): { ok: true; payload: FlowPayload } | { ok: false; reason: VerifyReason } {
  const r = decode<FlowPayload & { typ: TokenType }>(token, opts.secret ?? env.panel.secret(), opts.now ?? Date.now());
  if (!r.ok) return r;
  const p = r.payload;
  if (p.typ !== "flow") return { ok: false, reason: "wrong_type" };
  for (const k of ["state", "nonce", "verifier", "returnTo"] as const) {
    if (typeof p[k] !== "string") return { ok: false, reason: "malformed" };
  }
  return { ok: true, payload: { state: p.state, nonce: p.nonce, verifier: p.verifier, returnTo: p.returnTo } };
}

export function setCookie(name: string, value: string, opts: { path: string; maxAgeSec: number }): string {
  return `${name}=${value}; Max-Age=${opts.maxAgeSec}; Path=${opts.path}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/panel/session.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/panel/auth/session.ts tests/panel/session.test.ts
git commit -m "feat(panel): self-issued session tokens and cookie helpers

HS256 over node:crypto (no JWT library, no alg negotiation surface). A
typ claim separates access, refresh, and login-flow tokens so a refresh
token cannot be replayed as an access token. Cookies are HttpOnly +
Secure + SameSite=Lax, with the refresh cookie scoped to its own path."
```

---

### Task 4: JSON audit records

**Files:**
- Create: `src/gateway/panel/auth/audit.ts`
- Test: `tests/panel/audit.test.ts`

**Interfaces:**
- Consumes: `PanelRole` (Task 2).
- Produces:
  - `interface AuditRecord { action: string; operator: string; role?: PanelRole | null; session?: string; outcome?: "ok" | "denied" | "error"; detail?: Record<string, unknown> }`
  - `audit(rec: AuditRecord, sink?: (line: string) => void): void`

- [ ] **Step 1: Write the failing test**

Create `tests/panel/audit.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { audit } from "../../src/gateway/panel/auth/audit";

function capture(fn: (sink: (l: string) => void) => void): string[] {
  const lines: string[] = [];
  fn((l) => lines.push(l));
  return lines;
}

describe("panel audit", () => {
  it("emits one line of valid JSON", () => {
    const [line] = capture((sink) =>
      audit({ action: "control.reset", operator: "lead@example.com", role: "superadmin", session: "S-1" }, sink),
    );
    expect(line!.includes("\n")).toBe(false);
    const rec = JSON.parse(line!);
    expect(rec.evt).toBe("panel.audit");
    expect(rec.action).toBe("control.reset");
    expect(rec.operator).toBe("lead@example.com");
    expect(rec.role).toBe("superadmin");
    expect(rec.session).toBe("S-1");
    expect(rec.outcome).toBe("ok");
    expect(typeof rec.ts).toBe("string");
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
  });

  it("omits session and detail when absent", () => {
    const [line] = capture((sink) => audit({ action: "auth.login", operator: "alice@example.com" }, sink));
    const rec = JSON.parse(line!);
    expect("session" in rec).toBe(false);
    expect("detail" in rec).toBe(false);
  });

  it("carries a denied outcome and detail", () => {
    const [line] = capture((sink) =>
      audit(
        { action: "force-release", operator: "alice@example.com", role: "operator", session: "S-2",
          outcome: "denied", detail: { required: "superadmin" } },
        sink,
      ),
    );
    const rec = JSON.parse(line!);
    expect(rec.outcome).toBe("denied");
    expect(rec.detail).toEqual({ required: "superadmin" });
  });

  it("drops undefined detail values rather than emitting nulls", () => {
    const [line] = capture((sink) =>
      audit({ action: "control.model", operator: "a@example.com", detail: { model: "m", mode: undefined } }, sink),
    );
    expect(JSON.parse(line!).detail).toEqual({ model: "m" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/panel/audit.test.ts`
Expected: FAIL — cannot resolve module `src/gateway/panel/auth/audit`.

- [ ] **Step 3: Create `src/gateway/panel/auth/audit.ts`**

```ts
/**
 * Panel audit records (design §Audit records).
 *
 * One JSON object per line on stdout — no pretty-printing, so log pipelines can
 * split on newlines. Because the panel keeps no database, this is the only
 * record of operator actions.
 *
 * Never pass tokens, cookie values, the authorization code, the client secret,
 * or chat message content into `detail`.
 */
import type { PanelRole } from "./roles";

export interface AuditRecord {
  /** Dotted action name, e.g. "auth.login", "control.reset", "force-release". */
  action: string;
  operator: string;
  role?: PanelRole | null;
  session?: string;
  outcome?: "ok" | "denied" | "error";
  detail?: Record<string, unknown>;
}

export function audit(rec: AuditRecord, sink: (line: string) => void = console.log): void {
  const detail = rec.detail
    ? Object.fromEntries(Object.entries(rec.detail).filter(([, v]) => v !== undefined))
    : undefined;
  sink(
    JSON.stringify({
      ts: new Date().toISOString(),
      evt: "panel.audit",
      action: rec.action,
      operator: rec.operator,
      ...(rec.role !== undefined ? { role: rec.role } : {}),
      ...(rec.session ? { session: rec.session } : {}),
      outcome: rec.outcome ?? "ok",
      ...(detail && Object.keys(detail).length ? { detail } : {}),
    }),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/panel/audit.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/panel/auth/audit.ts tests/panel/audit.test.ts
git commit -m "feat(panel): JSON audit records on stdout

One object per line so log pipelines can split on newlines. With no
database, this is the only record of operator actions."
```

---

### Task 5: OIDC protocol module

Discovery, the authorize URL, the code exchange, and ID-token claim validation.

**Files:**
- Create: `src/gateway/panel/auth/oidc.ts`
- Test: `tests/panel/oidc.test.ts`

**Interfaces:**
- Consumes: `env.panel.*` and `panelRedirectUri()` (Task 1).
- Produces:
  - `interface OidcConfig { issuer: string; clientId: string; clientSecret: string; redirectUri: string; userClaim: string }`
  - `oidcConfigFromEnv(): OidcConfig`
  - `interface Discovery { authorization_endpoint: string; token_endpoint: string }`
  - `discover(issuer: string, opts?: { fetchImpl?: typeof fetch; now?: number }): Promise<Discovery>` — cached per issuer for 10 minutes
  - `__resetDiscoveryCache(): void`
  - `newFlowSecrets(): { state: string; nonce: string; verifier: string }`
  - `buildAuthorizeUrl(d: Discovery, cfg: OidcConfig, s: { state: string; nonce: string; verifier: string }): string`
  - `exchangeCode(d: Discovery, cfg: OidcConfig, args: { code: string; verifier: string }, opts?: { fetchImpl?: typeof fetch }): Promise<{ idToken: string }>`
  - `identityFromIdToken(idToken: string, cfg: OidcConfig, args: { nonce: string; now?: number }): { ok: true; sub: string; identity: string } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/panel/oidc.test.ts`:

```ts
import { afterEach, describe, it, expect } from "bun:test";
import {
  discover, __resetDiscoveryCache, newFlowSecrets, buildAuthorizeUrl,
  exchangeCode, identityFromIdToken, type OidcConfig,
} from "../../src/gateway/panel/auth/oidc";

const CFG: OidcConfig = {
  issuer: "https://idp.example.com/realms/slaude",
  clientId: "slaude-panel",
  clientSecret: "s3cret",
  redirectUri: "https://panel.example.com/panel/auth/callback",
  userClaim: "email",
};
const DISCO = {
  authorization_endpoint: "https://idp.example.com/realms/slaude/protocol/openid-connect/auth",
  token_endpoint: "https://idp.example.com/realms/slaude/protocol/openid-connect/token",
};

// Unsigned ID token: the panel reads claims from the token-endpoint response
// over TLS and never verifies a signature (design §Why no JWKS verification).
function idToken(claims: Record<string, unknown>): string {
  const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(claims)}.sig`;
}
const baseClaims = (over: Record<string, unknown> = {}) => ({
  iss: CFG.issuer, aud: CFG.clientId, nonce: "N1", sub: "sub-1",
  email: "Alice@Example.com", exp: Math.floor(Date.now() / 1000) + 300, ...over,
});

afterEach(() => __resetDiscoveryCache());

describe("discovery", () => {
  it("fetches and caches the discovery document", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL) => {
      calls++;
      expect(String(url)).toBe(`${CFG.issuer}/.well-known/openid-configuration`);
      return new Response(JSON.stringify(DISCO), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await discover(CFG.issuer, { fetchImpl })).token_endpoint).toBe(DISCO.token_endpoint);
    await discover(CFG.issuer, { fetchImpl });
    expect(calls).toBe(1);
  });

  it("throws when discovery is unreachable", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(discover(CFG.issuer, { fetchImpl })).rejects.toThrow(/discovery/i);
  });

  it("throws when the document lacks the endpoints", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(discover(CFG.issuer, { fetchImpl })).rejects.toThrow(/endpoint/);
  });
});

describe("authorize URL", () => {
  it("carries PKCE S256, scope, state and nonce", () => {
    const s = { state: "ST", nonce: "NO", verifier: "V".repeat(43) };
    const u = new URL(buildAuthorizeUrl(DISCO, CFG, s));
    expect(u.origin + u.pathname).toBe(DISCO.authorization_endpoint);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(CFG.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("state")).toBe("ST");
    expect(u.searchParams.get("nonce")).toBe("NO");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const ch = u.searchParams.get("code_challenge")!;
    expect(ch).not.toBe(s.verifier);
    expect(ch).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates distinct high-entropy secrets", () => {
    const a = newFlowSecrets();
    const b = newFlowSecrets();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe("code exchange", () => {
  it("posts the code and verifier, returning the id_token", async () => {
    let body = "";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(DISCO.token_endpoint);
      expect(init?.method).toBe("POST");
      body = String(init?.body);
      return new Response(JSON.stringify({ id_token: "ID", access_token: "AT" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await exchangeCode(DISCO, CFG, { code: "C", verifier: "V" }, { fetchImpl });
    expect(r.idToken).toBe("ID");
    const p = new URLSearchParams(body);
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("code")).toBe("C");
    expect(p.get("code_verifier")).toBe("V");
    expect(p.get("client_id")).toBe(CFG.clientId);
    expect(p.get("client_secret")).toBe(CFG.clientSecret);
    expect(p.get("redirect_uri")).toBe(CFG.redirectUri);
  });

  it("throws without leaking the response body when the provider rejects", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode(DISCO, CFG, { code: "C", verifier: "V" }, { fetchImpl }))
      .rejects.toThrow(/invalid_grant/);
  });

  it("throws when the response carries no id_token", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "AT" }), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeCode(DISCO, CFG, { code: "C", verifier: "V" }, { fetchImpl })).rejects.toThrow(/id_token/);
  });
});

describe("identity extraction", () => {
  it("lowercases the identity claim and returns the subject", () => {
    const r = identityFromIdToken(idToken(baseClaims()), CFG, { nonce: "N1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toBe("alice@example.com");
      expect(r.sub).toBe("sub-1");
    }
  });

  it("accepts an aud array containing the client id", () => {
    const r = identityFromIdToken(idToken(baseClaims({ aud: ["other", CFG.clientId] })), CFG, { nonce: "N1" });
    expect(r.ok).toBe(true);
  });

  for (const [label, claims, reason] of [
    ["a wrong issuer", baseClaims({ iss: "https://evil.example.com" }), "iss"],
    ["a wrong audience", baseClaims({ aud: "someone-else" }), "aud"],
    ["a mismatched nonce", baseClaims({ nonce: "OTHER" }), "nonce"],
    ["an expired token", baseClaims({ exp: Math.floor(Date.now() / 1000) - 10 }), "exp"],
    ["a missing identity claim", baseClaims({ email: undefined }), "claim"],
  ] as const) {
    it(`refuses ${label}`, () => {
      const r = identityFromIdToken(idToken(claims), CFG, { nonce: "N1" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(reason);
    });
  }

  it("refuses a malformed token", () => {
    const r = identityFromIdToken("garbage", CFG, { nonce: "N1" });
    expect(r.ok).toBe(false);
  });

  it("honours a custom user claim", () => {
    const cfg = { ...CFG, userClaim: "preferred_username" };
    const r = identityFromIdToken(idToken(baseClaims({ preferred_username: "Alice" })), cfg, { nonce: "N1" });
    expect(r.ok && r.identity).toBe("alice");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/panel/oidc.test.ts`
Expected: FAIL — cannot resolve module `src/gateway/panel/auth/oidc`.

- [ ] **Step 3: Create `src/gateway/panel/auth/oidc.ts`**

```ts
/**
 * OIDC relying-party protocol for the panel (design §Data flow).
 *
 * Provider-agnostic: Google and Keycloak differ only in the issuer URL, and
 * every endpoint is read from the issuer's discovery document.
 *
 * The ID token's signature is deliberately NOT verified. It is only ever
 * received as the direct response to the server-to-server code exchange over
 * TLS with the client secret, which OIDC Core §3.1.3.7 permits treating as
 * verified. This holds ONLY while the panel never accepts a provider token
 * from a client — if a route ever takes a bearer ID token, JWKS verification
 * becomes mandatory (see src/knowledge/server/oauth-guard.ts for that pattern).
 */
import { createHash, randomBytes } from "node:crypto";
import { env } from "../../../config/env";
import { panelRedirectUri } from "./config";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userClaim: string;
}

export function oidcConfigFromEnv(): OidcConfig {
  return {
    issuer: env.panel.oidcIssuer(),
    clientId: env.panel.oidcClientId(),
    clientSecret: env.panel.oidcClientSecret(),
    redirectUri: panelRedirectUri(),
    userClaim: env.panel.userClaim(),
  };
}

export interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();

/** Test hook: forget cached discovery documents. */
export function __resetDiscoveryCache(): void {
  discoveryCache.clear();
}

export async function discover(
  issuer: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<Discovery> {
  const now = opts.now ?? Date.now();
  const hit = discoveryCache.get(issuer);
  if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.doc;

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Partial<Discovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error("OIDC discovery document is missing authorization_endpoint or token_endpoint");
  }
  const clean: Discovery = {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
  };
  discoveryCache.set(issuer, { at: now, doc: clean });
  return clean;
}

/** 32 random bytes each, base64url — the login round-trip's one-time values. */
export function newFlowSecrets(): { state: string; nonce: string; verifier: string } {
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
  };
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizeUrl(
  d: Discovery,
  cfg: OidcConfig,
  s: { state: string; nonce: string; verifier: string },
): string {
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", s.state);
  u.searchParams.set("nonce", s.nonce);
  u.searchParams.set("code_challenge", challengeFor(s.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeCode(
  d: Discovery,
  cfg: OidcConfig,
  args: { code: string; verifier: string },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ idToken: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.verifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });
  const res = await doFetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  const parsed = (await res.json().catch(() => null)) as { id_token?: string; error?: string } | null;
  if (!res.ok) {
    // Surface the provider's error code only — never the whole body, which can
    // carry tokens on some providers.
    throw new Error(`token exchange failed: ${parsed?.error ?? res.status}`);
  }
  if (!parsed?.id_token) throw new Error("token response carried no id_token");
  return { idToken: parsed.id_token };
}

export function identityFromIdToken(
  idToken: string,
  cfg: OidcConfig,
  args: { nonce: string; now?: number },
): { ok: true; sub: string; identity: string } | { ok: false; reason: string } {
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed id_token" };
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed id_token claims" };
  }
  if (claims.iss !== cfg.issuer) return { ok: false, reason: "iss mismatch" };
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(cfg.clientId) : aud === cfg.clientId;
  if (!audOk) return { ok: false, reason: "aud mismatch" };
  if (claims.nonce !== args.nonce) return { ok: false, reason: "nonce mismatch" };
  const nowSec = Math.floor((args.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return { ok: false, reason: "exp passed" };
  const raw = claims[cfg.userClaim];
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: `missing identity claim '${cfg.userClaim}'` };
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) return { ok: false, reason: "missing sub" };
  return { ok: true, sub, identity: raw.trim().toLowerCase() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/panel/oidc.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/panel/auth/oidc.ts tests/panel/oidc.test.ts
git commit -m "feat(panel): OIDC relying-party protocol module

Discovery (cached), PKCE S256 authorize URL, code exchange, and ID-token
claim validation. Provider-agnostic: Google and Keycloak differ only in
the issuer URL. The ID token's signature is not verified because it is
only ever read from the token-endpoint response over TLS — documented in
the module header as a precondition, not an omission."
```

---

### Task 6: Auth routes

`/panel/auth/{login,callback,refresh,logout,me}`.

**Files:**
- Create: `src/gateway/panel/auth/routes.ts`
- Test: `tests/panel/auth-routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `interface AuthRoutesDeps { fetchImpl?: typeof fetch }`
  - `interface AuthRoutes { handle(req: Request, seg: string[]): Promise<Response | null> }` — `seg` is the path split, e.g. `["panel","auth","login"]`; returns `null` when the path is not an auth route
  - `createAuthRoutes(deps?: AuthRoutesDeps): AuthRoutes`
  - `safeReturnTo(raw: string | null): string` — exported for tests; returns a same-origin `/panel…` path or `"/panel"`

- [ ] **Step 1: Write the failing test**

Create `tests/panel/auth-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { createAuthRoutes, safeReturnTo } from "../../src/gateway/panel/auth/routes";
import { __resetDiscoveryCache } from "../../src/gateway/panel/auth/oidc";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, parseCookies } from "../../src/gateway/panel/auth/session";

const ISSUER = "https://idp.example.com/realms/slaude";
const SECRET = "k".repeat(32);
const DISCO = {
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
};

const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (c: Record<string, unknown>) => `${b({ alg: "RS256" })}.${b(c)}.sig`;

/** Stub provider: serves discovery, then a token response built from the nonce
 *  the panel put in the authorize URL. */
function stubIdp(opts: { email?: string; nonceRef: { value: string } }) {
  return (async (url: string | URL) => {
    const s = String(url);
    if (s.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(DISCO), { status: 200 });
    }
    if (s === DISCO.token_endpoint) {
      return new Response(
        JSON.stringify({
          id_token: idToken({
            iss: ISSUER, aud: "slaude-panel", sub: "sub-1",
            email: opts.email ?? "alice@example.com",
            nonce: opts.nonceRef.value,
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${s}`);
  }) as unknown as typeof fetch;
}

const seg = (p: string) => p.split("/").filter(Boolean);
const call = (routes: ReturnType<typeof createAuthRoutes>, path: string, init?: RequestInit) =>
  routes.handle(new Request(`https://panel.example.com${path}`, init), seg(path));

/** Drive login → callback, returning the callback response. */
async function login(email = "alice@example.com") {
  const nonceRef = { value: "" };
  const routes = createAuthRoutes({ fetchImpl: stubIdp({ email, nonceRef }) });
  const start = (await call(routes, "/panel/auth/login"))!;
  const authorize = new URL(start.headers.get("location")!);
  nonceRef.value = authorize.searchParams.get("nonce")!;
  const state = authorize.searchParams.get("state")!;
  const flow = parseCookies(start.headers.get("set-cookie"))["panel_flow"]!;
  const cb = (await call(routes, `/panel/auth/callback?code=C&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `panel_flow=${flow}` },
  }))!;
  return { routes, cb, state, flow };
}

beforeEach(() => {
  process.env.SLAUDE_PANEL = "1";
  process.env.SLAUDE_PANEL_OIDC_ISSUER = ISSUER;
  process.env.SLAUDE_PANEL_OIDC_CLIENT_ID = "slaude-panel";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_SECRET = "s3cret";
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://panel.example.com";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
  __resetDiscoveryCache();
  __resetRoleCache();
});

describe("route matching", () => {
  it("ignores paths outside /panel/auth", async () => {
    const routes = createAuthRoutes();
    expect(await call(routes, "/panel/api/sessions")).toBeNull();
  });
});

describe("login", () => {
  it("redirects to the provider and sets a flow cookie", async () => {
    const nonceRef = { value: "" };
    const routes = createAuthRoutes({ fetchImpl: stubIdp({ nonceRef }) });
    const res = (await call(routes, "/panel/auth/login"))!;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(DISCO.authorization_endpoint);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("panel_flow=");
    expect(setCookie).toContain("Path=/panel/auth");
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("callback", () => {
  it("mints both cookies and redirects into the app", async () => {
    const { cb } = await login();
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/panel");
    const cookies = cb.headers.getSetCookie().join("\n");
    expect(cookies).toContain("panel_at=");
    expect(cookies).toContain("panel_rt=");
    expect(cookies).toContain("Path=/panel/auth/refresh");
    expect(cookies).toContain("panel_flow=; Max-Age=0");
  });

  it("refuses an unlisted identity with 403 and no session cookies", async () => {
    const { cb } = await login("eve@example.com");
    expect(cb.status).toBe(403);
    expect(cb.headers.getSetCookie().join("\n")).not.toContain("panel_at=");
  });

  it("refuses a state that does not match the flow cookie", async () => {
    const { routes, flow } = await login();
    const res = (await call(routes, "/panel/auth/callback?code=C&state=forged", {
      headers: { cookie: `panel_flow=${flow}` },
    }))!;
    expect(res.status).toBe(400);
  });

  it("refuses a replayed state once the flow cookie is gone", async () => {
    const { routes, state } = await login();
    const res = (await call(routes, `/panel/auth/callback?code=C&state=${encodeURIComponent(state)}`))!;
    expect(res.status).toBe(400);
  });

  it("refuses a callback with no code", async () => {
    const { routes, state, flow } = await login();
    const res = (await call(routes, `/panel/auth/callback?state=${encodeURIComponent(state)}`, {
      headers: { cookie: `panel_flow=${flow}` },
    }))!;
    expect(res.status).toBe(400);
  });
});

describe("returnTo", () => {
  it("keeps a same-origin panel path", () => {
    expect(safeReturnTo("/panel/sessions/S-1")).toBe("/panel/sessions/S-1");
  });
  it("rejects an absolute URL, a protocol-relative URL, and a non-panel path", () => {
    expect(safeReturnTo("https://evil.example.com/x")).toBe("/panel");
    expect(safeReturnTo("//evil.example.com/x")).toBe("/panel");
    expect(safeReturnTo("/v1/sessions")).toBe("/panel");
    expect(safeReturnTo(null)).toBe("/panel");
  });
});

describe("refresh", () => {
  it("mints a new access token from a valid refresh cookie", async () => {
    const rt = mintSession({ sub: "sub-1", email: "alice@example.com" }, "rt", { secret: SECRET });
    const res = (await call(createAuthRoutes(), "/panel/auth/refresh", {
      method: "POST",
      headers: { cookie: `panel_rt=${rt}`, "x-panel-csrf": "1" },
    }))!;
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("panel_at=");
    // Absolute window: the refresh cookie is not re-issued.
    expect(cookies).not.toContain("panel_rt=");
  });

  it("401s and clears cookies when the identity lost its role", async () => {
    const rt = mintSession({ sub: "sub-1", email: "alice@example.com" }, "rt", { secret: SECRET });
    process.env.SLAUDE_PANEL_OPERATORS = "";
    __resetRoleCache();
    const res = (await call(createAuthRoutes(), "/panel/auth/refresh", {
      method: "POST",
      headers: { cookie: `panel_rt=${rt}`, "x-panel-csrf": "1" },
    }))!;
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join("\n")).toContain("panel_at=; Max-Age=0");
  });

  it("401s on an access token presented as a refresh token", async () => {
    const at = mintSession({ sub: "sub-1", email: "alice@example.com" }, "at", { secret: SECRET });
    const res = (await call(createAuthRoutes(), "/panel/auth/refresh", {
      method: "POST",
      headers: { cookie: `panel_rt=${at}`, "x-panel-csrf": "1" },
    }))!;
    expect(res.status).toBe(401);
  });

  it("405s on GET", async () => {
    const res = (await call(createAuthRoutes(), "/panel/auth/refresh"))!;
    expect(res.status).toBe(405);
  });
});

describe("me", () => {
  it("returns the identity and role", async () => {
    const at = mintSession({ sub: "sub-1", email: "lead@example.com" }, "at", { secret: SECRET });
    const res = (await call(createAuthRoutes(), "/panel/auth/me", { headers: { cookie: `panel_at=${at}` } }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "lead@example.com", role: "superadmin" });
  });

  it("401s without a session", async () => {
    const res = (await call(createAuthRoutes(), "/panel/auth/me"))!;
    expect(res.status).toBe(401);
  });
});

describe("logout", () => {
  it("clears both cookies", async () => {
    const res = (await call(createAuthRoutes(), "/panel/auth/logout", {
      method: "POST",
      headers: { "x-panel-csrf": "1" },
    }))!;
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("panel_at=; Max-Age=0");
    expect(cookies).toContain("panel_rt=; Max-Age=0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/panel/auth-routes.test.ts`
Expected: FAIL — cannot resolve module `src/gateway/panel/auth/routes`.

- [ ] **Step 3: Create `src/gateway/panel/auth/routes.ts`**

```ts
/**
 * Panel auth routes (design §Data flow). The only module that talks to the
 * identity provider.
 *
 *   GET  /panel/auth/login      → 302 to the provider, sets the flow cookie
 *   GET  /panel/auth/callback   → exchanges the code, sets the session cookies
 *   POST /panel/auth/refresh    → new access token from the refresh cookie
 *   POST /panel/auth/logout     → clears both cookies
 *   GET  /panel/auth/me         → { email, role } for the current session
 *
 * The CSRF guard in api.ts runs before these handlers for non-GET methods.
 */
import { audit } from "./audit";
import {
  buildAuthorizeUrl, discover, exchangeCode, identityFromIdToken, newFlowSecrets, oidcConfigFromEnv,
} from "./oidc";
import { resolveRoleForIdentity } from "./roles";
import {
  AT_COOKIE, AT_PATH, AT_TTL_SEC, FLOW_COOKIE, FLOW_PATH, FLOW_TTL_SEC,
  RT_COOKIE, RT_PATH, RT_TTL_SEC,
  clearCookie, mintFlow, mintSession, parseCookies, setCookie, verifyFlow, verifySession,
} from "./session";

export interface AuthRoutesDeps {
  /** Injected in tests to stand in for the identity provider. */
  fetchImpl?: typeof fetch;
}

export interface AuthRoutes {
  /** Handle an auth route; null when `seg` is not one. */
  handle(req: Request, seg: string[]): Promise<Response | null>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A redirect target is accepted only as a same-origin path under /panel. */
export function safeReturnTo(raw: string | null): string {
  if (!raw) return "/panel";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/panel";
  if (raw !== "/panel" && !raw.startsWith("/panel/")) return "/panel";
  return raw;
}

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

function withCookies(res: Response, cookies: string[]): Response {
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}

const clearSession = () => [clearCookie(AT_COOKIE, AT_PATH), clearCookie(RT_COOKIE, RT_PATH)];

export function createAuthRoutes(deps: AuthRoutesDeps = {}): AuthRoutes {
  const fetchImpl = deps.fetchImpl;

  async function handleLogin(req: Request): Promise<Response> {
    const cfg = oidcConfigFromEnv();
    const url = new URL(req.url);
    const secrets = newFlowSecrets();
    const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
    const d = await discover(cfg.issuer, { fetchImpl });
    const flow = mintFlow({ ...secrets, returnTo });
    return redirect(buildAuthorizeUrl(d, cfg, secrets), [
      setCookie(FLOW_COOKIE, flow, { path: FLOW_PATH, maxAgeSec: FLOW_TTL_SEC }),
    ]);
  }

  async function handleCallback(req: Request): Promise<Response> {
    const cfg = oidcConfigFromEnv();
    const url = new URL(req.url);
    const clearFlow = clearCookie(FLOW_COOKIE, FLOW_PATH);
    const jar = parseCookies(req.headers.get("cookie"));

    const flow = verifyFlow(jar[FLOW_COOKIE]);
    if (!flow.ok) return withCookies(json(400, { error: "login flow expired or invalid — start again" }), [clearFlow]);

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || state !== flow.payload.state) {
      return withCookies(json(400, { error: "state mismatch" }), [clearFlow]);
    }
    if (!code) return withCookies(json(400, { error: "missing authorization code" }), [clearFlow]);

    const d = await discover(cfg.issuer, { fetchImpl });
    let idToken: string;
    try {
      ({ idToken } = await exchangeCode(d, cfg, { code, verifier: flow.payload.verifier }, { fetchImpl }));
    } catch (e) {
      console.error(`[panel] token exchange failed: ${(e as Error).message}`);
      return withCookies(json(502, { error: "identity provider rejected the login" }), [clearFlow]);
    }

    const who = identityFromIdToken(idToken, cfg, { nonce: flow.payload.nonce });
    if (!who.ok) {
      console.error(`[panel] id_token rejected: ${who.reason}`);
      return withCookies(json(400, { error: "invalid id_token" }), [clearFlow]);
    }

    const role = resolveRoleForIdentity(who.identity);
    if (!role) {
      audit({ action: "auth.denied", operator: who.identity, role: null, outcome: "denied" });
      return withCookies(
        json(403, { error: "authenticated, but not authorized for this panel" }),
        [clearFlow, ...clearSession()],
      );
    }

    audit({ action: "auth.login", operator: who.identity, role });
    const claims = { sub: who.sub, email: who.identity };
    return redirect(safeReturnTo(flow.payload.returnTo), [
      clearFlow,
      setCookie(AT_COOKIE, mintSession(claims, "at"), { path: AT_PATH, maxAgeSec: AT_TTL_SEC }),
      setCookie(RT_COOKIE, mintSession(claims, "rt"), { path: RT_PATH, maxAgeSec: RT_TTL_SEC }),
    ]);
  }

  function handleRefresh(req: Request): Response {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    const jar = parseCookies(req.headers.get("cookie"));
    const r = verifySession(jar[RT_COOKIE], "rt");
    if (!r.ok) return withCookies(json(401, { error: `session ended: ${r.reason}` }), clearSession());

    // Roles are re-resolved here as well as per-request: a demoted operator
    // must not be able to extend their session.
    const role = resolveRoleForIdentity(r.claims.email);
    if (!role) {
      audit({ action: "auth.refresh", operator: r.claims.email, role: null, outcome: "denied" });
      return withCookies(json(401, { error: "no longer authorized" }), clearSession());
    }

    audit({ action: "auth.refresh", operator: r.claims.email, role });
    // The refresh cookie is deliberately NOT re-issued: 8h is an absolute cap,
    // not a sliding window.
    return withCookies(json(200, { ok: true, email: r.claims.email, role }), [
      setCookie(AT_COOKIE, mintSession({ sub: r.claims.sub, email: r.claims.email }, "at"), {
        path: AT_PATH,
        maxAgeSec: AT_TTL_SEC,
      }),
    ]);
  }

  function handleLogout(req: Request): Response {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    const jar = parseCookies(req.headers.get("cookie"));
    const r = verifySession(jar[AT_COOKIE], "at");
    if (r.ok) audit({ action: "auth.logout", operator: r.claims.email });
    return withCookies(json(200, { ok: true }), clearSession());
  }

  function handleMe(req: Request): Response {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const jar = parseCookies(req.headers.get("cookie"));
    const r = verifySession(jar[AT_COOKIE], "at");
    if (!r.ok) return json(401, { error: "session expired" });
    const role = resolveRoleForIdentity(r.claims.email);
    if (!role) return json(403, { error: "not authorized" });
    return json(200, { email: r.claims.email, role });
  }

  return {
    async handle(req, seg) {
      if (seg[1] !== "auth" || seg.length !== 3) return null;
      switch (seg[2]) {
        case "login":
          return await handleLogin(req);
        case "callback":
          return await handleCallback(req);
        case "refresh":
          return handleRefresh(req);
        case "logout":
          return handleLogout(req);
        case "me":
          return handleMe(req);
        default:
          return null;
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/panel/auth-routes.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/panel/auth/routes.ts tests/panel/auth-routes.test.ts
git commit -m "feat(panel): /panel/auth login, callback, refresh, logout, me

Authorization Code + PKCE with the round-trip state in a signed
10-minute cookie, so no server-side store is needed. An authenticated
but unlisted identity gets 403 and no session cookies. Refresh
re-resolves the role and never re-issues the refresh cookie — the 8h
window is absolute, not sliding."
```

---

### Task 7: Request guard and API wiring

Replace `authenticateOperator` everywhere; delete the header-trust path.

**Files:**
- Create: `src/gateway/panel/auth/guard.ts`
- Delete: `src/gateway/panel/auth.ts`
- Modify: `src/gateway/panel/api.ts` (imports, the `audit` helper at lines 101-106, and the `fetch` routing block at lines 230-260)
- Modify: `src/server.ts:108-115` (boot guard)
- Delete: `tests/panel/auth.test.ts` (its subject is gone; role and route coverage live in Tasks 2, 6, 8)
- Test: `tests/panel/guard.test.ts`

**Interfaces:**
- Consumes: `verifySession`, `parseCookies`, `AT_COOKIE` (Task 3); `resolveRoleForIdentity`, `PanelRole` (Task 2); `assertPanelConfig` (Task 1); `createAuthRoutes` (Task 6).
- Produces:
  - `type GuardOk = { ok: true; operatorId: string; role: PanelRole }`
  - `type GuardResult = GuardOk | { ok: false; response: Response }`
  - `guardRequest(req: Request, opts: { html: boolean }): GuardResult`

- [ ] **Step 1: Write the failing test**

Create `tests/panel/guard.test.ts`:

```ts
import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { guardRequest } from "../../src/gateway/panel/auth/guard";
import { mintSession } from "../../src/gateway/panel/auth/session";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";

const SECRET = "g".repeat(32);
const at = (email: string, ttlSec?: number) =>
  mintSession({ sub: "s", email }, "at", { secret: SECRET, ...(ttlSec != null ? { ttlSec } : {}) });

const reqWith = (cookie?: string, path = "/panel/api/sessions") =>
  new Request(`https://panel.example.com${path}`, cookie ? { headers: { cookie } } : undefined);

beforeEach(() => {
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
  __resetRoleCache();
});

describe("guardRequest", () => {
  it("admits an operator and reports the role", () => {
    const r = guardRequest(reqWith(`panel_at=${at("alice@example.com")}`), { html: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operatorId).toBe("alice@example.com");
      expect(r.role).toBe("operator");
    }
  });

  it("reports superadmin for a listed superadmin", () => {
    const r = guardRequest(reqWith(`panel_at=${at("lead@example.com")}`), { html: false });
    expect(r.ok && r.role).toBe("superadmin");
  });

  it("401s an API request with no session", async () => {
    const r = guardRequest(reqWith(), { html: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect((await r.response.json()).error).toContain("session");
    }
  });

  it("redirects an HTML request with no session, preserving returnTo", () => {
    const r = guardRequest(reqWith(undefined, "/panel/sessions/S-1"), { html: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(302);
      const loc = r.response.headers.get("location")!;
      expect(loc.startsWith("/panel/auth/login?returnTo=")).toBe(true);
      expect(decodeURIComponent(loc.split("returnTo=")[1]!)).toBe("/panel/sessions/S-1");
    }
  });

  it("401s an expired access token", () => {
    const r = guardRequest(reqWith(`panel_at=${at("alice@example.com", -60)}`), { html: false });
    expect(r.ok === false && r.response.status).toBe(401);
  });

  it("refuses a refresh token used as an access token", () => {
    const rt = mintSession({ sub: "s", email: "alice@example.com" }, "rt", { secret: SECRET });
    const r = guardRequest(reqWith(`panel_at=${rt}`), { html: false });
    expect(r.ok === false && r.response.status).toBe(401);
  });

  it("403s a valid session whose identity is no longer listed", () => {
    const token = at("alice@example.com");
    process.env.SLAUDE_PANEL_OPERATORS = "";
    __resetRoleCache();
    const r = guardRequest(reqWith(`panel_at=${token}`), { html: false });
    expect(r.ok === false && r.response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/panel/guard.test.ts`
Expected: FAIL — cannot resolve module `src/gateway/panel/auth/guard`.

- [ ] **Step 3: Create `src/gateway/panel/auth/guard.ts`**

```ts
/**
 * Per-request operator gate (design §Authenticated request).
 *
 * Identity comes from the panel's own access-token cookie; the role is
 * re-resolved from config on every request and is deliberately not a token
 * claim, so a demotion lands at the next request rather than the next refresh.
 *
 * API paths get a 401/403 JSON body; HTML paths get a redirect to login, so a
 * browser landing on an expired session sees the provider rather than a raw
 * error.
 */
import { resolveRoleForIdentity, type PanelRole } from "./roles";
import { AT_COOKIE, parseCookies, verifySession } from "./session";

export type GuardOk = { ok: true; operatorId: string; role: PanelRole };
export type GuardResult = GuardOk | { ok: false; response: Response };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function loginRedirect(req: Request): Response {
  const url = new URL(req.url);
  const returnTo = encodeURIComponent(url.pathname + url.search);
  return new Response(null, { status: 302, headers: { location: `/panel/auth/login?returnTo=${returnTo}` } });
}

export function guardRequest(req: Request, opts: { html: boolean }): GuardResult {
  const jar = parseCookies(req.headers.get("cookie"));
  const r = verifySession(jar[AT_COOKIE], "at");
  if (!r.ok) {
    if (opts.html) return { ok: false, response: loginRedirect(req) };
    return { ok: false, response: json(401, { error: `session expired (${r.reason})` }) };
  }
  const role = resolveRoleForIdentity(r.claims.email);
  if (!role) {
    return { ok: false, response: json(403, { error: "authenticated, but not authorized for this panel" }) };
  }
  return { ok: true, operatorId: r.claims.email, role };
}
```

- [ ] **Step 4: Run the guard test to verify it passes**

Run: `bun test tests/panel/guard.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Rewire `src/gateway/panel/api.ts`**

Replace the `authenticateOperator` import:

```ts
import { authenticateOperator } from "./auth";
```

with:

```ts
import { guardRequest } from "./auth/guard";
import { createAuthRoutes } from "./auth/routes";
import { audit } from "./auth/audit";
import type { PanelRole } from "./auth/roles";
```

Delete the local `audit` helper (lines 101-106) entirely — `auth/audit.ts` replaces it. Update its call sites to the new record shape; e.g. `audit(operatorId, "chat", id)` becomes `audit({ action: "chat", operator: operatorId, role, session: id })`, and `audit(operatorId, \`control:${action}\`, row.id, { model, mode })` becomes `audit({ action: \`control.${action}\`, operator: operatorId, role, session: row.id, detail: { model, mode } })`. Thread `role` into `handleControl` by widening its signature to `handleControl(req: Request, row: SessionRow, operatorId: string, role: PanelRole)`; every other call site already has `role` in scope from the guard.

Then replace the boot guard and both auth calls in `fetch` (lines 234-256) with:

```ts
    const seg = url.pathname.split("/").filter(Boolean); // ["panel", ...]

    // Auth routes are the only unauthenticated paths — they are how a session
    // is obtained. CSRF still applies to their mutating methods.
    if (seg[1] === "auth") {
      const csrf = enforceCsrf(req);
      if (csrf) return csrf;
      const res = await authRoutes.handle(req, seg);
      if (res) return res;
      return json(404, { error: "not found" });
    }

    // Static web app: any /panel path that is not the API.
    if (seg[1] !== "api") {
      const auth = guardRequest(req, { html: true });
      if (!auth.ok) return auth.response;
      return (await servePanelStatic(url.pathname)) ?? json(404, { error: "not found" });
    }

    const auth = guardRequest(req, { html: false });
    if (!auth.ok) return auth.response;
    const { operatorId, role } = auth;

    // CSRF: block forged cross-site state changes before any mutating handler.
    const csrf = enforceCsrf(req);
    if (csrf) return csrf;
```

Add, just inside `createPanelApi`, above `handleEvents`:

```ts
  const authRoutes = createAuthRoutes();
```

Delete the `if (!env.panel.trustHeader())` block entirely.

- [ ] **Step 6: Update `src/server.ts` boot guard**

Replace the block at lines 108-115 with:

```ts
  if (panelMounted) {
    // Throws when the panel is enabled but cannot serve safely — a
    // misconfigured auth surface must never accept a request.
    assertPanelConfig();
    console.log(`[slaude] /panel control panel mounted (role=${role})`);
  }
```

and add the import near the other panel imports:

```ts
import { assertPanelConfig } from "./gateway/panel/auth/config";
```

- [ ] **Step 7: Delete the obsolete module and its test**

```bash
git rm src/gateway/panel/auth.ts tests/panel/auth.test.ts
```

- [ ] **Step 8: Update the existing panel tests that inject the old header**

Run `grep -rln "x-auth-request-email\|SLAUDE_PANEL_TRUST_HEADER\|SLAUDE_PANEL_ALLOW" tests/` and, in each hit, replace the header injection with a session cookie. The helper to add at the top of each such file:

```ts
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";

const PANEL_SECRET = "t".repeat(32);
/** Cookie header for an authenticated operator in tests. */
function opCookie(email = "alice@example.com"): string {
  return `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: PANEL_SECRET })}`;
}
```

with `process.env.SLAUDE_PANEL_SECRET = PANEL_SECRET` and the role env lists set in that file's `beforeEach`, and `{ headers: { cookie: opCookie(), "x-panel-csrf": "1" } }` replacing the old header object.

- [ ] **Step 9: Run the whole server suite and typecheck**

Run: `bun test tests/panel && bun test tests/integration/panel.test.ts && bun run typecheck`
Expected: PASS across all panel suites; zero type errors. Redis-gated integration tests skip cleanly when Redis is absent — that is expected, not a failure.

- [ ] **Step 10: Commit**

```bash
git add -A src/gateway/panel src/server.ts tests/panel tests/integration
git commit -m "feat(panel): cookie-session guard replaces the trusted ingress header

guardRequest verifies the panel's own access token and re-resolves the
role per request; /panel/auth/* is the only unauthenticated path. The
header-trust module, its env vars, and its tests are deleted, closing
the impersonation footgun: there is no longer a header a misconfigured
ingress could fail to strip."
```

---

### Task 8: Role enforcement on destructive actions

**Files:**
- Modify: `src/gateway/panel/api.ts` (the `handleControl` switch and the `force-release` branch)
- Test: `tests/panel/authz.test.ts`

**Interfaces:**
- Consumes: `PanelRole` (Task 2), `audit` (Task 4), `guardRequest` (Task 7).
- Produces:
  - `const SUPERADMIN_ACTIONS: ReadonlySet<string>` — exported from `api.ts` for the test
  - `requireSuperadmin(role: PanelRole, ctx: { action: string; operator: string; session?: string }): Response | null` — exported from `api.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/panel/authz.test.ts`:

```ts
import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { requireSuperadmin, SUPERADMIN_ACTIONS } from "../../src/gateway/panel/api";

beforeEach(() => {
  process.env.SLAUDE_PANEL_SECRET = "a".repeat(32);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
});

describe("superadmin action set", () => {
  it("gates exactly reset, mode and force-release", () => {
    expect([...SUPERADMIN_ACTIONS].sort()).toEqual(["control.mode", "control.reset", "force-release"]);
  });

  it("leaves stop, model and unlock-1on1 to any operator", () => {
    for (const a of ["control.stop", "control.model", "control.unlock-1on1"]) {
      expect(SUPERADMIN_ACTIONS.has(a)).toBe(false);
    }
  });
});

describe("requireSuperadmin", () => {
  it("passes a superadmin through", () => {
    expect(requireSuperadmin("superadmin", { action: "control.reset", operator: "lead@example.com" })).toBeNull();
  });

  it("403s an operator with the required role named", async () => {
    const res = requireSuperadmin("operator", { action: "control.reset", operator: "alice@example.com", session: "S-1" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toContain("superadmin");
    expect(body.required).toBe("superadmin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/panel/authz.test.ts`
Expected: FAIL — `requireSuperadmin` is not exported from `api.ts`.

- [ ] **Step 3: Add the enforcement to `src/gateway/panel/api.ts`**

Add near the top-level helpers, beside `enforceCsrf`:

```ts
/**
 * Actions gated to superadmin (design §Authorization). `reset` discards session
 * state unrecoverably; `mode` can set bypassPermissions, which lets the agent
 * act without gates; `force-release` steals another operator's lock.
 *
 * superadmin is a superset of operator — no action is operator-only.
 */
export const SUPERADMIN_ACTIONS: ReadonlySet<string> = new Set([
  "control.reset",
  "control.mode",
  "force-release",
]);

/** Returns the 403 to send, or null when the role suffices. */
export function requireSuperadmin(
  role: PanelRole,
  ctx: { action: string; operator: string; session?: string },
): Response | null {
  if (!SUPERADMIN_ACTIONS.has(ctx.action)) return null;
  if (role === "superadmin") return null;
  audit({ ...ctx, role, outcome: "denied", detail: { required: "superadmin" } });
  return json(403, { error: `action '${ctx.action}' requires the superadmin role`, required: "superadmin" });
}
```

In `handleControl`, immediately after `const { action, model, mode } = parsed.data;`:

```ts
    const denied = requireSuperadmin(role, {
      action: `control.${action}`,
      operator: operatorId,
      session: row.id,
    });
    if (denied) return denied;
```

In the `force-release` branch of `fetch`, before any lock work:

```ts
          const denied = requireSuperadmin(role, { action: "force-release", operator: operatorId, session: id });
          if (denied) return denied;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/panel/authz.test.ts && bun run typecheck`
Expected: PASS, 4 tests; zero type errors.

- [ ] **Step 5: Add the end-to-end role test to the integration suite**

Append to `tests/integration/panel.test.ts`, inside its existing top-level `describe` and using that file's established harness helpers for building a request against the panel (follow the surrounding tests' pattern for constructing the API and a session row; set `process.env.SLAUDE_PANEL_SECRET`, `SLAUDE_PANEL_SUPERADMIN=lead@example.com`, and `SLAUDE_PANEL_OPERATORS=alice@example.com` in the suite's setup):

```ts
  it("refuses reset from an operator and allows it for a superadmin", async () => {
    const body = JSON.stringify({ action: "reset" });
    const headers = (email: string) => ({
      cookie: opCookie(email),
      "content-type": "application/json",
      "x-panel-csrf": "1",
    });

    const denied = await api.fetch(
      new Request(`https://panel.example.com/panel/api/sessions/${sessionId}/control`, {
        method: "POST", headers: headers("alice@example.com"), body,
      }),
    );
    expect(denied!.status).toBe(403);

    const allowed = await api.fetch(
      new Request(`https://panel.example.com/panel/api/sessions/${sessionId}/control`, {
        method: "POST", headers: headers("lead@example.com"), body,
      }),
    );
    expect(allowed!.status).toBe(200);
  });
```

- [ ] **Step 6: Run the integration suite**

Run: `bun test tests/integration/panel.test.ts`
Expected: PASS (or a clean skip if Redis is unavailable — verify with Redis running before committing).

- [ ] **Step 7: Commit**

```bash
git add src/gateway/panel/api.ts tests/panel/authz.test.ts tests/integration/panel.test.ts
git commit -m "feat(panel): gate reset, mode and force-release to superadmin

reset discards session state unrecoverably, mode can set
bypassPermissions (the agent then acts without gates), and force-release
steals another operator's lock. Everything else stays open to any
operator. Denials are audited with the required role."
```

---

### Task 9: Web app session handling

**Files:**
- Modify: `src/gateway/panel/web/app/api.ts` (`realBackend`, `operatorId`)
- Modify: `src/gateway/panel/web/app/App.tsx` (identity chip, 403 screen)
- Modify: `src/gateway/panel/web/app/ControlBar.tsx` (disable superadmin-only controls)
- Modify: `src/gateway/panel/web/app/types.ts` (add `Me`)
- Modify: `src/gateway/panel/web/app/styles.css` (chip + notice styles)

**Interfaces:**
- Consumes: `GET /panel/auth/me` → `{ email, role }`; `POST /panel/auth/refresh` (Task 6); the 403 body `{ error, required }` (Task 8).
- Produces:
  - `interface Me { email: string; role: "superadmin" | "operator" }` in `types.ts`
  - `Backend.me(): Promise<Me>` and `Backend.logout(): Promise<void>` on the existing `Backend` interface
  - `Backend.role: "superadmin" | "operator" | null` — populated after `me()` resolves; the mock backend reports `"superadmin"` so `?mock=1` screenshots keep every control live

- [ ] **Step 1: Write the failing test**

Add to `tests/panel-web/panel.spec.ts` (Playwright; the stub provider arrives in Task 10, so this first spec drives only the client-side refresh behaviour against the existing stub server):

```ts
test("retries once through /panel/auth/refresh on a 401", async ({ page }) => {
  let refreshes = 0;
  let expired = true;
  await page.route("**/panel/auth/refresh", async (route) => {
    refreshes++;
    expired = false;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/panel/api/sessions*", async (route) => {
    if (expired) {
      await route.fulfill({
        status: 401, contentType: "application/json",
        body: JSON.stringify({ error: "session expired" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/panel");
  await expect(page.locator("[data-testid=session-row]").first()).toBeVisible();
  expect(refreshes).toBe(1);
});
```

If `data-testid=session-row` is not the existing list-row hook, use whatever selector the neighbouring specs in that file already use for a rendered session row.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run panel:build && bun run test:web -g "retries once"`
Expected: FAIL — the client surfaces the 401 instead of refreshing; `refreshes` is 0.

- [ ] **Step 3: Rewrite the real backend's request layer in `src/gateway/panel/web/app/api.ts`**

Replace `operatorId()` and the `realBackend()` header/`req` section:

```ts
// The operator identity now comes from the panel session cookie, not a header
// or a query parameter. `?op=` survives only in the mock backend, where it
// labels the fixture operator.
function mockOperatorId(): string {
  return params.get("op") || OPERATOR;
}
```

```ts
function realBackend(): Backend {
  const base = "/panel/api";
  // `x-panel-csrf` is the anti-CSRF marker the server requires on mutating
  // requests; a cross-site page cannot set a custom header without a preflight.
  const headers = { "content-type": "application/json", "x-panel-csrf": "1" };

  async function once(path: string, init?: RequestInit) {
    return fetch(base + path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  }

  async function req(path: string, init?: RequestInit) {
    let r = await once(path, init);
    if (r.status === 401) {
      // One refresh attempt, then retry. A second 401 means the refresh window
      // closed too — send the operator back to the provider.
      const refreshed = await fetch("/panel/auth/refresh", { method: "POST", headers });
      if (refreshed.ok) r = await once(path, init);
      if (r.status === 401) {
        location.href = `/panel/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
        throw new ApiError(401, { error: "session expired" });
      }
    }
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, body);
    return body;
  }

  const backend: Backend = {
    operator: "",
    role: null,
    mock: false,
    async me() {
      const m = (await req("/../auth/me")) as Me;
      backend.operator = m.email;
      backend.role = m.role;
      return m;
    },
    async logout() {
      await fetch("/panel/auth/logout", { method: "POST", headers });
      location.href = "/panel/auth/login";
    },
    // ...the existing listSessions / getSession / control / chat / lock /
    // heartbeat / release / forceRelease / subscribe members are unchanged...
  };
  return backend;
}
```

`req("/../auth/me")` is deliberate only if it resolves cleanly; prefer an explicit second base — add `const authBase = "/panel/auth";` and call `fetch(authBase + "/me")` inside `me()` with the same 401 handling skipped (a 401 there simply means "not signed in"), returning `null` for the caller to redirect on.

Add to `types.ts`:

```ts
export interface Me {
  email: string;
  role: "superadmin" | "operator";
}
```

Extend the `Backend` interface with:

```ts
  role: "superadmin" | "operator" | null;
  me(): Promise<Me | null>;
  logout(): Promise<void>;
```

and give `mockBackend()` `role: "superadmin"`, `me: async () => ({ email: mockOperatorId(), role: "superadmin" as const })`, and `logout: async () => {}`.

- [ ] **Step 4: Add the identity chip and the not-authorized screen in `App.tsx`**

On mount, call `api().me()`. While it is pending, render nothing. When it resolves `null`, redirect to `/panel/auth/login`. Render in the header:

```tsx
{me && (
  <div className="identity">
    <span className="identity-email">{me.email}</span>
    <span className={`role-badge role-${me.role}`}>{me.role}</span>
    <button className="signout" onClick={() => api().logout()}>Sign out</button>
  </div>
)}
```

When any request throws `ApiError` with status 403 and no session is in doubt, render a dedicated panel rather than a toast:

```tsx
<div className="notice notice-forbidden" role="alert">
  <h2>Not authorized</h2>
  <p>You are signed in as {me?.email ?? "an unlisted identity"}, which is not in this panel's role lists.</p>
  <p>Ask an administrator to add you to the panel role file, then sign in again.</p>
  <button onClick={() => api().logout()}>Sign out</button>
</div>
```

- [ ] **Step 5: Disable superadmin-only controls in `ControlBar.tsx`**

```tsx
const isSuper = api().role === "superadmin";
const superOnly = (label: string) => (isSuper ? undefined : `${label} requires the superadmin role`);
```

Apply `disabled={!isSuper}` and `title={superOnly("Reset")}` to the reset control, the permission-mode control, and the force-release control. Keep them rendered — an operator should see that the control exists.

- [ ] **Step 6: Add the styles to `styles.css`**

```css
.identity { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.identity-email { color: var(--fg-muted); font-size: 12px; }
.role-badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
  padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border);
}
.role-superadmin { color: var(--st-orange); border-color: var(--st-orange); }
.role-operator { color: var(--fg-muted); }
.signout { background: none; border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; cursor: pointer; }
.notice-forbidden { max-width: 480px; margin: 64px auto; padding: 24px; border: 1px solid var(--st-red); border-radius: 8px; }
.notice-forbidden h2 { margin-top: 0; color: var(--st-red); }
button[disabled] { opacity: .5; cursor: not-allowed; }
```

Use the actual token names already defined at the top of `styles.css`; if `--fg-muted` or `--border` are named differently there, substitute the real ones.

- [ ] **Step 7: Run the web tests**

Run: `bun run panel:build && bun run test:web`
Expected: PASS — the new refresh spec plus the 8 pre-existing specs.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/panel/web
git commit -m "feat(panel-web): cookie session, silent refresh, role-aware controls

The client no longer injects an operator header or an ?op= parameter —
identity comes from the session cookie and /panel/auth/me. A 401 is
retried once through /panel/auth/refresh before falling back to the
provider. Superadmin-only controls render disabled with a reason rather
than disappearing."
```

---

### Task 10: End-to-end login against a stub provider

**Files:**
- Modify: `tests/panel-web/stub-server.ts` (serve discovery, authorize, token; mount the real auth routes)
- Modify: `tests/panel-web/panel.spec.ts` (login round trip, role gating, 403 screen)

**Interfaces:**
- Consumes: `createAuthRoutes` (Task 6), `guardRequest` (Task 7), `SUPERADMIN_ACTIONS` (Task 8).
- Produces: no new exports — the stub server gains `/idp/*` routes and honours `?role=operator|superadmin` to choose which identity the stub provider returns.

- [ ] **Step 1: Write the failing specs**

Add to `tests/panel-web/panel.spec.ts`:

```ts
test("an unauthenticated visit lands on the fleet list after the provider round trip", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/panel");
  // stub provider auto-approves and bounces straight back to the callback
  await expect(page.locator("[data-testid=session-row]").first()).toBeVisible();
  await expect(page.locator(".identity-email")).toHaveText("alice@example.com");
  await expect(page.locator(".role-badge")).toHaveText(/operator/i);
});

test("an operator sees superadmin controls disabled", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/panel?role=operator");
  await page.locator("[data-testid=session-row]").first().click();
  await expect(page.getByRole("button", { name: /reset/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /reset/i })).toHaveAttribute("title", /superadmin/i);
});

test("a superadmin can issue reset", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/panel?role=superadmin");
  await page.locator("[data-testid=session-row]").first().click();
  const reset = page.getByRole("button", { name: /reset/i });
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(page.locator(".notice-forbidden")).toHaveCount(0);
});

test("an unlisted identity gets the not-authorized screen", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/panel?role=unlisted");
  await expect(page.locator(".notice-forbidden")).toBeVisible();
  await expect(page.locator("[data-testid=session-row]")).toHaveCount(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run panel:build && bun run test:web -g "provider round trip"`
Expected: FAIL — the stub server has no provider endpoints, so the login redirect 404s.

- [ ] **Step 3: Extend `tests/panel-web/stub-server.ts`**

Set the panel env before constructing the handler:

```ts
const PORT = Number(process.env.PORT ?? 4319);
const ORIGIN = `http://localhost:${PORT}`;

process.env.SLAUDE_PANEL = "1";
process.env.SLAUDE_PANEL_OIDC_ISSUER = `${ORIGIN}/idp`;
process.env.SLAUDE_PANEL_OIDC_CLIENT_ID = "slaude-panel";
process.env.SLAUDE_PANEL_OIDC_CLIENT_SECRET = "stub-secret";
process.env.SLAUDE_PANEL_PUBLIC_URL = ORIGIN;
process.env.SLAUDE_PANEL_SECRET = "e2e-secret-e2e-secret-e2e-secret!";
process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
```

Add the stub provider. It auto-approves: `/idp/auth` immediately redirects back to the callback, choosing the identity from a `role` hint carried through `state`.

```ts
const IDENTITIES: Record<string, string> = {
  operator: "alice@example.com",
  superadmin: "lead@example.com",
  unlisted: "eve@example.com",
};
// Remembers which identity each login flow asked for, keyed by state.
const pendingRole = new Map<string, string>();
const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function idpRoutes(url: URL, req: Request): Response | null {
  if (url.pathname === "/idp/.well-known/openid-configuration") {
    return Response.json({
      authorization_endpoint: `${ORIGIN}/idp/auth`,
      token_endpoint: `${ORIGIN}/idp/token`,
    });
  }
  if (url.pathname === "/idp/auth") {
    const state = url.searchParams.get("state")!;
    const nonce = url.searchParams.get("nonce")!;
    pendingRole.set(state, `${nonce}:${roleHint}`);
    return new Response(null, {
      status: 302,
      headers: { location: `${ORIGIN}/panel/auth/callback?code=stub-code&state=${encodeURIComponent(state)}` },
    });
  }
  if (url.pathname === "/idp/token") {
    // The panel posts form-encoded; we only need to answer with an id_token.
    const [nonce, role] = (lastFlow ?? ":operator").split(":");
    return Response.json({
      id_token: `${b64u({ alg: "RS256" })}.${b64u({
        iss: `${ORIGIN}/idp`,
        aud: "slaude-panel",
        sub: "stub-sub",
        email: IDENTITIES[role!] ?? IDENTITIES.operator,
        nonce,
        exp: Math.floor(Date.now() / 1000) + 300,
      })}.stub-sig`,
    });
  }
  return null;
}
```

Carry the role hint through the flow: when the browser requests `/panel?role=<hint>`, store it in a module-level `roleHint` variable (default `"operator"`) before the panel's login redirect is issued, and set `lastFlow` to `` `${nonce}:${roleHint}` `` in `/idp/auth`. Because Playwright runs these specs serially against a fresh server, a single-flight variable is sufficient — no session map is needed. Add a short comment saying exactly that, so a future reader does not mistake it for a concurrency bug.

Route `/panel/*` requests through the real panel handler (`createPanelApi(...).fetch`) so the e2e exercises the actual auth code rather than a reimplementation, falling back to the existing fixture responses for `/panel/api/*`.

- [ ] **Step 4: Run the full web suite**

Run: `bun run panel:build && bun run test:web`
Expected: PASS — 4 new specs plus the 9 from Task 9 and earlier.

- [ ] **Step 5: Commit**

```bash
git add tests/panel-web
git commit -m "test(panel-web): e2e login against a stub OIDC provider

The stub server now speaks discovery, authorize and token, and routes
/panel through the real panel handler, so the specs exercise the actual
auth code: the login round trip, role-gated controls, and the
not-authorized screen for an unlisted identity."
```

---

### Task 11: Dev provider and documentation

**Files:**
- Create: `docker-compose.dev.yml`
- Create: `dev/keycloak/slaude-dev-realm.json`
- Modify: `docs-new/deployment/multi-node.md:99-110` (the panel section)
- Create: `docs/findings/2026-08-29-panel-oidc-auth.md`
- Modify: `CLAUDE.md` (Findings Log index — add the new entry at the top of the list)

**Interfaces:**
- Consumes: the config surface from Task 1.
- Produces: `docker compose -f docker-compose.dev.yml up keycloak` serving a `slaude-dev` realm at `http://localhost:8081/realms/slaude-dev` with a `slaude-panel` confidential client and two users.

- [ ] **Step 1: Create `docker-compose.dev.yml`**

```yaml
# Local development identity provider for the control panel.
# The panel has no auth bypass — local runs use the real OIDC code path.
#
#   docker compose -f docker-compose.dev.yml up -d keycloak
#   SLAUDE_PANEL=1 \
#   SLAUDE_PANEL_OIDC_ISSUER=http://localhost:8081/realms/slaude-dev \
#   SLAUDE_PANEL_OIDC_CLIENT_ID=slaude-panel \
#   SLAUDE_PANEL_OIDC_CLIENT_SECRET=dev-secret \
#   SLAUDE_PANEL_PUBLIC_URL=http://localhost:8080 \
#   SLAUDE_PANEL_SECRET=dev-secret-dev-secret-dev-secret! \
#   SLAUDE_PANEL_SUPERADMIN=lead@example.com \
#   SLAUDE_PANEL_OPERATORS=alice@example.com \
#   bun run dev
services:
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    command: ["start-dev", "--import-realm", "--http-port=8081"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
    ports:
      - "8081:8081"
    volumes:
      - ./dev/keycloak:/opt/keycloak/data/import:ro
```

- [ ] **Step 2: Create `dev/keycloak/slaude-dev-realm.json`**

```json
{
  "realm": "slaude-dev",
  "enabled": true,
  "clients": [
    {
      "clientId": "slaude-panel",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "secret": "dev-secret",
      "standardFlowEnabled": true,
      "redirectUris": ["http://localhost:8080/panel/auth/callback"],
      "webOrigins": ["http://localhost:8080"]
    }
  ],
  "users": [
    {
      "username": "lead",
      "email": "lead@example.com",
      "emailVerified": true,
      "enabled": true,
      "credentials": [{ "type": "password", "value": "dev", "temporary": false }]
    },
    {
      "username": "alice",
      "email": "alice@example.com",
      "emailVerified": true,
      "enabled": true,
      "credentials": [{ "type": "password", "value": "dev", "temporary": false }]
    }
  ]
}
```

- [ ] **Step 3: Verify the dev provider end to end**

```bash
docker compose -f docker-compose.dev.yml up -d keycloak
curl -fsS http://localhost:8081/realms/slaude-dev/.well-known/openid-configuration | head -c 200
```

Expected: a JSON discovery document naming `authorization_endpoint` and `token_endpoint`. Then start the panel with the env block from the compose file's header comment, open `http://localhost:8080/panel`, sign in as `alice` / `dev`, and confirm the fleet list renders with an `operator` badge. Sign out, sign in as `lead` / `dev`, and confirm the badge reads `superadmin` and the reset control is enabled.

- [ ] **Step 4: Rewrite the panel section of `docs-new/deployment/multi-node.md`**

Replace lines 99-110 with:

````markdown
The operator web panel mounts on the gateway tier (`mono`/`gateway` roles, never `node`) when `SLAUDE_PANEL=1`. It authenticates operators itself, as an OIDC relying party against a single issuer — Google or Keycloak, configured identically through discovery. It keeps no user records: identity comes from an ID-token claim, and roles come from a file you control.

```sh
SLAUDE_PANEL=1
SLAUDE_PANEL_OIDC_ISSUER=https://idp.example.com/realms/slaude   # or https://accounts.google.com
SLAUDE_PANEL_OIDC_CLIENT_ID=slaude-panel
SLAUDE_PANEL_OIDC_CLIENT_SECRET=...
SLAUDE_PANEL_PUBLIC_URL=https://panel.example.com   # derives the redirect URI
SLAUDE_PANEL_SECRET=...                             # >= 32 chars, HMAC key for session cookies
SLAUDE_PANEL_USER_CLAIM=email                       # default
SLAUDE_PANEL_ROLES_FILE=/etc/slaude/panel-roles.yaml
```

**Register the redirect URI** with your provider, exactly: `${SLAUDE_PANEL_PUBLIC_URL}/panel/auth/callback`. Scopes required: `openid email profile`. The client must be confidential (it holds a secret).

**Roles** are declared in `panel-roles.yaml` — matched case-insensitively against the identity claim, superadmin winning when an identity appears in both lists:

```yaml
superadmin:
  - lead@example.com
operator:
  - alice@example.com
```

An identity in neither list is authenticated but not authorized: `403`. Edits take effect on the next request — no redeploy. As a fallback for deployments without a mounted file, `SLAUDE_PANEL_SUPERADMIN` and `SLAUDE_PANEL_OPERATORS` accept comma-separated lists.

`superadmin` gates `reset`, permission-`mode` changes, and `force-release` (stealing another operator's lock). Everything else is open to any listed operator.

**Sessions** are the panel's own: a 15-minute access token and an 8-hour refresh token, both in `HttpOnly; Secure; SameSite=Lax` cookies. The refresh window is absolute — after 8 hours the operator re-authenticates at the provider. There is no revocation: removing someone from the role file blocks them at their next request, but a stolen cookie stays valid until it expires. `SLAUDE_PANEL_SECRET` rotation invalidates every outstanding session.

Any missing required variable with `SLAUDE_PANEL=1` stops the process at boot rather than serving a half-configured auth surface. Serve the panel over TLS — the session cookies are `Secure` and browsers will not send them over plain HTTP.
````

- [ ] **Step 5: Write the findings doc**

Create `docs/findings/2026-08-29-panel-oidc-auth.md` covering: why the header-trust boundary was unverifiable; the no-user-table constraint and what it forces (self-contained tokens, no revocation, roles from config); why the ID token's signature is not verified and the precondition that makes that sound; and why the role is re-resolved per request rather than carried as a token claim. Describe the mechanism only — no deployment specifics, no real identities.

- [ ] **Step 6: Index the finding in `CLAUDE.md`**

Add as the first entry under `## Findings Log`:

```markdown
- [2026-08-29 — Panel OIDC auth: the ingress-header trust boundary was unverifiable (a proxy that forgets to strip the identity header hands any caller full session control), so the panel became its own relying party — Auth Code + PKCE, login-flow state in a signed cookie instead of a store, self-issued 15m/8h tokens, and roles re-resolved from config per request rather than baked into the token](docs/findings/2026-08-29-panel-oidc-auth.md)
```

- [ ] **Step 7: Run the leak scan before staging**

```bash
git add -A
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek'
```

Expected: no output. The literal `dev-secret` values are intentional development placeholders for a local-only container; everything else must use `example.com`.

- [ ] **Step 8: Final full verification**

Run: `bun test && bun run typecheck && bun run panel:build && bun run test:web`
Expected: the full server suite passes with no new failures, zero type errors, a clean Vite build, and all web specs green. Record the actual counts in the commit body.

- [ ] **Step 9: Commit**

```bash
git commit -m "docs(panel): OIDC auth deployment guide, dev provider, findings

Adds a Keycloak dev realm so local runs use the real auth path (there is
no bypass flag), rewrites the panel deployment section around provider
registration and the role file, and records why the header trust
boundary was replaced."
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: module layout → Tasks 1-7; login/callback/cookies/refresh/logout/CSRF → Task 6; authenticated-request guard and the deletions → Task 7; SSE and token expiry → Task 9 (client reconnect) and the existing resume path, with the server-side terminal event noted below; the route/action matrix and role config → Tasks 2 and 8; audit records → Task 4, wired in Task 7; configuration → Task 1; frontend deltas → Task 9; testing → Tasks 1-10; rollout and docs → Task 11; risks → documented in Task 11's deployment section.

**One gap found and closed here:** the spec's server-side `session-expired` SSE terminal event has no task step. It belongs in `handleEvents` (`src/gateway/panel/api.ts:135-186`), and is added as the final step of Task 7:

- [ ] **Task 7, Step 5b: Terminate an SSE stream when its access token expires**

In `handleEvents`, capture the guard's access-token `exp` (thread it in as a parameter from the `fetch` block: `handleEvents(req, id, auth)`), and inside the `while (!closed)` loop, before the heartbeat:

```ts
            if (Date.now() >= expMs) {
              send(`event: session-expired\ndata: {}\n\n`);
              break;
            }
```

with `const expMs = auth.expMs;`. To supply it, extend `GuardOk` in `guard.ts` with `expMs: number` and set it from `r.claims.exp * 1000`. Add to `tests/panel/guard.test.ts`:

```ts
  it("reports the access token's expiry so the SSE tail can end cleanly", () => {
    const r = guardRequest(reqWith(`panel_at=${at("alice@example.com")}`), { html: false });
    expect(r.ok && r.expMs > Date.now()).toBe(true);
  });
```

**Placeholder scan.** No "TBD"/"implement later"/"add error handling" steps. One step defers to the codebase rather than inventing names: the CSS token names in Task 9 Step 6, which gives an exact lookup instead of guessing identifiers that may not exist. Every other identifier was verified against the tree — `SLAUDE_HOME` from `src/config/home.ts`, `opt()` in `src/config/env.ts`, `enforceCsrf` and `createPanelApi` in `src/gateway/panel/api.ts`.

**Type consistency.** `PanelRole` is defined once (Task 2) and imported by Tasks 4, 7, 8. `SessionClaims.typ` gates `verifySession`'s `expect` parameter across Tasks 3, 6, 7. `GuardOk` gains `expMs` in the addendum above and is consumed only in Task 7. `audit()` takes the record object everywhere — the old positional `audit(operatorId, action, sessionId, extra)` is deleted in Task 7 Step 5, and every call site is converted in that same step. `Backend.role` and `Backend.me()` are added to the interface and to both backends in Task 9.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-29-panel-oidc-auth.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
