/**
 * Console API: the soul and access settings under Resources > Guardrails
 * (GET /panel/api/guardrails/settings). One agent's effective values, each
 * with its source (env, soul, default, learned rule, code), read from the
 * code paths that enforce them. The runtime layer (the guardrail registry)
 * is code only since the owner guardrails design; its details are checked
 * here against the registry itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import { setSoulData } from "../../src/soul/extract";
import { SoulDataSchema } from "../../src/soul/data";
import { setManagedDefaultSoul } from "../../src/persona/soul-source";
import { invalidateGrants } from "../../src/access/role";
import { setAgentId, resetAgentId } from "../../src/knowledge/agent-identity";
import { soulSections } from "../../src/gateway/panel/guardrails-view";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import type { GuardrailFamily, GuardrailSettingsResponse } from "../../src/gateway/panel/api-types";
import type { ProactiveRule } from "../../src/proactive/rules";
import { GUARDRAILS, NODE_RUNTIME, type GuardrailCtx, type GuardrailRuntime } from "../../src/agent/guardrails";
import { readFileSync } from "node:fs";

type GuardrailsResponse = GuardrailSettingsResponse;
/** A registry entry as it describes itself for a set of runtime facts (code only, no API). */
const entry = (runtime: GuardrailRuntime, id: string, role: "operator" | "superadmin" = "operator") => {
  const g = GUARDRAILS.find((x) => x.id === id)!;
  const ctx: GuardrailCtx = { agent: "default", ...runtime };
  return { state: g.notBuilt ? "not-built" : g.state(ctx), details: g.details?.(ctx, { role }) ?? [], fieldNote: g.fieldNote };
};
const UNKNOWN: GuardrailRuntime = { stopGuard: false, permissionResolver: false, turnsRunOn: "this-process" };
const MONO: GuardrailRuntime = { stopGuard: true, permissionResolver: true, turnsRunOn: "this-process" };

const SECRET = "t".repeat(32);
const operator = `${AT_COOKIE}=${mintSession({ sub: "s", email: "alice@example.com" }, "at", { secret: SECRET })}`;
const superadmin = `${AT_COOKIE}=${mintSession({ sub: "s", email: "lead@example.com" }, "at", { secret: SECRET })}`;

const SOUL = `# Ada

## Mandate
Help the team.

## Approvers
- <@UAPP> for deploys

## Proactive
- Enabled: yes
- Highest: ask
- Quiet hours: 22:00-07:00
- Watch: issue-tracker

## Channel <#COPS|ops>
Watch the ops channel.

### Proactive
- Enabled: no
- Cooldown: 3h
`;

const rule: ProactiveRule = {
  slug: "rules/proactive/ci-red", kind: "ci red", scope: "COPS", level: "inform", how: "one line",
  taughtBy: "UMGR", taughtAt: "2026-11-01T00:00:00Z", thread: "COPS:1.0", quote: null,
};

