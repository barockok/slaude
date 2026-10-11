# Personas as Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a git repository the source of truth for each agent's identity, soul, MCP config and model. A pipeline pushes it to the gateway, runtime overrides are temporary, and nodes read everything from the gateway.

**Architecture:** Two database layers per persona: a desired layer written by sync and an override layer written at runtime. One function merges them into effective state, and everything reads through that function. A deploy-token endpoint applies a whole persona set in one compare-and-set transaction, after validation and soul extraction have run outside it. Tenants that have never been synced keep reading the filesystem. Nodes take the soul from the runtime bundle they already fetch.

**Tech Stack:** Bun + TypeScript, `bun test`, Postgres/PGLite (`src/db/client.ts`), zod, AES-256-GCM via `src/db/crypto.ts`.

**Spec:** `docs/superpowers/specs/2026-10-01-personas-as-code-design.md`

## Global Constraints

- **Branch from `main` after PR #125 merges.** That PR adds migration `0010`, so this plan's migration is `0011`. If #125 has not merged, run `ls src/db/migrations` and use the next free number.
- **New tables and columns are Postgres-only**, like the existing `personas` table. sqlite gets no bootstrap entry, and `mono` on sqlite must behave exactly as before.
- **`user_token`, and any `mcp` value, are stored encrypted** with `encrypt`/`decrypt` from `src/db/crypto.ts`. Nothing else in the codebase touches these columns.
- **No secret value in any response, log line or thrown message.** Errors name a variable or a field, never what it holds.
- **The sync endpoint lives under `/deploy`, never `/v1`.** It authenticates with `SLAUDE_DEPLOY_TOKEN` using `timingSafeStringEqual`. When the token is unset, every `/deploy` path returns 404.
- **Runtime-overridable fields are `soul`, `model` and `mcp` only.**
- **Placeholder resolution (`${VAR}`) applies only to `userToken` and the `mcp` object.** Never to soul text, which can legitimately contain `${...}`.
- **Persona names match `^[a-z0-9][a-z0-9-]{0,62}$`.** A name becomes a directory, so path characters and case collisions are rejected at the boundary.
- **Decision carried from design review (flag it in the PR):** a named persona's channel mandate now comes from its own structured soul, not the default persona's. Default-persona sessions are unchanged. Without this change the node would need a filesystem read, which the spec rules out.
- Public repo rules: use the placeholders `UTESTUSER1` and `TTESTTEAM1`, run the leak scan before every commit, keep commits granular, and add no AI co-authorship trailers.

## Review Focus

The spec implies these five conditions, and none of its acceptance criteria exercises them. Each line names the task whose tests pin it.

1. **An environment variable that is set but empty.** It must count as unresolved and fail the sync, not store an empty token. → Task 2.
2. **Soul text containing a literal `${...}`** (for example, a soul that documents a template). It must reach the agent byte-for-byte, not be resolved or rejected. → Task 2.
3. **Two personas in one payload with the same name, or the same `slackUserId`.** Either one leaves two agents claiming one identity. The sync must be refused with 422. → Task 2.
4. **`committedAt` values with different UTC offsets.** Revisions must be compared as instants. Comparing ISO strings lexically puts `2026-10-01T10:00:00+07:00` after `2026-10-01T05:00:00Z`, although it is earlier. → Task 4.
5. **A sync that tombstones a persona while one of its turns is running.** The turn must finish. Only new work is refused. → Task 8.

---

### Task 1: Schema for the two layers

**Files:**
- Create: `src/db/migrations/0011_personas_as_code.sql`
- Modify: `tests/db/schema-drift.test.ts` (the `PG_ONLY_TABLES` set)
- Test: `tests/db/personas-schema.test.ts`

**Interfaces:**
- Produces: the table `personas` gains `slack_user_id`, `user_token`, `origin`, `source_revision` and `tombstoned_at`. New tables are `persona_overrides` and `persona_sync_state`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/personas-schema.test.ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

