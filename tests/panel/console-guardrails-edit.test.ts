/**
 * Console API, phase B: create, edit (a console guardrail's own text, or an
 * override of a file or git one), clear an override, delete, the live
 * validation and the Test box. Superadmin only for writes, every write
 * through applyGuardrailChange (422 on a rule that fails to parse, 409 on a
 * stale revision, 423 while the set does not verify), audited without text,
 * and announced to nodes like the enable switch.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { __clearGuardrailsForTests, applyGuardrailChange, readGuardrails, sha256 } from "../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, currentGuardrails } from "../../src/guardrails/snapshot";
import { verifySet } from "../../src/guardrails/integrity";
import { flushAudits } from "../../src/audit/emit";
import { evaluateGuardrails } from "../../src/guardrails/evaluate";
import { formatOutbound } from "../../src/gateway/slack/outbound";
import type {
  GuardrailTestResponse, GuardrailValidation, GuardrailWriteResponse, OwnerGuardrailDetail, OwnerGuardrailsResponse,
} from "../../src/gateway/panel/api-types";
import { ensureGuardrailKeyForPg } from "../guardrails/helpers";

ensureGuardrailKeyForPg();

const SECRET = "t".repeat(32);
const operator = `${AT_COOKIE}=${mintSession({ sub: "s", email: "alice@example.com" }, "at", { secret: SECRET })}`;
const superadmin = `${AT_COOKIE}=${mintSession({ sub: "s", email: "lead@example.com" }, "at", { secret: SECRET })}`;

const GIT = "---\nname: no-send\ndescription: Never send\n---\nDraft only.\n\n```rules\n- id: no-send\n  on: tool\n  match: { tool: 'mcp__*__*send*' }\n  action: deny\n  message: Save a draft instead.\n```";
const NEW = "---\nname: quiet-prices\ndescription: Prices need an approver\n---\nAsk before quoting.\n\n```rules\n- id: prices\n  on: reply\n  match: { text: '(?i)price is \\$\\d+' }\n  action: approve\n```";
const BAD = NEW.replace("action: approve", "action: explode");

function registry(): PersonaRegistry {
  const scout = { name: "scout", slackUserId: "UPSCOUT", soulMd: "# Scout", config: { slackUserId: "UX", name: "scout" }, outClient: null } as unknown as Persona;
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => (n === "scout" ? scout : null),
    list: () => [scout],
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, runsOn: null }),
  };
}

let reloads: string[] = [];
const pubsub = { publishReload: async (t: string) => { reloads.push(t); return 1; } } as never;

const call = async (path: string, who = superadmin, init: { method?: string; body?: unknown } = {}) => {
  const api = createPanelApi({ registry: null, role: "mono", pubsub, panelLock: null, chat: async () => {} });
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { cookie: who, ...(method !== "GET" ? { "content-type": "application/json", "x-panel-csrf": "1" } : {}) };
  const res = (await api.fetch(new Request(`https://panel.example.com${path}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) })))!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
};
const detail = async (slug: string, who = superadmin) => (await call(`/panel/api/guardrails/${slug}`, who)).body as OwnerGuardrailDetail;
const auditRows = async (like = "guardrail.%") => {
  await flushAudits();
  return db.query<{ action: string; target_id: string; actor_id: string; details: string | Record<string, unknown>; summary: string }>(
    "SELECT action, target_id, actor_id, details, summary FROM audit_events WHERE action LIKE ? ORDER BY id",
    [like],
  );
};

const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_OPERATORS", "SLAUDE_PANEL_SUPERADMIN"];
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  __resetRoleCache();
  setPersonaRegistry(registry());
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  await flushAudits();
  await db.run("DELETE FROM audit_events WHERE action LIKE 'guardrail.%' OR action LIKE 'panel.%'");
  await applyGuardrailChange("default", { upsert: [{ slug: "no-send", md: GIT, source: "git" }], by: "pipeline" });
  reloads = [];
});
afterEach(() => {
  __resetPersonaRegistry();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
});
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});

describe("create", () => {
  test("a superadmin creates a console guardrail: signed into the set, audited without text, nodes told", async () => {
    const r = await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "quiet-prices", md: NEW } });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ok: true, slug: "quiet-prices", change: "created", revision: 2, version: 2 } satisfies GuardrailWriteResponse);
    expect(reloads).toEqual(["default"]);
    const s = await readGuardrails();
    expect(verifySet("default", s)).toBe(2);
    expect(s.rows.find((x) => x.slug === "quiet-prices")).toMatchObject({ source: "console", updatedBy: "lead@example.com" });
    const d = await detail("quiet-prices");
    expect(d).toMatchObject({ source: "console", deletable: true, canEdit: true, revision: 2, overrideOf: null, override: false });
    const rows = await auditRows();
    expect(rows.map((x) => [x.action, x.target_id, x.actor_id])).toEqual([["guardrail.created", "quiet-prices", "lead@example.com"]]);
    // The panel row too, and neither carries the text.
    const panel = await auditRows("panel.%");
    expect(panel.some((x) => JSON.stringify(x.details).includes("guardrail.create"))).toBe(true);
    for (const x of [...rows, ...panel]) expect(JSON.stringify(x)).not.toContain("Ask before quoting");
  });

  test("a taken name is a 409; a reserved or bad name and an invalid enforced rule are 422", async () => {
    const taken = await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "no-send", md: GIT } });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: "exists" });
    expect((await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "test", md: NEW.replace("quiet-prices", "test") } })).body).toMatchObject({ code: "invalid", error: expect.stringContaining("reserved") });
    expect((await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "Bad Name", md: NEW } })).status).toBe(422);
    const bad = await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "quiet-prices", md: BAD } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("invalid");
    expect(bad.body.blocking[0]).toMatch(/rule 1: action/);
    expect((await readGuardrails()).rows.map((x) => x.slug)).toEqual(["no-send"]);
    expect(reloads).toEqual([]);
    expect((await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "x" } })).status).toBe(400);
  });
});

describe("edit", () => {
  test("a git guardrail gets a console override (base_sha the source's); the source text is kept for the diff; a sync flags it behind source", async () => {
    const d0 = await detail("no-send");
    expect(d0).toMatchObject({ revision: 1, deletable: false, overrideOf: null });
    const edited = GIT.replace("Draft only.", "Draft only, always.");
    const r = await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: edited, revision: 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, slug: "no-send", change: "override.set", revision: 2, version: 2 });
    expect(reloads).toEqual(["default"]);
    const s = await readGuardrails();
    expect(s.rows[0]!.md).toBe(GIT);
    expect(s.overrides).toMatchObject([{ slug: "no-send", md: edited, baseSha: sha256(GIT), author: "lead@example.com" }]);
    const d = await detail("no-send");
    expect(d).toMatchObject({ md: edited, override: true, behindSource: false, revision: 2, overrideOf: { sourceMd: GIT, author: "lead@example.com" } });
    // A sync changes the source: the override stays and is behind source; the diff is against the new source.
    const moved = GIT.replace("Draft only.", "Drafts only.");
    await applyGuardrailChange("default", { upsert: [{ slug: "no-send", md: moved, source: "git" }], by: "pipeline" });
    const behind = await detail("no-send");
    expect(behind).toMatchObject({ md: edited, override: true, behindSource: true, revision: 3, overrideOf: { sourceMd: moved } });
    expect((await auditRows()).map((x) => x.action)).toEqual(["guardrail.override.set"]);
  });

  test("a console guardrail's own text changes (no override); saving the same text changes nothing", async () => {
    await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "quiet-prices", md: NEW } });
    reloads = [];
    const changed = NEW.replace("Ask before quoting.", "Ask first.");
    const r = await call("/panel/api/guardrails/quiet-prices", superadmin, { method: "PUT", body: { md: changed, revision: 2 } });
    expect(r.body).toMatchObject({ change: "updated", revision: 3 });
    expect((await readGuardrails()).overrides).toEqual([]);
    const same = await call("/panel/api/guardrails/quiet-prices", superadmin, { method: "PUT", body: { md: changed, revision: 3 } });
    expect(same.body).toMatchObject({ change: "unchanged", revision: 3, version: 3 });
    expect(reloads).toEqual(["default"]);
  });

  test("a stale revision is a 409 with the current one; nothing is written", async () => {
    const first = await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: GIT.replace("Draft only.", "One."), revision: 1 } });
    expect(first.status).toBe(200);
    const second = await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: GIT.replace("Draft only.", "Two."), revision: 1 } });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: "stale", revision: 2 });
    expect(second.body.error).toMatch(/Reload/);
    expect((await readGuardrails()).overrides[0]!.md).toContain("One.");
    // A switch moves the revision too.
    await call("/panel/api/guardrails/no-send/enabled", superadmin, { method: "PUT", body: { enabled: false } });
    expect((await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: GIT, revision: 2 } })).status).toBe(409);
  });

  test("an invalid enforced rule is refused (422) like /deploy and import; a non-blocking problem is saved and shown", async () => {
    const bad = await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: GIT.replace("action: deny", "action: explode"), revision: 1 } });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "invalid" });
    const regex = await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: GIT.replace("'mcp__*__*send*'", "'mcp__*__*send*'\n    input: '('"), revision: 1 } });
    expect(regex.status).toBe(422);
    expect(regex.body.blocking[0]).toMatch(/is not a valid pattern/);
    // A name that differs from the folder is a problem, not a refusal.
    const named = await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: GIT.replace("name: no-send", "name: other"), revision: 1 } });
    expect(named.status).toBe(200);
    expect((await detail("no-send")).errors[0]).toMatch(/differs from the guardrail's folder/);
    expect((await call("/panel/api/guardrails/nope", superadmin, { method: "PUT", body: { md: GIT.replace("no-send", "nope"), revision: 1 } })).status).toBe(404);
  });

  test("a write while the stored set does not verify is refused with the repair hint", async () => {
    await db.run("UPDATE guardrails SET md = 'tampered' WHERE slug = 'no-send'");
    __resetGuardrailSnapshotsForTests();
    const r = await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: GIT, revision: 1 } });
    expect(r.status).toBe(423);
    expect(r.body).toMatchObject({ code: "integrity" });
    expect(r.body.hint).toContain("slaude guardrails import --repair");
    const c = await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "quiet-prices", md: NEW } });
    expect(c.status).toBe(423);
    expect(reloads).toEqual([]);
    const t = await call("/panel/api/guardrails/no-send/enabled", superadmin, { method: "PUT", body: { enabled: false } });
    expect(t.status).toBe(423);
  });
});

describe("clear and delete", () => {
  test("clearing an override: the source text applies again; audited; a guardrail without one is a 404", async () => {
    await call("/panel/api/guardrails/no-send", superadmin, { method: "PUT", body: { md: GIT.replace("Draft only.", "Mine."), revision: 1 } });
    reloads = [];
    expect((await call("/panel/api/guardrails/no-send/override?revision=1", superadmin, { method: "DELETE" })).status).toBe(409);
    const r = await call("/panel/api/guardrails/no-send/override?revision=2", superadmin, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ change: "override.cleared", version: 3 });
    expect(reloads).toEqual(["default"]);
    const d = await detail("no-send");
    expect(d).toMatchObject({ md: GIT, override: false, overrideOf: null, revision: 1 });
    expect(r.body.revision).toBe(d.revision);
    expect(verifySet("default", await readGuardrails())).toBe(3);
    const again = await call(`/panel/api/guardrails/no-send/override?revision=${d.revision}`, superadmin, { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("no-override");
    expect((await call("/panel/api/guardrails/no-send/override", superadmin, { method: "DELETE" })).status).toBe(400);
    expect((await auditRows()).map((x) => x.action)).toEqual(["guardrail.override.set", "guardrail.override.cleared"]);
  });

  test("a console guardrail can be deleted; file and git guardrails cannot (switch them off)", async () => {
    await call("/panel/api/guardrails", superadmin, { method: "POST", body: { slug: "quiet-prices", md: NEW } });
    reloads = [];
    const git = await call("/panel/api/guardrails/no-send?revision=1", superadmin, { method: "DELETE" });
    expect(git.status).toBe(422);
    expect(git.body).toMatchObject({ code: "not-deletable" });
    expect(git.body.error).toContain("switch it off");
    await applyGuardrailChange("default", { upsert: [{ slug: "host", md: "---\nname: host\n---\nx", source: "file" }], by: "cli" });
    expect((await call("/panel/api/guardrails/host?revision=3", superadmin, { method: "DELETE" })).body.code).toBe("not-deletable");
    expect((await call("/panel/api/guardrails/quiet-prices?revision=1", superadmin, { method: "DELETE" })).status).toBe(409);
    const ok = await call("/panel/api/guardrails/quiet-prices?revision=2", superadmin, { method: "DELETE" });
    expect(ok.body).toMatchObject({ change: "deleted", revision: null });
    expect(reloads).toEqual(["default"]);
    expect((await readGuardrails()).rows.map((x) => x.slug)).toEqual(["host", "no-send"]);
    expect((await auditRows("guardrail.deleted")).map((x) => x.target_id)).toEqual(["quiet-prices"]);
  });
});

describe("role gating", () => {
  test("an operator reads, validates and tests, and every write is a 403", async () => {
    const list = (await call("/panel/api/guardrails", operator)).body as OwnerGuardrailsResponse;
    expect(list.canEdit).toBe(false);
    expect((await detail("no-send", operator)).canEdit).toBe(false);
    expect((await call("/panel/api/guardrails", operator, { method: "POST", body: { slug: "quiet-prices", md: NEW } })).status).toBe(403);
    expect((await call("/panel/api/guardrails/no-send", operator, { method: "PUT", body: { md: GIT, revision: 1 } })).status).toBe(403);
    expect((await call("/panel/api/guardrails/no-send/override?revision=1", operator, { method: "DELETE" })).status).toBe(403);
    expect((await call("/panel/api/guardrails/no-send?revision=1", operator, { method: "DELETE" })).status).toBe(403);
    expect((await call("/panel/api/guardrails/validate", operator, { method: "POST", body: { slug: "x", md: "---\nname: x\n---\n" } })).status).toBe(200);
    expect((await call("/panel/api/guardrails/test", operator, { method: "POST", body: { agent: "default", kind: "reply", text: "hi" } })).status).toBe(200);
    expect(reloads).toEqual([]);
    expect((await readGuardrails()).manifest!.version).toBe(1);
  });
});

describe("validate", () => {
  test("the server parser's verdict: rule errors, unknown agents, the prose cap and who it tips over", async () => {
    const v = (await call("/panel/api/guardrails/validate", superadmin, { method: "POST", body: { slug: "quiet-prices", md: BAD } })).body as GuardrailValidation;
    expect(v.ok).toBe(false);
    expect(v.blocking[0]).toMatch(/rule 1: action/);
    const scoped = "---\nname: mine\nscope: agents\nagents: [scout, ghost]\n---\n" + "x".repeat(30);
    process.env.SLAUDE_GUARDRAIL_PROSE_MAX = "40";
    try {
      const s = (await call("/panel/api/guardrails/validate", superadmin, { method: "POST", body: { slug: "mine", md: scoped } })).body as GuardrailValidation;
      expect(s).toMatchObject({ ok: true, name: "mine", scope: "agents", unknownAgents: ["ghost"], appliesTo: ["scout"] });
      expect(s.prose.chars).toBe(30);
      // Prose loads in slug order: mine (30) first, then no-send ("Draft only.", 11) tips scout over 40.
      expect(s.prose.overCap).toEqual([{ agent: "scout", chars: 41, skipped: [{ slug: "no-send", name: "no-send", chars: 11 }] }]);
    } finally {
      delete process.env.SLAUDE_GUARDRAIL_PROSE_MAX;
    }
    const reserved = (await call("/panel/api/guardrails/validate", superadmin, { method: "POST", body: { slug: "new", md: "---\nname: new\n---\n" } })).body as GuardrailValidation;
    expect(reserved.ok).toBe(false);
    expect(reserved.blocking[0]).toContain("reserved");
    // Nothing was written.
    expect((await readGuardrails()).rows.map((x) => x.slug)).toEqual(["no-send"]);
  });
});

describe("the Test box", () => {
  test("the same answer as the runtime evaluation; a draft; a guardrail.tested row without the text", async () => {
    const t = (await call("/panel/api/guardrails/test", superadmin, { method: "POST", body: { agent: "scout", channel: "CDEV", kind: "tool", tool: "mcp__mail__send", input: '{"to":"a@b.example","body":"SECRET-BODY"}' } })).body as GuardrailTestResponse;
    expect(t.decision).toMatchObject({ action: "deny", slug: "no-send", ruleId: "no-send", message: "Save a draft instead." });
    const snap = await currentGuardrails("default");
    expect(t).toEqual(evaluateGuardrails(snap.resolved, { kind: "tool", tool: "mcp__mail__send", input: { to: "a@b.example", body: "SECRET-BODY" } }, { agent: "scout", channel: "CDEV", version: snap.version, proseMax: 4000 }) as GuardrailTestResponse);
    // A reply is formatted as a real one before the rules run.
    const reply = (await call("/panel/api/guardrails/test", superadmin, { method: "POST", body: { agent: "default", kind: "reply", text: "**price is $5**", draft: { slug: "quiet-prices", md: NEW } } })).body as GuardrailTestResponse;
    expect(reply.decision).toMatchObject({ action: "approve", slug: "quiet-prices" });
    expect(reply.draft).toMatchObject({ slug: "quiet-prices", replaced: false });
    expect(evaluateGuardrails(snap.resolved, { kind: "reply", text: formatOutbound("**price is $5**", "reply", "default") }, { agent: "default", channel: null, version: snap.version, proseMax: 4000, draft: { slug: "quiet-prices", md: NEW } }).decision).toEqual(reply.decision);
    // Nothing stored changed.
    expect((await readGuardrails()).rows.map((x) => x.slug)).toEqual(["no-send"]);
    const rows = await auditRows();
    expect(rows.map((x) => x.action)).toEqual(["guardrail.tested", "guardrail.tested"]);
    for (const x of rows) {
      expect(JSON.stringify(x)).not.toContain("SECRET-BODY");
      expect(JSON.stringify(x)).not.toContain("price is");
    }
    expect(typeof rows[0]!.details === "string" ? JSON.parse(rows[0]!.details) : rows[0]!.details).toMatchObject({ agent: "scout", kind: "tool", tool: "mcp__mail__send", decision: "deny" });
  });

  test("bad input: JSON that does not parse, a missing tool name, an unknown agent", async () => {
    expect((await call("/panel/api/guardrails/test", superadmin, { method: "POST", body: { agent: "default", kind: "tool", tool: "Bash", input: "{nope" } })).status).toBe(400);
    expect((await call("/panel/api/guardrails/test", superadmin, { method: "POST", body: { agent: "default", kind: "tool" } })).status).toBe(400);
    expect((await call("/panel/api/guardrails/test", superadmin, { method: "POST", body: { agent: "nobody", kind: "reply", text: "x" } })).status).toBe(404);
  });

  test("too large to check is reported", async () => {
    const big = "x".repeat(1024 * 1024 + 5);
    const t = (await call("/panel/api/guardrails/test", superadmin, { method: "POST", body: { agent: "default", kind: "tool", tool: "mcp__x__send", input: JSON.stringify({ body: big }) } })).body as GuardrailTestResponse;
    // The deny rule names no input field, so the tool name alone decides.
    expect(t.decision).toMatchObject({ action: "deny", oversize: false });
    const draft = GIT.replace("match: { tool: 'mcp__*__*send*' }", "match: { tool: 'mcp__*__*send*', input: { body: secret } }");
    const o = (await call("/panel/api/guardrails/test", superadmin, { method: "POST", body: { agent: "default", kind: "tool", tool: "mcp__x__send", input: JSON.stringify({ body: big }), draft: { slug: "no-send", md: draft } } })).body as GuardrailTestResponse;
    expect(o.tooLarge).toBe(true);
    expect(o.decision).toMatchObject({ action: "deny", oversize: true });
    expect(o.decision!.message).toContain("too large");
  });
});