function registryWith(): PersonaRegistry {
  const scout = { name: "scout", slackUserId: "UPSCOUT", soulMd: "# Scout\n\n## Mandate\nResearch.\n", config: { slackUserId: "UX", name: "scout" }, outClient: null } as unknown as Persona;
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

const get = async (path: string, rules: (id: string) => Promise<ProactiveRule[]> = async () => [rule], who: string = operator) => {
  const api = createPanelApi({ registry: null, role: "mono", pubsub: null, panelLock: null, chat: async () => {}, guardrails: { rules } });
  const res = (await api.fetch(new Request(`https://panel.example.com${path}`, { headers: { cookie: who } })))!;
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
};
const family = (r: GuardrailsResponse, id: GuardrailFamily["id"]) => r.families.find((f) => f.id === id)!;
const value = (f: GuardrailFamily, key: string) => f.settings.find((s) => s.key === key)!;

const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_OPERATORS", "SLAUDE_PANEL_SUPERADMIN", "ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN", "SLAUDE_AUTO_ALLOW_TOOLS", "SLAUDE_WAKE_MAX_USD", "SLAUDE_DEFAULT_MODE", "SLAUDE_APPROVERS"];
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_AUTO_ALLOW_TOOLS = "Read, memory_save";
  process.env.SLAUDE_WAKE_MAX_USD = "2";
  delete process.env.SLAUDE_DEFAULT_MODE;
  delete process.env.SLAUDE_APPROVERS;
  __resetRoleCache();
  setAgentId("UDEFAULT");
  setPersonaRegistry(registryWith());
  setManagedDefaultSoul(SOUL);
  setSoulData(SoulDataSchema.parse({
    manager: { userId: "UMGR" },
    mandate: "Help the team.",
    approvers: [{ userId: "UAPP", scope: "deploys", catchall: false }],
    redactPatterns: ["secret-\\d+"],
    trustedChannels: ["COPS"],
    blockedUsers: ["UBAD"],
  }));
  await db.run("DELETE FROM agent_grants");
  invalidateGrants();
});
afterEach(() => {
  setManagedDefaultSoul(null);
  __resetPersonaRegistry();
  resetAgentId();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
  invalidateGrants();
});

describe("GET /panel/api/guardrails/settings", () => {
  test("the default agent: every family, values and sources", async () => {
    const r = await get("/panel/api/guardrails/settings");
    expect(r.status).toBe(200);
    const g = r.body as GuardrailsResponse;
    expect(g.agent).toBe("default");
    expect(g.families.map((f) => f.id)).toEqual([
      "tool-permissions", "approvals", "admission", "memory-gating", "profile-guard", "policy", "redaction", "proactive", "learned-rules", "wake-tools", "budgets",
    ]);

    const tools = family(g, "tool-permissions");
    // The alias twin is listed too, from the env.
    expect(value(tools, "auto-allow")).toMatchObject({ source: "env", value: ["Read", "kb_memoize", "memory_save"] });
    expect(value(tools, "default-mode")).toMatchObject({ source: "default", value: "default" });

    const approvals = family(g, "approvals");
    expect(value(approvals, "approvers")).toMatchObject({ source: "soul", value: ["UAPP"] });
    expect(approvals.table?.rows).toEqual([["UAPP", "deploys"]]);
    expect(approvals.text).toContain("## Approvers");

    const admission = family(g, "admission");
    expect(value(admission, "managers").value).toEqual(["UMGR"]);
    expect(value(admission, "channels").value).toEqual(["COPS"]);
    expect(value(admission, "blocked").value).toEqual(["UBAD"]);
    expect(admission.link?.to).toBe("/agents/default/access");

    expect(value(family(g, "memory-gating"), "own-slice").value).toBe("agent-udefault");
    expect(family(g, "policy").status).toBe("not-implemented");
    // An operator sees how many patterns, never the patterns.
    expect(value(family(g, "redaction"), "patterns")).toMatchObject({ source: "soul", value: "1 pattern" });
    expect(r.text).not.toContain("secret-");

    const pro = family(g, "proactive");
    expect(value(pro, "enabled")).toMatchObject({ value: true, source: "soul" });
    expect(value(pro, "highest")).toMatchObject({ value: "ask", source: "soul" });
    expect(value(pro, "quiet")).toMatchObject({ value: "22:00 to 07:00", source: "soul" });
    expect(value(pro, "cap")).toMatchObject({ value: 6, source: "default" });
    expect(pro.table?.rows).toEqual([["COPS", "no", "as global", "3 hours", "as global"]]);
    expect(pro.text).toContain("## Proactive");
    expect(pro.text).toContain("### Proactive");

    const learned = family(g, "learned-rules");
    expect(learned.status).toBe("active");
    expect(learned.table?.rows).toEqual([["ci red", "COPS", "inform", "one line", "UMGR", "2026-11-01T00:00:00Z"]]);

    expect(family(g, "wake-tools").table?.rows).toContainEqual(["surface", "pass"]);
    const budgets = family(g, "budgets");
    expect(value(budgets, "wake-usd")).toMatchObject({ value: "2 USD", source: "env" });
    expect(value(budgets, "background")).toMatchObject({ source: "default" });
  });

  test("a named agent: approvers fall back to the default managers; redaction notes the default soul", async () => {
    const g = (await get("/panel/api/guardrails/settings?agent=scout")).body as GuardrailsResponse;
    expect(g.agent).toBe("scout");
    // scout's soul names no manager or approver: it inherits the default's (per unit), so they are soul grants.
    expect(value(family(g, "approvals"), "approvers").value).toEqual(expect.arrayContaining(["UMGR"]));
    expect(value(family(g, "proactive"), "enabled")).toMatchObject({ value: false, source: "default" });
    expect(value(family(g, "memory-gating"), "own-slice").value).toBe("agent-upscout");
    // scout's soul names no redaction patterns or timeout: the default agent's apply, and the page says so.
    expect(value(family(g, "redaction"), "own-patterns")).toMatchObject({ value: "0 patterns", source: "default" });
    expect(value(family(g, "approvals"), "timeout")).toMatchObject({ value: "300 seconds", source: "default" });
  });

  test("learned rules that cannot be read say so instead of failing the page", async () => {
    const g = (await get("/panel/api/guardrails/settings", async () => { throw new Error("brain down"); })).body as GuardrailsResponse;
    expect(family(g, "learned-rules")).toMatchObject({ status: "unavailable", note: "brain down" });
  });

  test("an unknown agent is a 404", async () => {
    expect((await get("/panel/api/guardrails/settings?agent=nobody")).status).toBe(404);
  });
});