describe("personas-as-code schema", () => {
  test("personas gains the desired-layer columns; the override and sync tables exist", async () => {
    const pg = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(pg, { log: () => {} });
      const cols = async (t: string) =>
        (await pg.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ?`, [t],
        )).map((r) => r.column_name).sort();

      expect(await cols("personas")).toEqual(expect.arrayContaining(
        ["slack_user_id", "user_token", "origin", "source_revision", "tombstoned_at"]));
      expect(await cols("persona_overrides")).toEqual(
        ["field", "persona_name", "set_at", "set_by", "tenant_id", "value"]);
      expect(await cols("persona_sync_state")).toEqual(
        ["committed_at", "override_version", "revision", "synced_at", "synced_by", "tenant_id"]);
    } finally {
      await pg.close();
    }
  });

  test("origin defaults to 'git' and is constrained", async () => {
    const pg = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(pg, { log: () => {} });
      await pg.run(
        `INSERT INTO personas (id, tenant_id, name, soul_md, created_at, updated_at) VALUES ('p1','default','ana','',0,0)`);
      expect((await pg.one<{ origin: string }>(`SELECT origin FROM personas WHERE id='p1'`))!.origin).toBe("git");
      await expect(pg.run(`UPDATE personas SET origin = 'other' WHERE id='p1'`)).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/db/personas-schema.test.ts`
Expected: FAIL. The columns and tables do not exist.

- [ ] **Step 3: Write the migration**

```sql
-- 0011_personas_as_code.sql
--
-- Personas as code: a repository is the source of truth, a pipeline pushes the
-- whole set, and runtime overrides last until the next sync. Two layers:
--
--   personas            the desired layer — written by sync, and by a runtime
--                       onboard for origin='runtime' rows only
--   persona_overrides   the runtime layer — one row per overridden field,
--                       deleted wholesale by every sync
--
-- persona_sync_state holds the live revision per tenant. Its committed_at is
-- what refuses an out-of-order pipeline run, and its existence is what marks a
-- tenant as managed: a tenant with no row still reads the filesystem.
--
-- user_token and persona_overrides.value hold AES-256-GCM envelopes
-- (src/db/crypto.ts) wherever a secret can appear.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS slack_user_id   TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS user_token      TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS origin          TEXT NOT NULL DEFAULT 'git';
ALTER TABLE personas ADD COLUMN IF NOT EXISTS source_revision TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS tombstoned_at   BIGINT;

DO $$ BEGIN
  ALTER TABLE personas ADD CONSTRAINT personas_origin_chk CHECK (origin IN ('git', 'runtime'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS persona_overrides (
  tenant_id    TEXT   NOT NULL REFERENCES tenants (id),
  persona_name TEXT   NOT NULL,
  field        TEXT   NOT NULL CHECK (field IN ('soul', 'model', 'mcp')),
  value        TEXT   NOT NULL,
  set_by       TEXT   NOT NULL,
  set_at       BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, persona_name, field)
);

CREATE TABLE IF NOT EXISTS persona_sync_state (
  tenant_id        TEXT   PRIMARY KEY REFERENCES tenants (id),
  revision         TEXT   NOT NULL,
  committed_at     BIGINT NOT NULL,
  synced_at        BIGINT NOT NULL,
  synced_by        TEXT   NOT NULL,
  override_version BIGINT NOT NULL DEFAULT 0
);
```

Add the two new tables to `PG_ONLY_TABLES` in `tests/db/schema-drift.test.ts`, next to `"personas"`, with a one-line comment: "persona_overrides + persona_sync_state: personas-as-code, Postgres-only like personas".

- [ ] **Step 4: Run the tests**

Run: `bun test tests/db/personas-schema.test.ts tests/db/schema-drift.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/0011_personas_as_code.sql tests/db/personas-schema.test.ts tests/db/schema-drift.test.ts
git commit -m "feat(db): schema for personas as code — a desired layer, an override layer, a live revision"
```

---

### Task 2: The sync payload, placeholder resolution and the merge

**Files:**
- Create: `src/persona/sync/payload.ts`
- Create: `src/persona/effective.ts`
- Test: `tests/persona/payload.test.ts`, `tests/persona/effective.test.ts`

**Interfaces:**
- Produces:
  - `PERSONA_NAME_RE: RegExp`
  - `SyncPayload` (zod-inferred): `{ revision: string; committedAt: string; allowEmpty: boolean; personas: PersonaSpec[] }`
  - `PersonaSpec`: `{ name: string; slackUserId?: string; userToken?: string; model?: string; soul: string; mcp?: Record<string, unknown> }`
  - `parsePayload(raw: unknown): SyncPayload`. It throws `PayloadError`.
  - `resolvePlaceholders(spec: PersonaSpec, env: Record<string, string | undefined>): PersonaSpec`. It throws `UnresolvedVarError`, whose `.variable` field holds the variable name.
  - `class PayloadError extends Error { status: 422 }` and `class UnresolvedVarError extends PayloadError { variable: string }`
  - `DesiredPersona`: `{ name; slackUserId: string | null; userToken: string | null; model: string | null; soulMd: string; soulJson: unknown; mcp: unknown; origin: "git" | "runtime"; tombstonedAt: number | null }`
  - `OverrideField = "soul" | "model" | "mcp"` and `Override = { field: OverrideField; value: unknown }`. A soul override's `value` is `{ soulMd: string; soulJson: unknown }`.
  - `EffectivePersona = DesiredPersona & { overridden: OverrideField[] }`
  - `mergeEffective(desired: DesiredPersona, overrides: Override[]): EffectivePersona`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/persona/payload.test.ts
import { describe, expect, test } from "bun:test";
import { parsePayload, resolvePlaceholders, UnresolvedVarError, PayloadError } from "../../src/persona/sync/payload";

const base = (personas: unknown[]) => ({ revision: "abc123", committedAt: "2026-10-01T10:00:00Z", personas });
const ana = { name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${ANA_XOXP}" };

describe("parsePayload", () => {
  test("accepts a well-formed set and defaults allowEmpty to false", () => {
    expect(parsePayload(base([ana])).allowEmpty).toBe(false);
  });

  test("rejects a name that could escape a directory, or differs only in case", () => {
    for (const name of ["../etc", "Ana", "a/b", "", "-x"]) {
      expect(() => parsePayload(base([{ ...ana, name }]))).toThrow(PayloadError);
    }
  });

  // Review Focus 3: two agents claiming one identity.
  test("rejects duplicate names and duplicate Slack user ids in one payload", () => {
    expect(() => parsePayload(base([ana, { ...ana, slackUserId: "UTESTUSER2" }]))).toThrow(/duplicate persona name/);
    expect(() => parsePayload(base([ana, { ...ana, name: "bea" }]))).toThrow(/duplicate slackUserId/);
  });

  test("only the default persona may omit slackUserId", () => {
    expect(() => parsePayload(base([{ name: "default", soul: "x" }]))).not.toThrow();
    expect(() => parsePayload(base([{ name: "ana", soul: "x" }]))).toThrow(/slackUserId/);
  });

  test("rejects an unparseable committedAt", () => {
    expect(() => parsePayload({ ...base([ana]), committedAt: "yesterday" })).toThrow(PayloadError);
  });
});

describe("resolvePlaceholders", () => {
  test("resolves userToken and nested mcp values from env", () => {
    const spec = { ...ana, mcp: { mcpServers: { wb: { headers: { authorization: "Bearer ${WB_TOKEN}" } } } } };
    const out = resolvePlaceholders(spec, { ANA_XOXP: "tok-1", WB_TOKEN: "wb-1" });
    expect(out.userToken).toBe("tok-1");
    expect((out.mcp as any).mcpServers.wb.headers.authorization).toBe("Bearer wb-1");
  });

  test("an unset variable throws, naming the variable and never a value", () => {
    const err = (() => { try { resolvePlaceholders(ana, {}); } catch (e) { return e; } })() as UnresolvedVarError;
    expect(err).toBeInstanceOf(UnresolvedVarError);
    expect(err.variable).toBe("ANA_XOXP");
  });

  // Review Focus 1.
  test("a variable set to the empty string counts as unresolved", () => {
    expect(() => resolvePlaceholders(ana, { ANA_XOXP: "" })).toThrow(UnresolvedVarError);
  });

  // Review Focus 2: soul text is content, not configuration.
  test("soul text is never resolved, even when it contains ${...}", () => {
    const soul = "Explain templating: write ${NAME} and it is substituted.";
    expect(resolvePlaceholders({ ...ana, soul }, { ANA_XOXP: "t" }).soul).toBe(soul);
  });
});
```

```ts
// tests/persona/effective.test.ts
import { describe, expect, test } from "bun:test";
import { mergeEffective, type DesiredPersona } from "../../src/persona/effective";

const desired: DesiredPersona = {
  name: "ana", slackUserId: "UTESTUSER1", userToken: null, model: "m-git",
  soulMd: "git soul", soulJson: { approvers: [] }, mcp: { a: 1 }, origin: "git", tombstonedAt: null,
};

describe("mergeEffective", () => {
  test("with no overrides it is the desired layer", () => {
    expect(mergeEffective(desired, [])).toEqual({ ...desired, overridden: [] });
  });

  test("a model override replaces only the model", () => {
    const e = mergeEffective(desired, [{ field: "model", value: "m-live" }]);
    expect(e.model).toBe("m-live");
    expect(e.soulMd).toBe("git soul");
    expect(e.overridden).toEqual(["model"]);
  });

  test("a soul override replaces text and structure together", () => {
    const e = mergeEffective(desired, [{ field: "soul", value: { soulMd: "live soul", soulJson: { approvers: ["x"] } } }]);
    expect(e.soulMd).toBe("live soul");
    expect(e.soulJson).toEqual({ approvers: ["x"] });
  });

  test("identity fields cannot be overridden by construction", () => {
    const e = mergeEffective(desired, [{ field: "slackUserId" as any, value: "UEVIL" }]);
    expect(e.slackUserId).toBe("UTESTUSER1");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test tests/persona/payload.test.ts tests/persona/effective.test.ts`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Implement**

```ts
// src/persona/sync/payload.ts
/**
 * The sync payload a pipeline POSTs, and the one place placeholders resolve.
 *
 * Resolution touches userToken and the mcp object only. Soul text is content:
 * a soul can document a template and legitimately contain `${...}`, and
 * resolving it would silently rewrite what the agent says.
 */
import { z } from "zod";

export const PERSONA_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class PayloadError extends Error {
  readonly status = 422 as const;
}
export class UnresolvedVarError extends PayloadError {
  constructor(readonly variable: string) {
    super(`unresolved variable \${${variable}} — set it in the gateway's environment`);
  }
}

const personaSpec = z.object({
  name: z.string().regex(PERSONA_NAME_RE, "persona name must match ^[a-z0-9][a-z0-9-]{0,62}$"),
  slackUserId: z.string().min(1).optional(),
  userToken: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  soul: z.string(),
  mcp: z.record(z.unknown()).optional(),
});
export type PersonaSpec = z.infer<typeof personaSpec>;

const payloadSchema = z.object({
  revision: z.string().min(1),
  committedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "committedAt must be an ISO 8601 instant"),
  allowEmpty: z.boolean().default(false),
  personas: z.array(personaSpec),
});
export type SyncPayload = z.infer<typeof payloadSchema>;

export function parsePayload(raw: unknown): SyncPayload {
  const r = payloadSchema.safeParse(raw);
  if (!r.success) throw new PayloadError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const p = r.data;
  const names = new Set<string>();
  const users = new Set<string>();
  for (const s of p.personas) {
    if (names.has(s.name)) throw new PayloadError(`duplicate persona name '${s.name}'`);
    names.add(s.name);
    if (s.name !== "default" && !s.slackUserId) throw new PayloadError(`persona '${s.name}' needs a slackUserId`);
    if (s.slackUserId) {
      if (users.has(s.slackUserId)) throw new PayloadError(`duplicate slackUserId on persona '${s.name}'`);
      users.add(s.slackUserId);
    }
  }
  return p;
}

const VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

function resolveString(s: string, env: Record<string, string | undefined>): string {
  return s.replace(VAR_RE, (_, name: string) => {
    const v = env[name];
    // Empty counts as missing: storing an empty token is a silent outage.
    if (v === undefined || v === "") throw new UnresolvedVarError(name);
    return v;
  });
}

function resolveDeep(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === "string") return resolveString(v, env);
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, env));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDeep(x, env)]));
  }
  return v;
}

export function resolvePlaceholders(spec: PersonaSpec, env: Record<string, string | undefined>): PersonaSpec {
  return {
    ...spec,
    ...(spec.userToken !== undefined ? { userToken: resolveString(spec.userToken, env) } : {}),
    ...(spec.mcp !== undefined ? { mcp: resolveDeep(spec.mcp, env) as Record<string, unknown> } : {}),
  };
}
```

```ts
// src/persona/effective.ts
/**
 * Effective persona state: the desired layer with the override layer laid over
 * it. This is the single merge; nothing else combines the two layers, so the
 * gateway, the runtime bundle and the panel cannot disagree about what is live.
 */
export type OverrideField = "soul" | "model" | "mcp";
export const OVERRIDE_FIELDS: readonly OverrideField[] = ["soul", "model", "mcp"];

export interface DesiredPersona {
  name: string;
  slackUserId: string | null;
  userToken: string | null;
  model: string | null;
  soulMd: string;
  soulJson: unknown;
  mcp: unknown;
  origin: "git" | "runtime";
  tombstonedAt: number | null;
}

export interface Override {
  field: OverrideField;
  /** For `soul`: `{ soulMd, soulJson }`, so text and structure never disagree. */
  value: unknown;
}

export type EffectivePersona = DesiredPersona & { overridden: OverrideField[] };

export function mergeEffective(desired: DesiredPersona, overrides: Override[]): EffectivePersona {
  const out: EffectivePersona = { ...desired, overridden: [] };
  for (const o of overrides) {
    if (!OVERRIDE_FIELDS.includes(o.field)) continue; // identity is not overridable
    if (o.field === "soul") {
      const v = o.value as { soulMd: string; soulJson: unknown };
      out.soulMd = v.soulMd;
      out.soulJson = v.soulJson;
    } else if (o.field === "model") {
      out.model = o.value as string;
    } else {
      out.mcp = o.value;
    }
    out.overridden.push(o.field);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/persona/payload.test.ts tests/persona/effective.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persona/sync/payload.ts src/persona/effective.ts tests/persona/payload.test.ts tests/persona/effective.test.ts
git commit -m "feat(persona): the sync payload, placeholder resolution, and the single merge"
```

---

### Task 3: A strict soul extraction

**Files:**
- Modify: `src/soul/extract.ts`
- Test: `tests/soul/extract-strict.test.ts`

**Interfaces:**
- Produces: `extractSoulData(text: string, opts: { strict: boolean; call?: (system: string, prompt: string) => Promise<string> }): Promise<SoulData>`. When `strict` is true, any failure throws `SoulExtractionError`. When `strict` is false, it falls back exactly as today. `loadSoulData()` becomes `extractSoulData(loadSoul(), { strict: false })`.
- Produces: `class SoulExtractionError extends Error`

`loadSoulData` never throws, because it falls back to a regex parse that fills only `approvers`. A sync cannot use that behaviour. During a provider outage it would store a soul stripped of its ACLs and report success.

- [ ] **Step 1: Write the failing test**

```ts
// tests/soul/extract-strict.test.ts
import { describe, expect, test } from "bun:test";
import { extractSoulData, SoulExtractionError } from "../../src/soul/extract";

const SOUL = "# Ana\nManager: <@UTESTUSER1>\n";
const failing = async () => { throw new Error("provider down"); };

describe("extractSoulData", () => {
  test("strict: a failing extractor throws instead of degrading", async () => {
    await expect(extractSoulData(SOUL, { strict: true, call: failing })).rejects.toThrow(SoulExtractionError);
  });

  test("non-strict: a failing extractor falls back, as loadSoulData always has", async () => {
    const d = await extractSoulData(SOUL, { strict: false, call: failing });
    expect(Array.isArray(d.approvers)).toBe(true);
  });

  test("the same text is extracted once and then served from the sha cache", async () => {
    let calls = 0;
    const call = async () => { calls++; return JSON.stringify({ approvers: [] }); };
    const text = `${SOUL}\n<!-- ${Date.now()} -->`;
    await extractSoulData(text, { strict: true, call });
    await extractSoulData(text, { strict: true, call });
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/soul/extract-strict.test.ts`
Expected: FAIL. `extractSoulData` is not exported.

- [ ] **Step 3: Implement**

Restructure the body of `loadSoulData` (currently around `src/soul/extract.ts:141`) into `extractSoulData`. Keep the cache-by-sha, the zod validation and `assertIdsGroundedInPersona` exactly as they are. Add the `strict` branch and an injectable `call` that defaults to the existing `callExtractor`:

```ts
export class SoulExtractionError extends Error {}

/**
 * Structured extraction for an arbitrary soul text.
 *
 * strict: any failure throws. Used by persona sync, where a degraded extraction
 * would store a soul stripped of its ACLs while reporting success.
 * non-strict: falls back to the regex parse, exactly as loadSoulData always has.
 */
export async function extractSoulData(
  text: string,
  opts: { strict: boolean; call?: (system: string, prompt: string) => Promise<string> },
): Promise<SoulData> {
  const call = opts.call ?? callExtractor;
  const sha = sha256(text);
  const cp = cachePath(sha);
  if (existsSync(cp)) {
    try {
      return SoulDataSchema.parse(JSON.parse(readFileSync(cp, "utf8")));
    } catch (e) {
      console.warn(`[soul] cache invalid at ${cp}, re-extracting:`, e);
    }
  }
  try {
    // …the existing prompt construction, call, parseJsonLoose, SoulDataSchema.parse,
    // assertIdsGroundedInPersona(data, text) and cache write, unchanged, except
    // that `persona` becomes `text` and `callExtractor` becomes `call`…
    return data;
  } catch (e) {
    if (opts.strict) throw new SoulExtractionError(`soul extraction failed: ${(e as Error).message}`);
    console.warn("[soul] extraction failed, using regex fallback:", e);
    return regexFallback();
  }
}

export async function loadSoulData(): Promise<SoulData> {
  return extractSoulData(loadSoul(), { strict: false });
}
```

The elided lines are the existing body. Move them, don't rewrite them: the extractor's prompt and validation are not part of this change.

- [ ] **Step 4: Run the tests, including the existing extractor tests**

Run: `bun test tests/soul && bunx tsc --noEmit`
Expected: PASS, with no change to any existing test.

- [ ] **Step 5: Commit**

```bash
git add src/soul/extract.ts tests/soul/extract-strict.test.ts
git commit -m "feat(soul): a strict extraction that fails rather than degrade to approvers-only"
```

---

### Task 4: The persona repository

**Files:**
- Create: `src/db/personas.ts`
- Test: `tests/db/personas-repo.test.ts`

**Interfaces:**
- Consumes: `DesiredPersona`, `Override`, `OverrideField`, `mergeEffective`, `EffectivePersona` (Task 2); `encrypt`, `decrypt` (`src/db/crypto.ts`).
- Produces:
  - `isManaged(tenant: string): Promise<boolean>`
  - `syncState(tenant: string): Promise<{ revision: string; committedAt: number; overrideVersion: number } | null>`
  - `stateVersion(tenant: string): Promise<string>`. This is a cheap token that changes on every sync and every override write, and is `"unmanaged"` before the first sync.
  - `effectivePersonas(tenant: string, opts?: { includeTombstoned?: boolean }): Promise<EffectivePersona[]>`
  - `applySync(tenant: string, rows: DesiredPersona[], meta: { revision: string; committedAt: number; by: string }): Promise<ApplyResult>`. It throws `StaleRevisionError` (`.live` holds the live revision).
  - `ApplyResult = { created: string[]; updated: string[]; unchanged: string[]; tombstoned: string[]; overridesWiped: number }`
  - `setOverride(tenant, name, field: OverrideField, value: unknown, by: string): Promise<void>` and `clearOverride(tenant, name, field): Promise<boolean>`
  - `createRuntimePersona(tenant, row: DesiredPersona, by: string): Promise<void>`
  - `class NotManagedError`, `class NameTakenError`, `class StaleRevisionError`, each carrying `status: 409`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/db/personas-repo.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import type { DesiredPersona } from "../../src/persona/effective";

// Postgres-only tables: run this file with SLAUDE_DB=pg (PGLite).
const T = "default";
const row = (name: string, over: Partial<DesiredPersona> = {}): DesiredPersona => ({
  name, slackUserId: `U${name.toUpperCase()}`, userToken: null, model: null,
  soulMd: `${name} soul`, soulJson: { approvers: [] }, mcp: null, origin: "git", tombstonedAt: null, ...over,
});
const meta = (revision: string, iso: string) => ({ revision, committedAt: Date.parse(iso), by: "ci" });

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

describe("persona repository", () => {
  test("a tenant is unmanaged until its first sync", async () => {
    expect(await P.isManaged(T)).toBe(false);
    expect(await P.stateVersion(T)).toBe("unmanaged");
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    expect(await P.isManaged(T)).toBe(true);
  });

  test("a sync wipes every override", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.setOverride(T, "ana", "model", "m-live", "ops");
    const r = await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    expect(r.overridesWiped).toBe(1);
    expect((await P.effectivePersonas(T))[0]!.overridden).toEqual([]);
  });

  test("an omitted persona is tombstoned, keeps its row, and returns intact when re-added", async () => {
    await P.applySync(T, [row("ana"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    const r = await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    expect(r.tombstoned).toEqual(["bea"]);
    expect((await P.effectivePersonas(T)).map((p) => p.name)).toEqual(["ana"]);
    expect((await P.effectivePersonas(T, { includeTombstoned: true })).map((p) => p.name).sort()).toEqual(["ana", "bea"]);
    await P.applySync(T, [row("ana"), row("bea")], meta("r3", "2026-10-01T12:00:00Z"));
    expect((await P.effectivePersonas(T)).map((p) => p.name).sort()).toEqual(["ana", "bea"]);
  });

  test("a runtime-onboarded persona is tombstoned by the next sync", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.createRuntimePersona(T, row("quick", { origin: "runtime" }), "ops");
    const r = await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    expect(r.tombstoned).toEqual(["quick"]);
  });

  test("an older committedAt is refused", async () => {
    await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    await expect(P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"))).rejects.toBeInstanceOf(P.StaleRevisionError);
  });

  // Review Focus 4: instants, not strings.
  test("committedAt is compared as an instant across UTC offsets", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T05:00:00Z"));
    // 10:00 at +07:00 is 03:00 UTC, which is earlier, despite sorting later as a string.
    await expect(P.applySync(T, [row("ana")], meta("r0", "2026-10-01T10:00:00+07:00"))).rejects.toBeInstanceOf(P.StaleRevisionError);
  });

  // The race the compare-and-set exists for: a slow older run must never land
  // after a newer one. Whatever order the two commit in, r3 ends up live.
  test("concurrent older and newer syncs: the newer always ends up live", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    for (let i = 0; i < 20; i++) {
      await Promise.allSettled([
        P.applySync(T, [row("ana", { model: "older" })], meta("r2", "2026-10-01T11:00:00Z")),
        P.applySync(T, [row("ana", { model: "newer" })], meta(`r3-${i}`, `2026-10-01T12:00:${String(i).padStart(2, "0")}Z`)),
      ]);
      expect((await P.syncState(T))!.revision).toBe(`r3-${i}`);
      expect((await P.effectivePersonas(T))[0]!.model).toBe("newer");
    }
  });

  test("runtime writes are refused on an unmanaged tenant", async () => {
    await expect(P.setOverride(T, "ana", "model", "m", "ops")).rejects.toBeInstanceOf(P.NotManagedError);
    await expect(P.createRuntimePersona(T, row("quick", { origin: "runtime" }), "ops")).rejects.toBeInstanceOf(P.NotManagedError);
  });

  test("a runtime onboard may not take a name git already uses", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await expect(P.createRuntimePersona(T, row("ana", { origin: "runtime" }), "ops")).rejects.toBeInstanceOf(P.NameTakenError);
  });

  test("an override write changes the state version", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    const before = await P.stateVersion(T);
    await P.setOverride(T, "ana", "model", "m", "ops");
    expect(await P.stateVersion(T)).not.toBe(before);
  });

  test("the user token and mcp are encrypted at rest", async () => {
    await P.applySync(T, [row("ana", { userToken: "user-token-secret-value", mcp: { k: "mcp-secret-value" } })], meta("r1", "2026-10-01T10:00:00Z"));
    const raw = await db.one<{ user_token: string; mcp_json: string }>(`SELECT user_token, mcp_json::text AS mcp_json FROM personas WHERE name='ana'`);
    expect(raw!.user_token).not.toContain("user-token-secret-value");
    expect(raw!.mcp_json).not.toContain("mcp-secret-value");
    expect((await P.effectivePersonas(T))[0]!.userToken).toBe("user-token-secret-value");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SLAUDE_DB=pg bun test tests/db/personas-repo.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/db/personas.ts
/**
 * The two persona layers and the live revision. This is the only module that
 * reads or writes persona_overrides and persona_sync_state, and the only one
 * that encrypts personas.user_token or any mcp value.
 *
 * Effective state comes from mergeEffective (src/persona/effective.ts); nothing
 * here combines the layers itself.
 */
import { randomUUID } from "node:crypto";
import { db } from "./schema";
import { encrypt, decrypt } from "./crypto";
import { mergeEffective, type DesiredPersona, type EffectivePersona, type Override, type OverrideField } from "../persona/effective";

export class NotManagedError extends Error {
  readonly status = 409 as const;
  constructor(tenant: string) { super(`tenant '${tenant}' is not managed as code yet — run a sync first`); }
}
export class NameTakenError extends Error {
  readonly status = 409 as const;
  constructor(name: string) { super(`persona '${name}' is managed in git`); }
}
export class StaleRevisionError extends Error {
  readonly status = 409 as const;
  constructor(readonly live: string) { super(`a newer revision is live (${live})`); }
}

export interface ApplyResult {
  created: string[]; updated: string[]; unchanged: string[]; tombstoned: string[]; overridesWiped: number;
}

type Row = {
  name: string; slack_user_id: string | null; user_token: string | null; model_default: string | null;
  soul_md: string; soul_json: unknown; mcp_json: unknown; origin: "git" | "runtime"; tombstoned_at: number | null;
};

// mcp is stored as an encrypted string inside the JSONB column, so the column
// type stays as 0001 defined it while the value is never plaintext at rest.
const encJson = (v: unknown) => (v == null ? null : JSON.stringify(encrypt(JSON.stringify(v))));
const decJson = (v: unknown) => {
  if (v == null) return null;
  const s = typeof v === "string" ? JSON.parse(v) : v;
  return typeof s === "string" ? JSON.parse(decrypt(s)) : s;
};
const parseJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

function toDesired(r: Row): DesiredPersona {
  return {
    name: r.name,
    slackUserId: r.slack_user_id,
    userToken: r.user_token ? decrypt(r.user_token) : null,
    model: r.model_default,
    soulMd: r.soul_md,
    soulJson: parseJson(r.soul_json),
    mcp: decJson(r.mcp_json),
    origin: r.origin,
    tombstonedAt: r.tombstoned_at == null ? null : Number(r.tombstoned_at),
  };
}

export async function syncState(tenant: string) {
  const r = await db.one<{ revision: string; committed_at: number; override_version: number }>(
    `SELECT revision, committed_at, override_version FROM persona_sync_state WHERE tenant_id = ?`, [tenant]);
  return r ? { revision: r.revision, committedAt: Number(r.committed_at), overrideVersion: Number(r.override_version) } : null;
}

export async function isManaged(tenant: string): Promise<boolean> {
  return (await syncState(tenant)) !== null;
}

export async function stateVersion(tenant: string): Promise<string> {
  const s = await syncState(tenant);
  return s ? `${s.revision}:${s.overrideVersion}` : "unmanaged";
}

export async function effectivePersonas(tenant: string, opts: { includeTombstoned?: boolean } = {}): Promise<EffectivePersona[]> {
  const rows = await db.query<Row>(
    `SELECT name, slack_user_id, user_token, model_default, soul_md, soul_json, mcp_json, origin, tombstoned_at
     FROM personas WHERE tenant_id = ? ${opts.includeTombstoned ? "" : "AND tombstoned_at IS NULL"} ORDER BY name`,
    [tenant]);
  const ovs = await db.query<{ persona_name: string; field: OverrideField; value: string }>(
    `SELECT persona_name, field, value FROM persona_overrides WHERE tenant_id = ?`, [tenant]);
  return rows.map((r) => mergeEffective(
    toDesired(r),
    ovs.filter((o) => o.persona_name === r.name).map((o): Override => ({ field: o.field, value: JSON.parse(decrypt(o.value)) })),
  ));
}

const same = (a: DesiredPersona, b: DesiredPersona) =>
  a.slackUserId === b.slackUserId && a.userToken === b.userToken && a.model === b.model &&
  a.soulMd === b.soulMd && JSON.stringify(a.mcp) === JSON.stringify(b.mcp) && a.tombstonedAt === null;

export async function applySync(
  tenant: string,
  rows: DesiredPersona[],
  meta: { revision: string; committedAt: number; by: string },
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const now = Date.now();
    // The ordering check and the write are one statement, so two concurrent
    // syncs cannot both pass it. Same shape as CronJobs.claimDue.
    await tx.run(`INSERT INTO tenants (id, name, status, created_at) VALUES (?, ?, 'active', ?) ON CONFLICT (id) DO NOTHING`,
      [tenant, tenant, now]);
    const claimed = await tx.query<{ tenant_id: string }>(
      `INSERT INTO persona_sync_state (tenant_id, revision, committed_at, synced_at, synced_by, override_version)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (tenant_id) DO UPDATE SET
         revision = excluded.revision, committed_at = excluded.committed_at,
         synced_at = excluded.synced_at, synced_by = excluded.synced_by, override_version = 0
       WHERE persona_sync_state.committed_at <= excluded.committed_at
       RETURNING tenant_id`,
      [tenant, meta.revision, meta.committedAt, now, meta.by]);
    if (!claimed.length) {
      const live = await tx.one<{ revision: string }>(`SELECT revision FROM persona_sync_state WHERE tenant_id = ?`, [tenant]);
      throw new StaleRevisionError(live?.revision ?? "unknown");
    }

    const existing = new Map(
      (await tx.query<Row>(`SELECT name, slack_user_id, user_token, model_default, soul_md, soul_json, mcp_json, origin, tombstoned_at
                            FROM personas WHERE tenant_id = ?`, [tenant])).map((r) => [r.name, toDesired(r)]));
    const result: ApplyResult = { created: [], updated: [], unchanged: [], tombstoned: [], overridesWiped: 0 };
    const incoming = new Set(rows.map((r) => r.name));

    for (const r of rows) {
      const prev = existing.get(r.name);
      if (!prev) result.created.push(r.name);
      else if (prev.origin === "git" && same(prev, r)) result.unchanged.push(r.name);
      else result.updated.push(r.name);
      await tx.run(
        `INSERT INTO personas (id, tenant_id, name, soul_md, soul_json, soul_sha, model_default, mcp_json,
                               slack_user_id, user_token, origin, source_revision, tombstoned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'git', ?, NULL, ?, ?)
         ON CONFLICT (tenant_id, name) DO UPDATE SET
           soul_md = excluded.soul_md, soul_json = excluded.soul_json, model_default = excluded.model_default,
           mcp_json = excluded.mcp_json, slack_user_id = excluded.slack_user_id, user_token = excluded.user_token,
           origin = 'git', source_revision = excluded.source_revision, tombstoned_at = NULL, updated_at = excluded.updated_at`,
        [randomUUID(), tenant, r.name, r.soulMd, JSON.stringify(r.soulJson ?? null), r.model, encJson(r.mcp),
         r.slackUserId, r.userToken ? encrypt(r.userToken) : null, meta.revision, now, now]);
    }
    for (const [name, prev] of existing) {
      if (incoming.has(name) || prev.tombstonedAt !== null) continue;
      await tx.run(`UPDATE personas SET tombstoned_at = ? WHERE tenant_id = ? AND name = ?`, [now, tenant, name]);
      result.tombstoned.push(name);
    }
    const wiped = await tx.run(`DELETE FROM persona_overrides WHERE tenant_id = ?`, [tenant]);
    result.overridesWiped = wiped.changes ?? 0;
    return result;
  });
}

async function requireManaged(tenant: string) {
  if (!(await isManaged(tenant))) throw new NotManagedError(tenant);
}

export async function setOverride(tenant: string, name: string, field: OverrideField, value: unknown, by: string) {
  await requireManaged(tenant);
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO persona_overrides (tenant_id, persona_name, field, value, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, persona_name, field) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
      [tenant, name, field, encrypt(JSON.stringify(value)), by, Date.now()]);
    await tx.run(`UPDATE persona_sync_state SET override_version = override_version + 1 WHERE tenant_id = ?`, [tenant]);
  });
}

export async function clearOverride(tenant: string, name: string, field: OverrideField): Promise<boolean> {
  await requireManaged(tenant);
  return db.transaction(async (tx) => {
    const r = await tx.run(`DELETE FROM persona_overrides WHERE tenant_id = ? AND persona_name = ? AND field = ?`, [tenant, name, field]);
    if ((r.changes ?? 0) > 0) {
      await tx.run(`UPDATE persona_sync_state SET override_version = override_version + 1 WHERE tenant_id = ?`, [tenant]);
    }
    return (r.changes ?? 0) > 0;
  });
}

export async function createRuntimePersona(tenant: string, row: DesiredPersona, by: string) {
  await requireManaged(tenant);
  await db.transaction(async (tx) => {
    const taken = await tx.one<{ origin: string }>(`SELECT origin FROM personas WHERE tenant_id = ? AND name = ?`, [tenant, row.name]);
    if (taken?.origin === "git") throw new NameTakenError(row.name);
    const now = Date.now();
    await tx.run(
      `INSERT INTO personas (id, tenant_id, name, soul_md, soul_json, model_default, mcp_json, slack_user_id, user_token,
                             origin, source_revision, tombstoned_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'runtime', NULL, NULL, ?, ?)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         soul_md = excluded.soul_md, soul_json = excluded.soul_json, model_default = excluded.model_default,
         mcp_json = excluded.mcp_json, slack_user_id = excluded.slack_user_id, user_token = excluded.user_token,
         tombstoned_at = NULL, updated_at = excluded.updated_at`,
      [randomUUID(), tenant, row.name, row.soulMd, JSON.stringify(row.soulJson ?? null), row.model, encJson(row.mcp),
       row.slackUserId, row.userToken ? encrypt(row.userToken) : null, now, now]);
    await tx.run(`UPDATE persona_sync_state SET override_version = override_version + 1 WHERE tenant_id = ?`, [tenant]);
    void by; // recorded in the audit log by the caller (Task 7)
  });
}
```

- [ ] **Step 4: Run the tests on PGLite and on real Postgres**

Run: `SLAUDE_DB=pg bun test tests/db/personas-repo.test.ts && bunx tsc --noEmit`
Then on real Postgres, following the CI invocation in `.github/workflows/ci.yml`:
`SLAUDE_DB=pg SLAUDE_PG_URL=<test url> SLAUDE_PG_TEST_URL=<test url> bun test tests/db/personas-repo.test.ts`
Expected: PASS on both.

- [ ] **Step 5: Mutation-check the compare-and-set — on real Postgres**

Temporarily split it: run the `SELECT committed_at` first and the `UPDATE` second, with the `WHERE` guard removed. Run the concurrent test **against real Postgres**. PGLite runs on one connection and serialises transactions, so the race never happens there, and a mutation check that passes on PGLite proves nothing. Confirm the test fails, then restore the code.

- [ ] **Step 6: Commit**

```bash
git add src/db/personas.ts tests/db/personas-repo.test.ts
git commit -m "feat(db): the persona layers — one compare-and-set sync, overrides, tombstones"
```

---

### Task 5: Sync orchestration — validate, extract, then apply

**Files:**
- Create: `src/persona/sync/run.ts`
- Test: `tests/persona/run-sync.test.ts`

**Interfaces:**
- Consumes: `parsePayload`, `resolvePlaceholders`, `PayloadError`, `UnresolvedVarError` (Task 2); `extractSoulData`, `SoulExtractionError` (Task 3); `applySync`, `effectivePersonas`, `isManaged`, `StaleRevisionError`, `ApplyResult` (Task 4).
- Produces:
  - `runSync(tenant: string, raw: unknown, opts: { dryRun: boolean; env: Record<string, string | undefined>; by: string; extract?: (text: string) => Promise<unknown> }): Promise<SyncReport>`
  - `SyncReport = ApplyResult & { revision: string; dryRun: boolean }`
  - `class SyncFailure extends Error { status: 409 | 422 | 502 }`

The dry run reports exactly what the real run would do. It computes from current state with the same comparison, so the report a pull request shows matches what the merge applies.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/persona/run-sync.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { runSync, SyncFailure } from "../../src/persona/sync/run";

const T = "default";
const payload = (personas: unknown[], extra: object = {}) =>
  ({ revision: "r1", committedAt: "2026-10-01T10:00:00Z", personas, ...extra });
const ana = { name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${ANA_XOXP}" };
const okExtract = async () => ({ approvers: [] });
const env = { ANA_XOXP: "user-token-1" };

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

describe("runSync", () => {
  test("applies a set: effective state equals the payload, variables resolved", async () => {
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: okExtract });
    const [p] = await P.effectivePersonas(T);
    expect(p!.userToken).toBe("user-token-1");
    expect(p!.soulMd).toBe("You are Ana.");
  });

  test("dryRun applies nothing, and reports tombstones and wiped overrides", async () => {
    await runSync(T, payload([ana, { ...ana, name: "bea", slackUserId: "UTESTUSER2" }]), { dryRun: false, env, by: "ci", extract: okExtract });
    await P.setOverride(T, "ana", "model", "m", "ops");
    const r = await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }),
      { dryRun: true, env, by: "ci", extract: okExtract });
    expect(r.tombstoned).toEqual(["bea"]);
    expect(r.overridesWiped).toBe(1);
    expect((await P.effectivePersonas(T)).map((p) => p.name).sort()).toEqual(["ana", "bea"]);
    expect((await P.effectivePersonas(T))[0]!.overridden).toEqual(["model"]);
  });

  test("an unresolved variable is a 422 that names it and applies nothing", async () => {
    const e = await runSync(T, payload([ana]), { dryRun: false, env: {}, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("ANA_XOXP");
    expect(await P.isManaged(T)).toBe(false);
  });

  test("an extraction failure is a 502 and leaves the previous revision live", async () => {
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: okExtract });
    const failing = async () => { throw new Error("provider down"); };
    const e = await runSync(T, payload([{ ...ana, soul: "changed" }], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }),
      { dryRun: false, env, by: "ci", extract: failing }).catch((x) => x);
    expect(e.status).toBe(502);
    expect((await P.syncState(T))!.revision).toBe("r1");
  });

  test("an unchanged soul is not re-extracted", async () => {
    let calls = 0;
    const counting = async () => { calls++; return { approvers: [] }; };
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: counting });
    await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }), { dryRun: false, env, by: "ci", extract: counting });
    expect(calls).toBe(1);
  });

  test("an empty set is refused unless allowEmpty is set", async () => {
    const e = await runSync(T, payload([]), { dryRun: false, env, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e.status).toBe(422);
    await expect(runSync(T, payload([], { allowEmpty: true }), { dryRun: false, env, by: "ci", extract: okExtract })).resolves.toBeDefined();
  });

  test("an older revision is a 409", async () => {
    await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }), { dryRun: false, env, by: "ci", extract: okExtract });
    const e = await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SLAUDE_DB=pg bun test tests/persona/run-sync.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/persona/sync/run.ts
