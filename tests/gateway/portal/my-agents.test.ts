/**
 * GET /portal/api/my-agents: the agents each Slack identity linked to the
 * signed-in account holds a user-level role on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPortalApi } from "../../../src/gateway/portal/api";
import { mintPortalSession, PORTAL_AT_COOKIE } from "../../../src/gateway/portal/session";
import * as Accounts from "../../../src/db/accounts";
import * as AgentGrants from "../../../src/db/agent-grants";
import { db } from "../../../src/db/schema";
import { SoulDataSchema } from "../../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../../src/soul/extract";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../../src/persona/registry";
import { __setGrantsReader } from "../../../src/access/role";
import type { MyAgentsResponse } from "../../../src/gateway/portal/api-types";

const ISS = "https://idp.example.com";
const SECRET = "g".repeat(32);
const signedIn = (sub: string, email: string) => `${PORTAL_AT_COOKIE}=${mintPortalSession({ sub, email, iss: ISS }, "portal_at")}`;
const get = async (cookie?: string) => {
  const res = (await createPortalApi().fetch(
    new Request("https://slaude.example.com/portal/api/my-agents", { headers: cookie ? { cookie } : {} }),
  ))!;
  return { status: res.status, body: (await res.json()) as MyAgentsResponse & { error?: string } };
};

function registryWith(personas: Array<{ name: string; soulJson?: unknown }>): PersonaRegistry {
  const full = personas.map((p) => ({ slackUserId: `UP${p.name.toUpperCase()}`, config: { slackUserId: "UX", name: p.name }, outClient: null, ...p }) as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
  };
}

const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  for (const k of ["SLAUDE_PORTAL", "SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_OIDC_ISSUER"]) saved[k] = process.env[k];
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_OIDC_ISSUER = ISS;
  await Accounts._wipeForTests();
  await db.run("DELETE FROM agent_grants");
  __setGrantsReader(null);
  // Default agent: UALICE manages it; everyone in CTEAM may talk to it, and the
  // whole workspace via a stored grant below. UBOB is blocked.
  setSoulData(SoulDataSchema.parse({ manager: { userId: "UALICE" }, trustedChannels: ["CTEAM"], blockedUsers: ["UBOB"] }));
  setPersonaRegistry(registryWith([
    { name: "scout", soulJson: { manager: { userId: "USCOUT" }, approvers: [{ userId: "UALICE", scope: "a", catchall: true }] } },
    { name: "ledger", soulJson: { manager: { userId: "ULEDGER" }, channelOverrides: [{ channel: "CFIN", approvers: [{ userId: "UCAROL", scope: "b", catchall: true }] }] } },
  ]));
  await AgentGrants.create({ persona: "default", subjectKind: "workspace", subjectId: "TTEAM", role: "member", createdBy: "lead@example.com" });
  await AgentGrants.create({ persona: "ledger", subjectKind: "user", subjectId: "UALICEWORK", role: "member", createdBy: "lead@example.com" });
});
afterEach(async () => {
  __setGrantsReader(null);
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  await db.run("DELETE FROM agent_grants");
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("GET /portal/api/my-agents", () => {
  test("refuses an anonymous request", async () => {
    expect((await get()).status).toBe(401);
  });

  test("user-level roles of every linked identity: soul and stored grants, never channel or workspace admission", async () => {
    const acct = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTEAM", slackUserId: "UALICE", accountId: acct.id, via: "signed-link" });
    await Accounts.linkSlackIdentity({ teamId: "TWORK", slackUserId: "UALICEWORK", accountId: acct.id, via: "signed-link" });
    const r = await get(signedIn("sub-1", "alice@example.com"));
    expect(r.status).toBe(200);
    expect(r.body.agents).toEqual([
      { persona: "default", teamId: "TTEAM", slackUserId: "UALICE", role: "manager" },
      { persona: "scout", teamId: "TTEAM", slackUserId: "UALICE", role: "approver" },
      // UALICEWORK reaches `default` only through the workspace grant: not listed.
      { persona: "ledger", teamId: "TWORK", slackUserId: "UALICEWORK", role: "member" },
    ]);
  });

  test("a blocked user, a channel-scoped approver, or no identity at all lists nothing", async () => {
    const acct = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    expect((await get(signedIn("sub-2", "bob@example.com"))).body.agents).toEqual([]);
    await Accounts.linkSlackIdentity({ teamId: "TTEAM", slackUserId: "UBOB", accountId: acct.id, via: "signed-link" });
    await Accounts.linkSlackIdentity({ teamId: "TTEAM", slackUserId: "UCAROL", accountId: acct.id, via: "signed-link" });
    expect((await get(signedIn("sub-2", "bob@example.com"))).body.agents).toEqual([]);
  });

  test("a stored deny hides a soul role", async () => {
    const acct = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTEAM", slackUserId: "UALICE", accountId: acct.id, via: "signed-link" });
    await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "UALICE", role: "member", deny: true, createdBy: "lead@example.com" });
    expect((await get(signedIn("sub-1", "alice@example.com"))).body.agents.map((a) => a.persona)).toEqual(["default"]);
  });
});