describe("guardrails never show secrets", () => {
  test("a superadmin sees the redaction patterns (default + own); no env secret value appears for anyone", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-xxxxxxxxxxxxxxxxxxxx";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-0000000000";
    process.env.SLAUDE_AUTO_ALLOW_TOOLS = "Read";
    for (const who of [operator, superadmin]) {
      for (const agent of ["default", "scout"]) {
        const r = await get(`/panel/api/guardrails/settings?agent=${agent}`, undefined, who);
        expect(r.status).toBe(200);
        expect(r.text).not.toContain("sk-test-");
        expect(r.text).not.toContain("xoxb-test");
      }
    }
    const g = (await get("/panel/api/guardrails/settings?agent=scout", undefined, superadmin)).body as GuardrailsResponse;
    expect(value(family(g, "redaction"), "patterns")).toMatchObject({ value: ["secret-\\d+"] });
    expect(value(family(g, "redaction"), "default-patterns")).toMatchObject({ value: ["secret-\\d+"] });
  });
});

describe("the runtime layer is code only", () => {
  test("the settings response carries no runtime-layer field; an unknown or bad agent is refused", async () => {
    const r = await get("/panel/api/guardrails/settings");
    expect(Object.keys(r.body).sort()).toEqual(["agent", "families"]);
    expect(r.body.families).toHaveLength(11);
    expect((await get("/panel/api/guardrails/settings?agent=Bad%20Name")).status).toBe(422);
  });

  test("registry states come from the runtime facts; absent, nothing is assumed wired", () => {
    expect(entry(UNKNOWN, "hook.stop.must-reply").state).toBe("not-wired");
    expect(entry(UNKNOWN, "gate.can-use-tool.permission").state).toBe("not-wired");
    expect(entry(MONO, "hook.stop.must-reply").state).toBe("enforcing");
    expect(entry(MONO, "gate.can-use-tool.permission").state).toBe("enforcing");
    expect(entry(MONO, "hook.stop.kb-first").state).toBe("not-built");
    expect(entry(MONO, "hook.stop.kb-first").fieldNote?.href).toContain("2026-06-13-kb-first-enforcement");
    expect(entry(MONO, "hook.pre-tool.owner-guardrails").state).toBe("enforcing");
    expect(entry(MONO, "hook.pre-tool.guardrail-files").state).toBe("enforcing");
  });

  test("an operator sees redaction counts, never pattern strings; a superadmin sees the patterns", () => {
    expect(entry(MONO, "redact.soul-patterns").details).toEqual([{ label: "Patterns", value: "1 pattern" }]);
    expect(entry(MONO, "redact.soul-patterns", "superadmin").details).toEqual([{ label: "Patterns", value: ["secret-\\d+"] }]);
  });

  test("env values only as on/off, mode or cap", () => {
    process.env.SLAUDE_DECISION_CONFIG = JSON.stringify({ gate: { mode: "shadow" }, adapter: { endpoint: "https://adapter.example.com/x" } });
    process.env.SLAUDE_OUTBOUND_ALLOWED_HOSTS = "idp.example.com";
    try {
      const all = JSON.stringify(GUARDRAILS.map((g) => g.details?.({ agent: "default", ...MONO }, { role: "superadmin" }) ?? []));
      expect(all).not.toContain("adapter.example.com");
      expect(all).not.toContain("idp.example.com");
      expect(entry(MONO, "gate.dispatch.decision")).toMatchObject({ state: "shadow", details: [{ label: "Mode", value: "shadow" }] });
      expect(entry(MONO, "gate.outbound.ssrf").details).toContainEqual({ label: "Allowed hosts list", value: "on" });
    } finally {
      delete process.env.SLAUDE_DECISION_CONFIG;
      delete process.env.SLAUDE_OUTBOUND_ALLOWED_HOSTS;
    }
  });

  test("on nodes the caveats are described: wake refusal order, env allow-list, wall clock, remote scope", () => {
    const wake = entry(NODE_RUNTIME, "gate.can-use-tool.wake-refusal");
    expect(wake.state).toBe("enforcing");
    expect(wake.details[0]!.label).toBe("On nodes");
    expect(String(wake.details[0]!.value)).toContain("refused on the node before its local policy");
    expect(entry(NODE_RUNTIME, "hook.stop.must-reply").state).toBe("enforcing");
    expect(entry(NODE_RUNTIME, "gate.can-use-tool.permission").details[0]).toMatchObject({ label: "Gateway env allow-list (SLAUDE_AUTO_ALLOW_TOOLS)" });
    expect(String(entry(NODE_RUNTIME, "gate.can-use-tool.permission").details[0]!.value)).toContain("each node reads its own");
    expect(String(entry(NODE_RUNTIME, "limit.wake-caps").details.find((d) => d.label === "Wall clock")!.value)).toContain("(nodes clamp to their turn timeout)");
    for (const id of ["hook.pre-tool.remote-deny-local", "gate.can-use-tool.remote", "deny.remote-local-tools"]) {
      expect(String(entry(NODE_RUNTIME, id).details[0]!.value)).toContain("threads bound with /remote");
    }
    expect(entry(MONO, "gate.can-use-tool.wake-refusal").details[0]!.label).toBe("In this process");
    expect(String(entry(MONO, "limit.wake-caps").details.find((d) => d.label === "Wall clock")!.value)).not.toContain("nodes");
  });

  test("the node facts match what the node worker installs", () => {
    const worker = readFileSync(new URL("../../src/node/worker.ts", import.meta.url), "utf8");
    expect(worker).toContain("agent.setPermissionResolver(");
    expect(worker).toContain("agent.setStopGuard(");
    expect(worker).toContain("agent.setGuardrailResolver(");
    expect(NODE_RUNTIME).toMatchObject({ stopGuard: true, permissionResolver: true });
  });
});

describe("soulSections", () => {
  test("takes matching ## sections with their ### subsections, skipping fenced headings", () => {
    const text = "## A\nx\n```\n## Proactive\n```\n## Proactive\n- Enabled: yes\n### Sub\ny\n## B\nz";
    expect(soulSections(text, /^proactive$/i)).toBe("## Proactive\n- Enabled: yes\n### Sub\ny");
  });
});