/**
 * One sync, in two phases. Phase one runs outside any transaction: parse,
 * resolve placeholders, and extract the structured soul for every soul whose
 * text changed. No model call ever runs while database locks are held. Phase
 * two is Task 4's single transaction. Any failure in phase one applies nothing.
 */
import { createHash } from "node:crypto";
import { parsePayload, resolvePlaceholders, PayloadError } from "./payload";
import { extractSoulData, SoulExtractionError } from "../../soul/extract";
import { applySync, effectivePersonas, syncState, StaleRevisionError, type ApplyResult } from "../../db/personas";
import type { DesiredPersona } from "../effective";

export class SyncFailure extends Error {
  constructor(readonly status: 409 | 422 | 502, message: string) { super(message); }
}
export type SyncReport = ApplyResult & { revision: string; dryRun: boolean };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function runSync(
  tenant: string,
  raw: unknown,
  opts: { dryRun: boolean; env: Record<string, string | undefined>; by: string; extract?: (text: string) => Promise<unknown> },
): Promise<SyncReport> {
  const extract = opts.extract ?? ((t: string) => extractSoulData(t, { strict: true }));
  let payload;
  try {
    payload = parsePayload(raw);
    if (payload.personas.length === 0 && !payload.allowEmpty) {
      throw new PayloadError("refusing an empty persona set — set allowEmpty: true to retire every persona");
    }
    payload = { ...payload, personas: payload.personas.map((p) => resolvePlaceholders(p, opts.env)) };
  } catch (e) {
    if (e instanceof PayloadError) throw new SyncFailure(422, e.message);
    throw e;
  }

  const current = new Map((await effectivePersonas(tenant, { includeTombstoned: true })).map((p) => [p.name, p]));
  const rows: DesiredPersona[] = [];
  for (const p of payload.personas) {
    const prev = current.get(p.name);
    let soulJson: unknown;
    if (prev && sha(prev.soulMd) === sha(p.soul) && !prev.overridden.includes("soul")) {
      soulJson = prev.soulJson; // unchanged soul: no model call
    } else {
      try {
        soulJson = await extract(p.soul);
      } catch (e) {
        if (e instanceof SoulExtractionError || e instanceof Error) {
          throw new SyncFailure(502, `soul extraction failed for persona '${p.name}'`);
        }
        throw e;
      }
    }
    rows.push({
      name: p.name, slackUserId: p.slackUserId ?? null, userToken: p.userToken ?? null, model: p.model ?? null,
      soulMd: p.soul, soulJson, mcp: p.mcp ?? null, origin: "git", tombstonedAt: null,
    });
  }

  const meta = { revision: payload.revision, committedAt: Date.parse(payload.committedAt), by: opts.by };

  if (opts.dryRun) {
    const live = await syncState(tenant);
    if (live && live.committedAt > meta.committedAt) throw new SyncFailure(409, `a newer revision is live (${live.revision})`);
    const incoming = new Set(rows.map((r) => r.name));
    const report: SyncReport = { created: [], updated: [], unchanged: [], tombstoned: [], overridesWiped: 0, revision: meta.revision, dryRun: true };
    for (const r of rows) {
      const prev = current.get(r.name);
      if (!prev) report.created.push(r.name);
      else if (prev.origin === "git" && prev.tombstonedAt === null && prev.soulMd === r.soulMd && prev.model === r.model &&
               prev.slackUserId === r.slackUserId && prev.userToken === r.userToken && JSON.stringify(prev.mcp) === JSON.stringify(r.mcp)) {
        report.unchanged.push(r.name);
      } else report.updated.push(r.name);
    }
    for (const [name, prev] of current) if (!incoming.has(name) && prev.tombstonedAt === null) report.tombstoned.push(name);
    report.overridesWiped = [...current.values()].reduce((n, p) => n + p.overridden.length, 0);
    return report;
  }

  try {
    return { ...(await applySync(tenant, rows, meta)), revision: meta.revision, dryRun: false };
  } catch (e) {
    if (e instanceof StaleRevisionError) throw new SyncFailure(409, e.message);
    throw e;
  }
}
```

The "unchanged" comparison is written twice: once in `applySync` against the desired layer, and once here for the dry run. **Do not let them drift.** If the reviewer prefers, extract a shared `sameDesired(a, b)` into `src/persona/effective.ts` and use it in both places.

- [ ] **Step 4: Run the tests**

Run: `SLAUDE_DB=pg bun test tests/persona/run-sync.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persona/sync/run.ts tests/persona/run-sync.test.ts
git commit -m "feat(persona): run a sync — validate and extract outside the transaction, then apply"
```

---

### Task 6: The deploy endpoint

**Files:**
- Create: `src/gateway/deploy/api.ts`
- Modify: `src/config/env.ts` (add `deployToken`), `src/health.ts` (mount `/deploy`), `src/server.ts` (pass the handler)
- Test: `tests/gateway/deploy/api.test.ts`

**Interfaces:**
- Consumes: `runSync`, `SyncFailure` (Task 5); `timingSafeStringEqual` (`src/gateway/api/auth.ts`); `json`, `readJson` (`src/gateway/api/http.ts`); `publishConfigReload` (`src/gateway/core/config-reload.ts`).
- Produces: `createDeployApi(opts: { pubsub: PubSub | null; env?: () => Record<string, string | undefined> }): { fetch(req: Request): Promise<Response | null> }`, and `env.deployToken(): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/gateway/deploy/api.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { createDeployApi } from "../../../src/gateway/deploy/api";
import { createV1Api } from "../../../src/gateway/api";

const DEPLOY = "d".repeat(40);
const NODE = "n".repeat(40);
const url = "https://slaude.example.com/deploy/v1/tenants/default/personas";
const body = { revision: "r1", committedAt: "2026-10-01T10:00:00Z",
  personas: [{ name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${ANA_XOXP}" }] };
const post = (token: string | null, b: unknown = body, q = "") =>
  new Request(url + q, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) });

let prev: Record<string, string | undefined>;
beforeEach(async () => {
  prev = { SLAUDE_DEPLOY_TOKEN: process.env.SLAUDE_DEPLOY_TOKEN, SLAUDE_NODE_TOKEN: process.env.SLAUDE_NODE_TOKEN };
  process.env.SLAUDE_DEPLOY_TOKEN = DEPLOY;
  process.env.SLAUDE_NODE_TOKEN = NODE;
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});
afterEach(() => { for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v); });

const api = () => createDeployApi({ pubsub: null, env: () => ({ ANA_XOXP: "user-token-secret-value" }), extract: async () => ({ approvers: [] }) });

describe("POST /deploy/v1/tenants/:tenant/personas", () => {
  test("the deploy token applies a sync and reports it", async () => {
    const res = await api().fetch(post(DEPLOY));
    expect(res!.status).toBe(200);
    expect((await res!.json() as any).created).toEqual(["ana"]);
  });

  test("without a configured deploy token every /deploy path is 404", async () => {
    delete process.env.SLAUDE_DEPLOY_TOKEN;
    expect((await api().fetch(post(DEPLOY)))!.status).toBe(404);
  });

  test("a wrong token, and no token, are 401", async () => {
    expect((await api().fetch(post("x".repeat(40))))!.status).toBe(401);
    expect((await api().fetch(post(null)))!.status).toBe(401);
  });

  // Acceptance 4, both directions: nodes hold the node token.
  test("the node token cannot sync", async () => {
    expect((await api().fetch(post(NODE)))!.status).toBe(401);
  });
  test("the deploy token cannot call /v1", async () => {
    const v1 = createV1Api({} as any);
    const res = await v1.fetch(new Request("https://slaude.example.com/v1/pending/x", { headers: { authorization: `Bearer ${DEPLOY}` } }));
    expect(res!.status).toBe(401);
  });

  test("dryRun=1 applies nothing", async () => {
    const res = await api().fetch(post(DEPLOY, body, "?dryRun=1"));
    expect((await res!.json() as any).dryRun).toBe(true);
    expect(await db.query(`SELECT name FROM personas`)).toHaveLength(0);
  });

  test("failures map to their statuses, and no secret value reaches the body", async () => {
    const res = await createDeployApi({ pubsub: null, env: () => ({}), extract: async () => ({ approvers: [] }) }).fetch(post(DEPLOY));
    expect(res!.status).toBe(422);
    const text = await res!.text();
    expect(text).toContain("ANA_XOXP");
  });

  test("a successful sync never echoes the resolved token", async () => {
    const res = await api().fetch(post(DEPLOY));
    expect(await res!.text()).not.toContain("user-token-secret-value");
  });

  test("only POST is allowed", async () => {
    const res = await api().fetch(new Request(url, { headers: { authorization: `Bearer ${DEPLOY}` } }));
    expect(res!.status).toBe(405);
  });
});
```

The `extract` option exists so the test never calls a model. Add it to `createDeployApi`'s options (`extract?: (text: string) => Promise<unknown>`) and pass it through to `runSync`.

- [ ] **Step 2: Run them and watch them fail**

Run: `SLAUDE_DB=pg bun test tests/gateway/deploy/api.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

In `src/config/env.ts`, next to `nodeToken`:

```ts
  /** Pipeline credential for /deploy. Unset → /deploy does not exist. Never the
   *  node token: every node holds that one, and "nodes can't change identity"
   *  is the point of this endpoint having its own. */
  deployToken: () => opt("SLAUDE_DEPLOY_TOKEN"),
```

```ts
// src/gateway/deploy/api.ts
/**
 * The pipeline's door. Its own prefix and its own token, deliberately not /v1:
 * /v1 authenticates with SLAUDE_NODE_TOKEN, which every node holds, and a shared
 * prefix or token would leave nodes one misrouted handler away from rewriting
 * identity.
 *
 *   POST /deploy/v1/tenants/:tenant/personas[?dryRun=1]
 */
import { env } from "../../config/env";
import { timingSafeStringEqual } from "../api/auth";
import { json, readJson } from "../api/http";
import { runSync, SyncFailure } from "../../persona/sync/run";
import { publishConfigReload } from "../core/config-reload";
import type { PubSub } from "../../queue/pubsub";

export interface DeployApiOptions {
  pubsub: PubSub | null;
  env?: () => Record<string, string | undefined>;
  extract?: (text: string) => Promise<unknown>;
}

export function createDeployApi(opts: DeployApiOptions) {
  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/deploy" && !url.pathname.startsWith("/deploy/")) return null;
    const configured = env.deployToken();
    if (!configured) return json(404, { error: "not found" });

    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!m || !timingSafeStringEqual(m[1]!, configured)) return json(401, { error: "invalid or missing deploy token" });

    const seg = url.pathname.split("/").filter(Boolean); // deploy v1 tenants :t personas
    if (!(seg.length === 5 && seg[1] === "v1" && seg[2] === "tenants" && seg[4] === "personas")) {
      return json(404, { error: "not found" });
    }
    if (req.method !== "POST") return json(405, { error: "method not allowed" });

    const tenant = decodeURIComponent(seg[3]!);
    const dryRun = url.searchParams.get("dryRun") === "1";
    const raw = await readJson(req);
    if (raw === null) return json(422, { error: "body must be JSON" });

    try {
      const report = await runSync(tenant, raw, {
        dryRun, by: "pipeline", env: (opts.env ?? (() => process.env))(), extract: opts.extract,
      });
      if (!dryRun) await publishConfigReload(opts.pubsub, tenant);
      return json(200, report);
    } catch (e) {
      if (e instanceof SyncFailure) return json(e.status, { error: e.message });
      console.error(`[deploy] sync failed tenant=${tenant}:`, (e as Error).message);
      return json(500, { error: "internal" });
    }
  }
  return { fetch };
}
```

In `src/health.ts`, add `deploy?: (req: Request) => Promise<Response | null>` to the deps interface and mount it the same way `v1` is mounted (`url.pathname === "/deploy" || url.pathname.startsWith("/deploy/")`). In `src/server.ts`, pass `deploy` wherever `v1` is passed, under the same `role !== "node"` condition. Build it with `createDeployApi({ pubsub })`, using the same pubsub instance the gateway already holds.

- [ ] **Step 4: Run the tests**

Run: `SLAUDE_DB=pg bun test tests/gateway/deploy/api.test.ts tests/health.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/deploy/api.ts src/config/env.ts src/health.ts src/server.ts tests/gateway/deploy/api.test.ts
git commit -m "feat(deploy): a pipeline-only sync endpoint with its own prefix and token"
```

---

### Task 7: Runtime overrides in the panel

**Files:**
- Modify: `src/gateway/panel/api.ts`
- Test: `tests/panel/personas-overrides.test.ts`

**Interfaces:**
- Consumes: `effectivePersonas`, `setOverride`, `clearOverride`, `createRuntimePersona`, `syncState`, `NotManagedError`, `NameTakenError` (Task 4); `extractSoulData`, `SoulExtractionError` (Task 3); `PERSONA_NAME_RE` (Task 2); `OVERRIDE_FIELDS` (Task 2); `publishConfigReload`.
- Produces:
  - `GET /panel/api/personas`
  - `PUT|DELETE /panel/api/personas/:name/overrides/:field`
  - `POST /panel/api/personas`

Follow the existing `/panel/api/reload` handler in `src/gateway/panel/api.ts`. Every mutating route calls `enforceCsrf(req)` first and then the superadmin check that `/reload` uses. Copy that check exactly. Do not write a new role check.

- [ ] **Step 1: Write the failing tests**

Model the harness on the existing `/panel/api/reload` test in `tests/panel/` (the one that mints a superadmin and an operator session). Then:

```ts
describe("panel persona overrides", () => {
  test("GET reports per-field git and live values, never a token", async () => {
    // seed: a sync with ana (userToken set), then a model override
    const body = await (await panel.fetch(get("/panel/api/personas", superadmin))).json() as any;
    const ana = body.personas.find((p: any) => p.name === "ana");
    expect(ana.fields.model).toEqual({ git: "m-git", live: "m-live", overridden: true });
    expect(ana.userToken).toBe("present");
    expect(JSON.stringify(body)).not.toContain("user-token-");
  });

  test("an operator is refused; a superadmin may override", async () => {
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/model", { value: "m" }, operator)))!.status).toBe(403);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/model", { value: "m" }, superadmin)))!.status).toBe(200);
  });

  test("only soul, model and mcp are overridable", async () => {
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/slackUserId", { value: "UEVIL" }, superadmin)))!.status).toBe(422);
  });

  test("a soul override runs strict extraction; a failure refuses it", async () => {
    // inject a failing extractor through the panel deps seam
    expect((await failingPanel.fetch(put("/panel/api/personas/ana/overrides/soul", { value: "new" }, superadmin)))!.status).toBe(502);
  });

  test("runtime writes to a never-synced tenant are refused", async () => {
    // fresh DB, no sync
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/model", { value: "m" }, superadmin)))!.status).toBe(409);
  });

  test("a runtime onboard may not take a git-managed name", async () => {
    expect((await panel.fetch(post("/panel/api/personas", { name: "ana", slackUserId: "UTESTUSER9", soul: "x" }, superadmin)))!.status).toBe(409);
  });

  test("mutations without the anti-CSRF header are refused first", async () => {
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/model", { value: "m" }, superadmin, { csrf: false })))!.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SLAUDE_DB=pg bun test tests/panel/personas-overrides.test.ts`
Expected: FAIL with 404s.

- [ ] **Step 3: Implement**

Add an optional `extractSoul?: (text: string) => Promise<unknown>` to the panel API's deps, defaulting to `(t) => extractSoulData(t, { strict: true })`. Inside the request router, next to the `reload` branch, add these handlers:

```ts
      // GET /panel/api/personas
      if (seg.length === 3 && seg[1] === "api" && seg[2] === "personas" && req.method === "GET") {
        const tenant = "default";
        const live = await effectivePersonas(tenant, { includeTombstoned: true });
        // The git value of an overridden field is the desired layer's value.
        // Read it by merging with no overrides: one merge function, applied twice.
        const desired = new Map((await desiredPersonas(tenant)).map((d) => [d.name, d]));
        return json(200, {
          revision: (await syncState(tenant))?.revision ?? null,
          personas: live.map((p) => {
            const d = desired.get(p.name)!;
            const field = (f: "soul" | "model" | "mcp", g: unknown, l: unknown) =>
              ({ git: g, live: l, overridden: p.overridden.includes(f) });
            return {
              name: p.name, origin: p.origin, tombstoned: p.tombstonedAt !== null, slackUserId: p.slackUserId,
              userToken: p.userToken ? "present" : "absent",
              fields: {
                soul: field("soul", d.soulMd, p.soulMd),
                model: field("model", d.model, p.model),
                mcp: field("mcp", d.mcp !== null ? "present" : "absent", p.mcp !== null ? "present" : "absent"),
              },
            };
          }),
        });
      }
```

`desiredPersonas(tenant)` is a small addition to `src/db/personas.ts`: the same query as `effectivePersonas`, mapped through `toDesired` without merging. Add it in this task, with a one-line test in `tests/db/personas-repo.test.ts` asserting that it ignores overrides.

For `PUT /panel/api/personas/:name/overrides/:field`, run `enforceCsrf`, then the superadmin check. Next, check that `field` is in `OVERRIDE_FIELDS` and return 422 otherwise. For a `soul` override, build the value as `{ soulMd: body.value, soulJson: await extractSoul(body.value) }` and map `SoulExtractionError` to 502. Then call `setOverride` and map `NotManagedError` to 409. Finish by calling `publishConfigReload(pubsub, "default")`, auditing the action as `persona.override`, and returning `{ ok: true }`.

For `DELETE`, run the same guards, then call `clearOverride` and return `{ ok: true, removed }`.

For `POST /panel/api/personas`, run the same guards. Validate the name against `PERSONA_NAME_RE` and require `slackUserId` unless the name is `default`. Extract the soul strictly. Then call `createRuntimePersona`, mapping `NameTakenError` and `NotManagedError` to 409, and finish with `publishConfigReload`.

- [ ] **Step 4: Run the tests**

Run: `SLAUDE_DB=pg bun test tests/panel && bunx tsc --noEmit`
Expected: PASS, with every existing panel test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/panel/api.ts src/db/personas.ts tests/panel/personas-overrides.test.ts tests/db/personas-repo.test.ts
git commit -m "feat(panel): runtime persona overrides and quick onboard, superadmin only"
```

---

### Task 8: The registry reads effective state, with bounded staleness

**Files:**
- Modify: `src/persona/registry.ts`, `src/persona/types.ts`
- Create: `src/persona/soul-source.ts`
- Modify: `src/server.ts` (boot: build the registry, and set soul data from the managed default)
- Test: `tests/persona/registry-db.test.ts`

**Interfaces:**
- Consumes: `effectivePersonas`, `isManaged`, `stateVersion` (Task 4).
- Produces:
  - `Persona` gains `soulMd?: string`, set for DB-backed personas, and `soulPath` becomes optional.
  - `buildPersonaRegistry(tenant: string): Promise<PersonaRegistry>`. A never-synced tenant gets `loadPersonaRegistry()` (the filesystem). A managed tenant gets a snapshot of its effective, non-tombstoned personas. The two are never merged.
  - `startRegistryRevalidation(tenant: string, everyMs?: number): () => void`. It polls `stateVersion` and rebuilds the snapshot when it changes. It returns a stop function.
  - `personaSoulText(name?: string): string`, in `src/persona/soul-source.ts`. It is the one place soul text is read from on the gateway.

The registry interface stays synchronous. Its six consumers call `lookupByName` and `lookupByUserId` on hot paths, and making those async would ripple through all of them. So the snapshot is rebuilt from the database, and the poll provides spec §7.3's guarantee: a lost reload signal delays an update by at most one poll interval, and never strands a replica on a stale identity. This differs mechanically from the spec's "each lookup revalidates". The guarantee is the same: bounded staleness.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/persona/registry-db.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { buildPersonaRegistry, setPersonaRegistry, getPersonaRegistry, startRegistryRevalidation } from "../../src/persona/registry";

const row = (name: string) => ({ name, slackUserId: `U${name.toUpperCase()}`, userToken: null, model: null,
  soulMd: `${name} soul`, soulJson: null, mcp: null, origin: "git" as const, tombstonedAt: null });
const meta = (rev: string, iso: string) => ({ revision: rev, committedAt: Date.parse(iso), by: "ci" });

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

describe("a database-backed registry", () => {
  test("a never-synced tenant reads the filesystem", async () => {
    const r = await buildPersonaRegistry("default");
    // the test home has no personas directory: the filesystem registry is empty
    expect(r.list()).toEqual([]);
  });

  test("a managed tenant reads effective state, and tombstoned personas are gone", async () => {
    await P.applySync("default", [row("ana"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.applySync("default", [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    const r = await buildPersonaRegistry("default");
    expect(r.list().map((p) => p.name)).toEqual(["ana"]);
    expect(r.lookupByName("ana")!.soulMd).toBe("ana soul");
    expect(r.lookupByUserId("UBEA")).toBeNull();
  });

  // Acceptance 13: a replica that misses the signal still converges.
  test("the poll converges a replica that never received a reload signal", async () => {
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    setPersonaRegistry(await buildPersonaRegistry("default"));
    const stop = startRegistryRevalidation("default", 20);
    try {
      await P.setOverride("default", "ana", "soul", { soulMd: "live soul", soulJson: null }, "ops");
      // No publishConfigReload: only the poll can notice.
      const deadline = Date.now() + 2000;
      while (getPersonaRegistry().lookupByName("ana")!.soulMd !== "live soul" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(getPersonaRegistry().lookupByName("ana")!.soulMd).toBe("live soul");
    } finally {
      stop();
    }
  });
});
```

A tombstone does not touch a turn that is already running (Review Focus 5). Pin that in Task 10's test file, where a real session boots. This task covers the routing side: a tombstoned persona's Slack user no longer resolves.

- [ ] **Step 2: Run them and watch them fail**

Run: `SLAUDE_DB=pg bun test tests/persona/registry-db.test.ts`
Expected: FAIL. `buildPersonaRegistry` is not exported.

- [ ] **Step 3: Implement**

In `src/persona/types.ts`, make `soulPath` optional and add `soulMd?: string`, with a comment: "set for database-backed personas; soulPath is set for filesystem ones".

In `src/persona/registry.ts`, add:

```ts
import { effectivePersonas, isManaged, stateVersion } from "../db/personas";

function snapshot(personas: Persona[]): PersonaRegistry {
  const byUserId = new Map(personas.map((p) => [p.slackUserId, p]));
  const byName = new Map(personas.map((p) => [p.name, p]));
  return {
    lookupByUserId: (id) => byUserId.get(id) ?? null,
    lookupByName: (name) => byName.get(name) ?? null,
    list: () => personas,
    isMultiPersonaMode: () => personas.length > 0,
  };
}

/**
 * One source per tenant, never a merge: a tenant that has never been synced
 * reads the filesystem exactly as before; the first sync flips it to effective
 * state from the database. Tombstoned personas are excluded, so their Slack
 * identity stops routing while their rows stay intact.
 */
export async function buildPersonaRegistry(tenant: string): Promise<PersonaRegistry> {
  let managed = false;
  try {
    managed = await isManaged(tenant);
  } catch {
    // sqlite has no persona tables: always the filesystem.
  }
  if (!managed) return loadPersonaRegistry();
  const personas: Persona[] = (await effectivePersonas(tenant))
    .filter((p) => p.name !== "default" && p.slackUserId)
    .map((p) => ({
      name: p.name,
      slackUserId: p.slackUserId!,
      soulMd: p.soulMd,
      config: { slackUserId: p.slackUserId!, name: p.name, ...(p.userToken ? { userToken: p.userToken } : {}) },
      outClient: p.userToken ? new WebClient(p.userToken) : null,
    }));
  return snapshot(personas);
}

/** Rebuild the snapshot whenever the tenant's state version changes. The reload
 *  signal makes this faster; the poll makes it certain. */
export function startRegistryRevalidation(tenant: string, everyMs = 10_000): () => void {
  let last: string | null = null;
  const t = setInterval(async () => {
    try {
      const v = await stateVersion(tenant);
      if (v === last) return;
      last = v;
      setPersonaRegistry(await buildPersonaRegistry(tenant));
    } catch (e) {
      console.warn("[persona] registry revalidation failed:", (e as Error).message);
    }
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}
```

Also make `loadPersonas()` build the same `snapshot`. Replace the inline map construction in `loadPersonaRegistry` with `return snapshot(loadPersonas())`, so the two paths cannot drift.

```ts
// src/persona/soul-source.ts
/**
 * The one place soul text is read from on the gateway and in mono.
 * Named persona: its database soul when managed, else its file. Default persona:
 * the managed `default` row when one exists, else $SLAUDE_HOME/SOUL.md.
 */
import { loadSoul } from "../soul/loader";
import { getPersonaRegistry } from "./registry";

let managedDefaultSoul: string | null = null;
export function setManagedDefaultSoul(s: string | null) { managedDefaultSoul = s; }

export function personaSoulText(name?: string): string {
  if (name && name !== "default") {
    const p = getPersonaRegistry().lookupByName(name);
    if (p?.soulMd !== undefined) return p.soulMd;
    if (p?.soulPath) return loadSoul(p.soulPath);
  }
  return managedDefaultSoul ?? loadSoul();
}
```

In `src/server.ts` boot, for the gateway and mono roles, replace `setPersonaRegistry(loadPersonaRegistry())` with `setPersonaRegistry(await buildPersonaRegistry("default"))`. Then start `startRegistryRevalidation("default")`. When the tenant is managed, set the default soul from the database:

```ts
// SoulDataSchema: import it from the module src/soul/extract.ts imports it from,
// and export it from there if it is not already exported.
const def = (await effectivePersonas("default").catch(() => [])).find((p) => p.name === "default");
if (def) {
  setManagedDefaultSoul(def.soulMd);
  if (def.soulJson) setSoulData(SoulDataSchema.parse(def.soulJson));
}
```

Have the revalidation callback do the same whenever it rebuilds, so a sync that changes the default persona reaches approvals and ACLs too. Keep `setSoulData(await loadSoulData())` for the unmanaged case, unchanged.

- [ ] **Step 4: Run the tests**

Run: `SLAUDE_DB=pg bun test tests/persona && bun test tests/persona && bunx tsc --noEmit`
The second, sqlite run proves that the unmanaged filesystem path is untouched.
Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add src/persona/registry.ts src/persona/types.ts src/persona/soul-source.ts src/server.ts tests/persona/registry-db.test.ts
git commit -m "feat(persona): the registry reads effective state, and a poll bounds staleness"
```

---

### Task 9: The runtime bundle reads effective state

**Files:**
- Modify: `src/gateway/api/tenants.ts`
- Test: `tests/gateway/api/runtime-effective.test.ts`

**Interfaces:**
- Consumes: `effectivePersonas`, `isManaged` (Task 4).
- Produces: no new symbols. `buildBundle` tier 1 reads effective state and excludes tombstoned personas. Tier 2 (the filesystem) runs only when the tenant is not managed.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/gateway/api/runtime-effective.test.ts
// Same imports, `row`, `meta` and beforeEach as tests/persona/registry-db.test.ts
// (Task 8), plus:
import { handleTenantRuntime } from "../../../src/gateway/api/tenants";
// Run with SLAUDE_DB=pg. handleTenantRuntime is exported and needs no server.
describe("runtime bundle from effective state", () => {
  test("an override changes the bundle and its ETag", async () => {
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    const a = await handleTenantRuntime(new Request("https://x/"), "default", "ana");
    await P.setOverride("default", "ana", "soul", { soulMd: "live soul", soulJson: null }, "ops");
    const b = await handleTenantRuntime(new Request("https://x/"), "default", "ana");
    expect((await b.json() as any).soulMd).toBe("live soul");
    expect(b.headers.get("etag")).not.toBe(a.headers.get("etag"));
  });

  test("a tombstoned persona has no bundle", async () => {
    await P.applySync("default", [row("ana"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.applySync("default", [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    expect((await handleTenantRuntime(new Request("https://x/"), "default", "bea")).status).toBe(404);
  });

  test("a managed tenant never falls back to a persona directory on disk", async () => {
    // write $SLAUDE_HOME/personas/ghost/{config.json,SOUL.md}, then manage the tenant without 'ghost'
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    expect((await handleTenantRuntime(new Request("https://x/"), "default", "ghost")).status).toBe(404);
  });

  test("the bundle never carries the xoxp token", async () => {
    await P.applySync("default", [row("ana", { userToken: "user-token-secret-value" })], meta("r1", "2026-10-01T10:00:00Z"));
    expect(await (await handleTenantRuntime(new Request("https://x/"), "default", "ana")).text()).not.toContain("user-token-secret-value");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SLAUDE_DB=pg bun test tests/gateway/api/runtime-effective.test.ts`
Expected: FAIL. Tier 1 reads the raw `personas` row, so the override is ignored and the tombstoned persona is still served.

- [ ] **Step 3: Implement**

In `buildBundle`, read effective state in place of the direct `SELECT * FROM personas` query. Keep the `tenants` lookup and the provider-credentials block exactly as they are:

```ts
  let managed = false;
  let effective: EffectivePersona | undefined;
  try {
    managed = await isManaged(tenantId);
    if (managed) effective = (await effectivePersonas(tenantId)).find((p) => p.name === personaId);
  } catch {
    /* sqlite: no tenancy tables */
  }
```

Tier 1 then builds the bundle from `effective`, using `soulMd`, `soulJson`, `mcp` and `model`. It never reads `userToken`. Provider credentials still come from the `provider_creds` query, keyed by the persona row's `id`, so fetch that `id` alongside. If `managed` is true and `effective` is undefined, return `null`, which the caller turns into a 404. Do this **before** tier 2, so a managed tenant never reads the disk. Gate tier 2 on `!managed`.

The existing ETag is a hash of the whole body. Once the body is built from effective state, an override changes the ETag with no further work.

- [ ] **Step 4: Mutation-check the ETag claim**

Temporarily build tier 1's `soulMd` from the desired layer by calling `desiredPersonas` in place of `effectivePersonas`. Run the "override changes the bundle and its ETag" test and confirm it fails. Then restore the code.

- [ ] **Step 5: Run the tests**

Run: `SLAUDE_DB=pg bun test tests/gateway/api && bun test tests/gateway/api && bunx tsc --noEmit`
Expected: PASS, including the existing per-persona bundle tests from phase 1.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/api/tenants.ts tests/gateway/api/runtime-effective.test.ts
git commit -m "feat(runtime): the bundle is built from effective state, and a managed tenant never reads disk"
```

---

### Task 10: Nodes take the soul from the bundle

**Files:**
- Modify: `src/agent/manager.ts` (add `setPersonaSoulResolver`; use it at session boot)
- Modify: `src/node/worker.ts` (install the resolver from `client.getRuntime`; reload warm sessions on the reload signal)
- Modify: `src/node/main.ts` (stop loading the persona registry and the soul from the volume)
- Test: `tests/node/soul-from-bundle.test.ts`

**Interfaces:**
- Consumes: `personaSoulText` (Task 8) as the manager's default; `client.getRuntime(tenant, persona, token)`, which already exists in `src/node/client.ts`.
- Produces: `AgentManager.setPersonaSoulResolver(resolver: ((sessionId: string, persona: string | undefined) => Promise<{ soulMd: string; soulJson: unknown }>) | undefined): void`

**Behaviour change (flag it in the PR):** the channel-mandate block uses the session persona's structured soul, as the resolver returns it, in place of the process-global default. Default-persona sessions are unchanged. A named persona now gets its own channel mandates, which is what the existing comment "Named personas use their own SOUL.md" intends. Without this change the node would need a filesystem read, and the spec rules that out.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/node/soul-from-bundle.test.ts
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../src/agent/manager";

describe("persona soul resolution", () => {
  test("with a resolver installed, the session's persona block comes from it", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => ({ soulMd: "SOUL-FROM-BUNDLE", soulJson: { approvers: [] } }));
    const prompt = await agent.__systemPromptForTests("s-1", "ana");
    expect(prompt).toContain("SOUL-FROM-BUNDLE");
  });

  test("a resolver failure fails the session boot instead of falling back to disk", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => { throw new Error("gateway unreachable"); });
    await expect(agent.__systemPromptForTests("s-1", "ana")).rejects.toThrow(/gateway unreachable/);
  });

  test("without a resolver, the local soul source is used, as in mono", async () => {
    const agent = new AgentManager();
    const prompt = await agent.__systemPromptForTests("s-1", undefined);
    expect(prompt).toContain("<persona>");
  });
});
```

`__systemPromptForTests(sessionId, persona)` is a new test-only method. It returns the joined `systemPrompt.append` string, and it is built by the same function session boot uses. To make that true, extract that assembly from the session-start path (currently inline around `src/agent/manager.ts:680`) into one private async method, `#buildSystemAppend(sessionId, persona, ...)`. Both session start and the test method call it, so the test exercises the production path rather than a copy.

A failure falls back to nothing on purpose. If a node fell back to the disk when the gateway was unreachable, a deleted persona directory would produce a half-configured agent rather than a clear failure. This mirrors the existing `setSessionConfigDirResolver` rule: "a failure fails the boot".

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test tests/node/soul-from-bundle.test.ts`
Expected: FAIL. The method does not exist.

- [ ] **Step 3: Implement**

In `AgentManager`, add the resolver field and setter next to `setSessionConfigDirResolver`, with the same style of doc comment. In `#buildSystemAppend`:

```ts
    const soul = this.#personaSoulResolver
      ? await this.#personaSoulResolver(sessionId, persona)
      : { soulMd: personaSoulText(persona), soulJson: undefined };
    // …
    soulSystemBlock(soul.soulMd),
```

Build the channel-mandate block from `soul.soulJson` when it is set, and from `effectiveSoulForChannel` as before when it is not. Delete the old `persona ? loadSoul(persona.soulPath) : undefined` expression.

In `src/node/worker.ts`, next to `setChildEnvResolver`:

```ts
  agent.setPersonaSoulResolver(async (sessionId) => {
    const tenant = tenants.get(sessionId);
    const token = store.tokenFor(sessionId);
    if (!tenant || !token) throw new Error(`no tenant or job token for session ${sessionId}`);
    // ETag-cached in NodeClient: the same fetch the child-env resolver makes, so
    // this costs a 304 at most.
    const bundle = await client.getRuntime(tenant, personas.get(sessionId) ?? "default", token);
    return { soulMd: bundle.soulMd, soulJson: bundle.soulJson };
  });
```

In `src/node/main.ts`, remove `setPersonaRegistry(loadPersonaRegistry())` and the boot-time `setSoulData(await loadSoulData())`. Before removing them, grep every other node-side reader of `getPersonaRegistry()` and `soulData()` with `grep -rn "getPersonaRegistry\|soulData()" src/node src/agent`. If anything on the node path still reads either one, route it through the resolver in this task. A leftover reader is exactly what Task 12's cluster check exists to catch, but finding it here is cheaper.

**Reload live sessions on the signal.** This corrects spec §6.4 as first written. The soul is assembled when a session *boots*, and today the node's reload handler only clears the bundle cache (`client.bustRuntime`). A warm session would keep its old soul indefinitely. Extend `ensureReloadSub`:

```ts
const unsub = await pubsub.onReload(tenantId, () => {
  client.bustRuntime(tenantId);
  // The soul is baked into the system prompt at session boot, so clearing the
  // cache alone changes nothing for a warm session. reload() lets the turn in
  // flight finish and boots the next one fresh: the same mechanism the gateway
  // uses after an MCP connect.
  for (const [sid, t] of tenants) if (t === tenantId) agent.reload(sid);
});
```

Add these tests to `tests/node/soul-from-bundle.test.ts`:

```ts
  test("a reload signal reboots warm sessions for that tenant only", async () => {
    // Build the worker with a stub pubsub that records its onReload callback,
    // a stub client whose getRuntime returns a soul you can change, and two
    // sessions: one in tenant 'default', one in tenant 'other'.
    // Fire the 'default' reload callback. Assert agent.reload was called for the
    // 'default' session and not for the 'other' one (spy on agent.reload).
  });

  // Review Focus 5: a tombstone refuses new work and never interrupts a turn.
  test("a turn in flight survives its persona being tombstoned", async () => {
    let soul = "ana soul";
    let tombstoned = false;
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => {
      if (tombstoned) throw new Error("bundle 404: persona tombstoned");
      return { soulMd: soul, soulJson: null };
    });
    // Boot: the soul is resolved once, at session start.
    const first = await agent.__systemPromptForTests("s-1", "ana");
    expect(first).toContain("ana soul");
    // The persona is tombstoned mid-turn. The running turn already holds its
    // prompt, so nothing it uses is re-resolved.
    tombstoned = true;
    expect(first).toContain("ana soul");
    // New work for the persona is refused at the next boot, loudly.
    await expect(agent.__systemPromptForTests("s-2", "ana")).rejects.toThrow(/tombstoned/);
  });
```

The first test is described rather than written out because its stubs depend on the shape of `createWorker`'s options. Read `tests/node/worker-e2e.test.ts` for how existing tests build a worker with a stub pubsub, and follow that pattern exactly. The assertion itself is fixed: a `reload` for the signalled tenant's session, and none for the other tenant's.

- [ ] **Step 4: Run the tests, including the existing node suites**

Run: `bun test tests/node tests/agent && SLAUDE_DB=pg bun test tests/node && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/manager.ts src/node/worker.ts src/node/main.ts tests/node/soul-from-bundle.test.ts
git commit -m "feat(node): take the soul from the runtime bundle instead of the shared volume"
```

---

### Task 11: The render and export commands

**Files:**
- Create: `src/cli/personas.ts`
- Modify: `package.json` (add a `"personas": "bun src/cli/personas.ts"` script next to `"slack-app"`)
- Test: `tests/cli/personas.test.ts`

**Interfaces:**
- Consumes: `parsePayload`, `PERSONA_NAME_RE`, `PayloadError` (Task 2).
- Produces:
  - `renderDir(dir: string, meta: { revision: string; committedAt: string }): SyncPayload`. It throws `PayloadError`.
  - `exportHome(home: string, out: string): { variables: string[] }`
  - CLI commands: `personas render <dir> [--revision <sha>] [--committed-at <iso>] [--check]`, and `personas export [--out <dir>]`

The repository layout is `personas/<name>/{persona.yaml, SOUL.md, mcp.json}`. `persona.yaml` holds `slackUserId`, `userToken` and `model`. Parse it with Bun's built-in YAML support (`Bun.YAML.parse`). If the Bun version pinned in CI lacks it, fall back to JSON-only `persona.json` and say so in the PR.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/cli/personas.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHome, renderDir } from "../../src/cli/personas";
import { PayloadError } from "../../src/persona/sync/payload";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "slaude-export-"));
  writeFileSync(join(h, "SOUL.md"), "default soul");
  mkdirSync(join(h, "personas", "ana"), { recursive: true });
  writeFileSync(join(h, "personas", "ana", "SOUL.md"), "ana soul ${NOT_A_VAR}");
  writeFileSync(join(h, "personas", "ana", "config.json"),
    JSON.stringify({ name: "ana", slackUserId: "UTESTUSER1", userToken: "user-token-live-secret" }));
  writeFileSync(join(h, "personas", "ana", "mcp.json"), JSON.stringify({ mcpServers: {} }));
  return h;
}
const meta = { revision: "r1", committedAt: "2026-10-01T10:00:00Z" };

describe("personas export and render", () => {
  test("export writes repository layout and puts no secret in it", () => {
    const out = mkdtempSync(join(tmpdir(), "slaude-repo-"));
    const { variables } = exportHome(home(), out);
    expect(variables).toEqual(["ANA_XOXP"]);
    const all = readdirSync(join(out, "personas"), { recursive: true }).map(String)
      .filter((f) => !f.endsWith("/")).map((f) => { try { return readFileSync(join(out, "personas", f), "utf8"); } catch { return ""; } }).join("\n");
    expect(all).not.toContain("user-token-live-secret");
    expect(all).toContain("${ANA_XOXP}");
  });

  // Acceptance 16.
  test("export then render reproduces the deployment, soul text byte-for-byte", () => {
    const out = mkdtempSync(join(tmpdir(), "slaude-repo-"));
    exportHome(home(), out);
    const p = renderDir(out, meta);
    expect(p.personas.map((x) => x.name).sort()).toEqual(["ana", "default"]);
    const ana = p.personas.find((x) => x.name === "ana")!;
    expect(ana.soul).toBe("ana soul ${NOT_A_VAR}");
    expect(ana.userToken).toBe("${ANA_XOXP}");
    expect(ana.slackUserId).toBe("UTESTUSER1");
  });

  test("render rejects a directory whose name is not a valid persona name", () => {
    const out = mkdtempSync(join(tmpdir(), "slaude-repo-"));
    mkdirSync(join(out, "personas", "Bad_Name"), { recursive: true });
    writeFileSync(join(out, "personas", "Bad_Name", "SOUL.md"), "x");
    expect(() => renderDir(out, meta)).toThrow(PayloadError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test tests/cli/personas.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/cli/personas.ts
/**
 * Personas as code, from the command line.
 *
 *   personas render <dir> [--revision <sha>] [--committed-at <iso>] [--check]
 *       Repository → sync payload, validated exactly as the gateway validates
 *       it, so a malformed file fails the pull request rather than the deploy.
 *   personas export [--out <dir>]
 *       $SLAUDE_HOME → repository layout. Every token is replaced by a ${VAR}
 *       placeholder and the variables are listed, so seeding a repository never
 *       puts a secret in git.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { parsePayload, PayloadError, PERSONA_NAME_RE, type SyncPayload } from "../persona/sync/payload";

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);
const varFor = (name: string) => `${name.replace(/-/g, "_").toUpperCase()}_XOXP`;

export function renderDir(dir: string, meta: { revision: string; committedAt: string }): SyncPayload {
  const root = join(dir, "personas");
  const personas = [];
  for (const name of readdirSync(root).sort()) {
    if (!statSync(join(root, name)).isDirectory()) continue;
    if (!PERSONA_NAME_RE.test(name)) throw new PayloadError(`directory '${name}' is not a valid persona name`);
    const yaml = read(join(root, name, "persona.yaml"));
    const cfg = (yaml ? Bun.YAML.parse(yaml) : {}) as { slackUserId?: string; userToken?: string; model?: string };
    const soul = read(join(root, name, "SOUL.md"));
    if (soul === undefined) throw new PayloadError(`persona '${name}' has no SOUL.md`);
    const mcp = read(join(root, name, "mcp.json"));
    personas.push({
      name, soul,
      ...(cfg.slackUserId ? { slackUserId: cfg.slackUserId } : {}),
      ...(cfg.userToken ? { userToken: cfg.userToken } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(mcp ? { mcp: JSON.parse(mcp) } : {}),
    });
  }
  return parsePayload({ ...meta, personas });
}

export function exportHome(home: string, out: string): { variables: string[] } {
  const variables: string[] = [];
  const write = (name: string, files: Record<string, string>) => {
    const d = join(out, "personas", name);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  };
  const defaultSoul = read(join(home, "SOUL.md"));
  const defaultMcp = read(join(home, ".mcp.json"));
  if (defaultSoul !== undefined) {
    write("default", { "SOUL.md": defaultSoul, ...(defaultMcp ? { "mcp.json": defaultMcp } : {}) });
  }
  const root = join(home, "personas");
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      const d = join(root, name);
      if (!statSync(d).isDirectory()) continue;
      const cfg = JSON.parse(read(join(d, "config.json")) ?? "{}") as { slackUserId?: string; userToken?: string };
      const lines = [`slackUserId: ${cfg.slackUserId ?? ""}`];
      if (cfg.userToken) {
        const v = varFor(name);
        variables.push(v);
        lines.push(`userToken: "\${${v}}"`); // the value never leaves $SLAUDE_HOME
      }
      const mcp = read(join(d, "mcp.json"));
      write(name, {
        "persona.yaml": lines.join("\n") + "\n",
        "SOUL.md": read(join(d, "SOUL.md")) ?? "",
        ...(mcp ? { "mcp.json": mcp } : {}),
      });
    }
  }
  return { variables };
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === "render" && rest[0]) {
      const p = renderDir(rest[0], {
        revision: flag("--revision") ?? process.env.GITHUB_SHA ?? "local",
        committedAt: flag("--committed-at") ?? new Date().toISOString(),
      });
      if (!rest.includes("--check")) console.log(JSON.stringify(p, null, 2));
    } else if (cmd === "export") {
      const out = flag("--out") ?? "./persona-repo";
      const { variables } = exportHome(paths.home, out);
      console.error(`[personas] exported to ${out}`);
      if (variables.length) console.error(`[personas] set these in the gateway environment: ${variables.join(", ")}`);
    } else {
      console.error("usage: personas render <dir> [--revision <sha>] [--committed-at <iso>] [--check] | personas export [--out <dir>]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`[personas] ${(e as Error).message}`);
    process.exit(1);
  }
}
```

`mcp.json` files may already contain `${VAR}` placeholders, since `parseExternalMcp` supports them. Export copies them as they are, so nothing in `mcp.json` is expanded on the way out.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/cli/personas.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/personas.ts package.json tests/cli/personas.test.ts
git commit -m "feat(cli): personas render and export — a repository round trip with no secret in it"
```

---

### Task 12: Prove it on the cluster — nodes without the directory

**Files:**
- Modify: `deploy/k8s-local/probe/turns.ts` (accept a persona for `enqueue`)
- Modify: `deploy/k8s-local/verify-ha.sh` (a new section)
- Modify: `deploy/k8s-local/kustomization.yaml` (set `SLAUDE_DEPLOY_TOKEN` from `secrets.env`)
- Modify: `deploy/k8s-local/up.sh` (generate `SLAUDE_DEPLOY_TOKEN` with `ensure_secret`)

**Interfaces:**
- Consumes: the deploy endpoint (Task 6), effective-state bundles (Task 9) and node soul resolution (Task 10).

This is acceptance criterion 10, and no unit test can stand in for it. The claim is that a node runs a persona's turn with the persona directory **absent from the shared volume**. Running it anywhere other than a real node proves nothing about a real node, which is the lesson from the cross-replica test that passed against a module-level `Map`.

A suppressed turn never calls the model, but it does boot the session, and session boot is where the soul is read. So with the directory deleted, a node that still read the disk would fail the boot, and a node that reads the bundle completes the turn.

- [ ] **Step 1: Teach the probe a persona**

In `deploy/k8s-local/probe/turns.ts`, accept `enqueue <n> [--persona <name>]`. Set the session row's `persona_id`, the job's `personaId` and the job token's `persona` claim to that name, using the same mint call the probe already uses for `default`. With no flag, keep today's behaviour exactly.

- [ ] **Step 2: Add the verification section**

Add the new section before the summary in `deploy/k8s-local/verify-ha.sh`. It reuses the bounded, loud `probe` and `expect_value` helpers from `verify-turns.sh`, so copy them into `verify-ha.sh` if they are not already shared:

```bash
# --- personas as code: a node needs no persona directory -------------------
section "personas as code"

deploy_token="$(grep '^SLAUDE_DEPLOY_TOKEN=' "$HERE/secrets.env" | cut -d= -f2-)"
gw_pod="$(pods "$GW_SEL" | awk '{print $1}')"

# Sync a set holding one named persona, posted from inside the cluster.
payload='{"revision":"verify-1","committedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","personas":[
  {"name":"default","soul":"Default verify soul."},
  {"name":"verifier","slackUserId":"UTESTUSER7","soul":"Verifier soul."}]}'
code="$(k exec "$gw_pod" -- sh -c "curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'authorization: Bearer $deploy_token' -H 'content-type: application/json' \
  --data '$payload' http://localhost:8080/deploy/v1/tenants/default/personas" 2>/dev/null || echo 000)"
expect_value "the pipeline sync was accepted" "$code" "200" "sync HTTP status"

# The node token must not be able to do the same.
node_token="$(grep '^SLAUDE_NODE_TOKEN=' "$HERE/secrets.env" | cut -d= -f2-)"
code="$(k exec "$gw_pod" -- sh -c "curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'authorization: Bearer $node_token' -H 'content-type: application/json' \
  --data '$payload' http://localhost:8080/deploy/v1/tenants/default/personas" 2>/dev/null || echo 000)"
expect_value "the node token cannot sync" "$code" "401" "sync HTTP status with the node token"

# Remove every trace of the persona from the shared volume.
k exec "$gw_pod" -- rm -rf /data/personas/verifier
expect "no persona directory remains on the shared volume" \
  "/data/personas/verifier still exists" \
  bash -c '! kubectl --context "$0" -n "$1" exec "$2" -- test -e /data/personas/verifier' "$PROFILE" "$NS" "$gw_pod"

# A turn for that persona must still complete: its session boot reads the soul.
probe cleanup >/dev/null 2>&1 || true
enq="$(probe enqueue 1 --persona verifier | field enqueued || true)"
expect_value "enqueued a turn for the persona" "$enq" "1" "enqueued"
done_v=""
t0=$(date +%s)
while (($(date +%s) - t0 < 120)); do
  done_v="$(probe status | field withCompletionMarker || true)"
  [[ "$done_v" == 1 ]] && break
  sleep 5
done
expect_value "a node completed the turn with no persona directory" "$done_v" "1" "turns completed"
```

shellcheck will warn about the single-quoted `bash -c` (SC2016). Silence it with a `# shellcheck disable=SC2016` line directly above, matching the file's existing convention, or rewrite the check as a helper function the way `lacks_source_entry` was written.

- [ ] **Step 3: Wire the deploy token into the local cluster**

In `up.sh`, add `ensure_secret SLAUDE_DEPLOY_TOKEN "$(openssl rand -hex 24)"` next to the other `ensure_secret` calls. In `kustomization.yaml`, expose it to the gateway deployment only. **Nodes must not receive it.** That is the point, so verify that the node container's env does not include it.

- [ ] **Step 4: Run it**

Run: `shellcheck deploy/k8s-local/*.sh && bash deploy/k8s-local/up.sh && bash deploy/k8s-local/verify-ha.sh`
Expected: every check passes, including the new section, and no `!!` probe lines appear.

- [ ] **Step 5: Mutation-check it against the real thing**

Temporarily restore `setPersonaRegistry(loadPersonaRegistry())` in `src/node/main.ts`, and switch the manager back to reading the soul from `persona.soulPath`. Rebuild the image in minikube and rerun the section. "A node completed the turn with no persona directory" must fail. Then restore the code and rebuild.

- [ ] **Step 6: Commit**

```bash
git add deploy/k8s-local/probe/turns.ts deploy/k8s-local/verify-ha.sh deploy/k8s-local/kustomization.yaml deploy/k8s-local/up.sh
git commit -m "test(k8s-local): prove a node runs a persona's turn with its directory deleted"
```

---

### Task 13: Documentation

**Files:**
- Create: `docs/site/_content/field-notes/2026-10-01-personas-as-code.md`
- Create: `docs/site/_content/deploy/personas-as-code.md`
- Modify: `CLAUDE.md` (Findings Log index)

- [ ] **Step 1: Write the field note**

The note records:

- **Why the soul could move when credentials could not.** Slaude injects the soul as text and the agent child never opens the file. Correct the earlier claim plainly.
- **Why skills and `slaude.json` stayed out.** Skills are agent-written. `slaude.json` installs code.
- **The two-layer model, and why a sync wipes overrides.** It is ArgoCD's selfHeal: git is the only thing that lasts.
- **The `/deploy` prefix and its own token.** The node token is held by every node.
- **The strict extractor.** `loadSoulData` silently degrades to approvers-only, which a sync cannot afford.
- **The synchronous registry with a poll.** This deviates in mechanism from the spec's per-lookup revalidation, and gives the same guarantee.
- **The channel-mandate behaviour change** for named personas.
- **What each mutation check caught**, if any of them caught something during implementation.

- [ ] **Step 2: Write the operator guide**

`docs/site/_content/deploy/personas-as-code.md` covers:

- the repository layout;
- the CI job, using `personas render --check` on pull requests, `?dryRun=1` to post the diff on the pull request, and the real POST on merge;
- setting `SLAUDE_DEPLOY_TOKEN` on the gateway only;
- the `${VAR}` convention and which fields it applies to;
- `personas export` for seeding a repository from a running deployment;
- runtime overrides and quick onboard, both from the panel API, and the fact that the next sync wipes them;
- that a never-synced deployment keeps working from the filesystem.

Include one complete CI example. Use a GitHub Actions job with a `curl` step, with no project-specific names.

- [ ] **Step 3: Index the note**

Add the field note to the top of the CLAUDE.md Findings Log, newest first, in the same one-paragraph style as the entries around it.

- [ ] **Step 4: Check that the site builds**

Run: `node docs/site/build.mjs`
Expected: it exits 0.

- [ ] **Step 5: Commit**

```bash
git add docs/site/_content/field-notes/2026-10-01-personas-as-code.md docs/site/_content/deploy/personas-as-code.md CLAUDE.md
git commit -m "docs: personas as code — the field note and the operator guide"
```

---

### Task 14: Security pass and full verification

**Files:** none, unless a finding needs a fix. A fix gets its own commit and test.

- [ ] **Step 1: Walk the security claims against tests that exist**

Confirm each claim with a test or a command. Do not take any of them on trust:

1. **The node token cannot reach `/deploy`, and the deploy token cannot reach `/v1`.** Task 6 tests, plus the cluster check in Task 12.
2. **`SLAUDE_DEPLOY_TOKEN` is set on the gateway and absent from every node container.** Check with `kubectl get deploy slaude-node -o yaml | grep -c SLAUDE_DEPLOY_TOKEN`, which must print `0`.
3. **No secret value appears in any response.** Tasks 6, 7 and 9.
4. **No secret value appears in any log line.** Grep every `console.` call added by this plan: `git diff main...HEAD -- src | grep '^+.*console\.'`. Read each one.
5. **`user_token` and `mcp` are ciphertext at rest.** Task 4.
6. **Soul text is never placeholder-resolved.** Task 2.
7. **Runtime writes are superadmin-only, CSRF-checked, and refused on unmanaged tenants.** Task 7.
8. **Persona names cannot escape a directory.** Tasks 2 and 11.
9. **`mono` on sqlite is unchanged.** Run the full suite without `SLAUDE_DB`.

- [ ] **Step 2: Run the full suite on every leg**

Run: `bunx tsc --noEmit && bun test && SLAUDE_DB=pg bun test`
Then run the real-Postgres leg exactly as `.github/workflows/ci.yml` does.
Expected: 0 failures on every leg.

- [ ] **Step 3: Run both cluster scripts**

Run: `bash deploy/k8s-local/verify-ha.sh && bash deploy/k8s-local/verify-turns.sh`
Expected: every check passes and no `!!` lines appear. If either reports COULD NOT MEASURE, fix the environment and rerun. Do not count it as a pass.

- [ ] **Step 4: Open the PR**

The PR body states the behaviour change from Task 10 and the mechanism deviation from Task 8. It lists every mutation check with its result, and links the spec and the field note. CLAUDE.md's open decision on the deploy unit ("one container = one persona") predates the multi-persona registry this design builds on. Call that out so the owner can update or reaffirm it.
