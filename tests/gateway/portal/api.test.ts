import { beforeEach, describe, expect, test } from "bun:test";
import { createPortalApi } from "../../../src/gateway/portal/api";
import { mintPortalSession, PORTAL_AT_COOKIE } from "../../../src/gateway/portal/session";
import { mintLinkToken } from "../../../src/gateway/portal/link-token";
import { mintSession } from "../../../src/gateway/panel/auth/session";
import { db } from "../../../src/db/schema";
import * as Accounts from "../../../src/db/accounts";
import { countLinkTokenUses } from "../../../src/db/link-token-uses";
import type { PortalMeResponse } from "../../../src/gateway/portal/api-types";

const ISS = "https://idp.example.com";
const SECRET = "g".repeat(32);

function signedIn(sub: string, email: string): string {
  return `${PORTAL_AT_COOKIE}=${mintPortalSession({ sub, email, iss: ISS }, "portal_at")}`;
}

function post(body: unknown, cookie?: string, csrf = true): Request {
  return new Request("https://slaude.example.com/portal/api/link", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-portal-csrf": "1" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_OIDC_ISSUER = ISS;
  await Accounts._wipeForTests();
  await db.run("DELETE FROM link_token_uses");
  await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
});

describe("GET /portal/api/me", () => {
  test("answers the account, its issuer and how each identity was linked", async () => {
    const a = await Accounts.findAccountBySubject(ISS, "sub-1");
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a!.id, via: "signed-link" });

    const res = await createPortalApi().fetch(
      new Request("https://slaude.example.com/portal/api/me", { headers: { cookie: signedIn("sub-1", "alice@example.com") } }),
    );

    expect(res!.status).toBe(200);
    const body = (await res!.json()) as PortalMeResponse;
    expect(body.email).toBe("alice@example.com");
    expect(body.issuer).toBe(ISS);
    expect(body.slackIdentities).toEqual([
      { surface: "slack", teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", linkedAt: expect.any(Number), linkedVia: "signed-link" },
    ]);
  });
});

describe("redeeming an onboarding link", () => {
  test("binds the slack identity in the token to the signed-in account", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    expect(res!.status).toBe(200);
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.email).toBe("alice@example.com");
  });

  test("an anonymous redeem is refused and binds nothing", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(post({ token: t }));

    expect(res!.status).toBe(401);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  // The attack this shape exists to stop: a cross-site request cannot set a
  // custom header, so it cannot bind the attacker's Slack id to a victim's
  // signed-in account.
  test("a request without the anti-CSRF header is refused", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(post({ token: t }, signedIn("sub-1", "alice@example.com"), false));

    expect(res!.status).toBe(403);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("an expired token is refused", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, { now: Date.now() - 3_600_000 });

    const res = await createPortalApi().fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    expect(res!.status).toBe(400);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("a slack identity already bound to someone else is a conflict", async () => {
    const other = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: other.id, via: "signed-link" });
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    expect(res!.status).toBe(409);
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.id).toBe(other.id);
  });

  test("redeeming the same token twice for the same account is idempotent", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const api = createPortalApi();
    await api.fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    const again = await api.fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    expect(again!.status).toBe(200);
  });

  // Defect 4 of the slice C plan: unlinking deleted the only record of the use.
  test("a token cannot relink after an unlink within its lifetime", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const api = createPortalApi();
    const cookie = signedIn("sub-1", "alice@example.com");
    expect((await api.fetch(post({ token: t }, cookie)))!.status).toBe(200);
    const acct = await Accounts.findAccountBySubject(ISS, "sub-1");
    expect(await Accounts.unlinkSlackIdentity("TTESTTEAM1", "UTESTUSER1", acct!.id)).toBe(true);

    const replay = await api.fetch(post({ token: t }, cookie));

    expect(replay!.status).toBe(400);
    expect(((await replay!.json()) as { error: string }).error).toMatch(/already used/);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("a replay by another account while the link stands changes nothing", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const api = createPortalApi();
    await api.fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));
    const other = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });

    const res = await api.fetch(post({ token: t }, signedIn("sub-2", "bob@example.com")));

    expect(res!.status).toBe(409);
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.id).not.toBe(other.id);
  });

  test("a fresh token for the same identity works after an unlink", async () => {
    const api = createPortalApi();
    const cookie = signedIn("sub-1", "alice@example.com");
    await api.fetch(post({ token: mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }) }, cookie));
    const acct = await Accounts.findAccountBySubject(ISS, "sub-1");
    await Accounts.unlinkSlackIdentity("TTESTTEAM1", "UTESTUSER1", acct!.id);

    const res = await api.fetch(post({ token: mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }) }, cookie));

    expect(res!.status).toBe(200);
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.email).toBe("alice@example.com");
  });

  test("two concurrent redeems of one token produce one link", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const api = createPortalApi();
    const cookie = signedIn("sub-1", "alice@example.com");

    const [a, b] = await Promise.all([api.fetch(post({ token: t }, cookie)), api.fetch(post({ token: t }, cookie))]);

    const bodies = [(await a!.json()) as { created?: boolean }, (await b!.json()) as { created?: boolean }];
    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect(bodies.filter((x) => x.created === true)).toHaveLength(1);
    const acct = await Accounts.findAccountBySubject(ISS, "sub-1");
    expect(await Accounts.slackIdentitiesForAccount(acct!.id)).toHaveLength(1);
    expect(await countLinkTokenUses()).toBe(1);
  });

  test("two accounts racing one token: one link, the other refused", async () => {
    const other = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const api = createPortalApi();

    const rs = await Promise.all([
      api.fetch(post({ token: t }, signedIn("sub-1", "alice@example.com"))),
      api.fetch(post({ token: t }, signedIn("sub-2", "bob@example.com"))),
    ]);

    expect(rs.map((r) => r!.status).sort()).toEqual([200, 409]);
    const owner = await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1");
    expect([other.id, (await Accounts.findAccountBySubject(ISS, "sub-1"))!.id]).toContain(owner!.id);
  });

  test("the confirmation page does not itself bind", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(
      new Request(`https://slaude.example.com/portal/link?t=${t}`, { headers: { cookie: signedIn("sub-1", "alice@example.com") } }),
    );

    expect(res!.status).toBe(200);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  const linkPage = async (names: Parameters<typeof createPortalApi>[0] extends infer D ? (D extends { names?: infer N } ? N : never) : never) => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const res = await createPortalApi({ names }).fetch(
      new Request(`https://slaude.example.com/portal/link?t=${t}`, { headers: { cookie: signedIn("sub-1", "alice@example.com") } }),
    );
    return { res: res!, page: await res!.text(), token: t };
  };

  test("the confirmation page is styled with the design tokens and shows names, ids as secondary text", async () => {
    const { res, page, token } = await linkPage({
      teamName: async (id: string) => (id === "TTESTTEAM1" ? "Example Workspace" : null),
      userName: async (id: string) => (id === "UTESTUSER1" ? "Jane Doe" : null),
    });
    expect(res.status).toBe(200);
    expect(page).toContain("--sl-page-bg");
    expect(page).toContain('data-team-name="Example Workspace"');
    expect(page).toContain('data-user-name="Jane Doe"');
    expect(page).toContain('data-team="TTESTTEAM1"');
    expect(page).toContain(`data-token="${token}"`);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("the confirmation page is surface-neutral: the surface is a row of its own, set from a data attribute", async () => {
    const { page } = await linkPage({ teamName: async () => null, userName: async () => null });
    expect(page).toContain('data-surface="Slack"');
    expect(page).toContain("<dt>Surface</dt>");
    expect(page).toContain("<dt>User</dt>");
    expect(page).toContain("links the chat identity below");
    expect(page).not.toContain("Slack user");
    // The script reads the label from the DOM; the label is never interpolated into it.
    const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(page)![1]!;
    expect(script).toContain("d.surface");
    expect(script).not.toContain('"Slack"');
  });

  test("names from Slack cannot inject markup or script: escaped into attributes, nothing interpolated into the script", async () => {
    const evil = `</script><img src=x onerror="alert(1)">'"&`;
    const { page } = await linkPage({ teamName: async () => evil, userName: async () => `</style><script>alert(2)</script>` });
    expect(page).not.toContain("<img");
    expect(page).not.toContain("alert(2)</script>");
    expect(page).toContain('data-team-name="&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&quot;&amp;"');
    // Exactly one script element, whose body names no value.
    const scripts = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).not.toContain("TTESTTEAM1");
    expect(scripts[0]![1]).not.toContain("onerror");
  });

  test("the page carries a strict CSP with one nonce for its style and its script", async () => {
    const { res, page } = await linkPage({ teamName: async () => null, userName: async () => null });
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
    expect(page).toContain(`<script nonce="${nonce}">`);
    expect(page).toContain(`<style nonce="${nonce}">`);
    // A fresh nonce per response.
    const again = await linkPage({ teamName: async () => null, userName: async () => null });
    expect(again.res.headers.get("content-security-policy")).not.toContain(nonce);
  });

  test("names that cannot be resolved leave the ids alone", async () => {
    const { res, page } = await linkPage({ teamName: async () => { throw new Error("slack down"); }, userName: async () => null });
    expect(res.status).toBe(200);
    expect(page).toContain('data-team-name=""');
    expect(page).toContain('data-team="TTESTTEAM1"');
  });

  test("an expired link page has the same CSP", async () => {
    const res = await createPortalApi().fetch(
      new Request("https://slaude.example.com/portal/link?t=bogus", { headers: { cookie: signedIn("sub-1", "alice@example.com") } }),
    );
    expect(res!.status).toBe(400);
    expect(res!.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("the confirmation page sends an anonymous visitor to login, preserving the token", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(new Request(`https://slaude.example.com/portal/link?t=${t}`));

    expect(res!.status).toBe(302);
    const loc = res!.headers.get("location")!;
    expect(loc).toStartWith("/portal/auth/login?returnTo=");
    expect(decodeURIComponent(loc)).toContain(t);
  });
});

// The two surfaces share an issuer, a signing secret and a process. What keeps
// them apart is the token type plus the cookie name — not the panel's role
// lookup, which the portal deliberately does not perform.
describe("an operator's panel credential on the portal", () => {
  test("a panel access token in the portal cookie is refused", async () => {
    const panelToken = mintSession({ sub: "sub-1", email: "alice@example.com" }, "at");
    const res = await createPortalApi().fetch(
      new Request("https://slaude.example.com/portal/api/me", {
        headers: { cookie: `${PORTAL_AT_COOKIE}=${panelToken}` },
      }),
    );

    expect(res!.status).toBe(401);
  });

  test("it cannot redeem an onboarding link either", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const panelToken = mintSession({ sub: "sub-1", email: "alice@example.com" }, "at");

    const res = await createPortalApi().fetch(post({ token: t }, `${PORTAL_AT_COOKIE}=${panelToken}`));

    expect(res!.status).toBe(401);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  // The mirror direction: an onboarding link is signed with the same secret and
  // must not be presentable as a session.
  test("an onboarding link token is not a portal session", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(
      new Request("https://slaude.example.com/portal/api/me", { headers: { cookie: `${PORTAL_AT_COOKIE}=${t}` } }),
    );

    expect(res!.status).toBe(401);
  });
});

// A still-valid cookie must stop working the moment the account is gone: the
// guard re-resolves (issuer, subject) per request instead of trusting the
// token's claims, the same way the panel re-resolves roles.
describe("an account deleted mid-session", () => {
  test("its cookie stops working at the very next request", async () => {
    const cookie = signedIn("sub-1", "alice@example.com");
    const api = createPortalApi();
    const me = () => api.fetch(new Request("https://slaude.example.com/portal/api/me", { headers: { cookie } }));
    expect((await me())!.status).toBe(200);

    await Accounts._wipeForTests();

    expect((await me())!.status).toBe(401);
  });

  test("it cannot redeem an onboarding link", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const cookie = signedIn("sub-1", "alice@example.com");
    await Accounts._wipeForTests();

    const res = await createPortalApi().fetch(post({ token: t }, cookie));

    expect(res!.status).toBe(401);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });
});

describe("unlinking", () => {
  test("a user can remove their own binding", async () => {
    const a = await Accounts.findAccountBySubject(ISS, "sub-1");
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a!.id, via: "signed-link" });
    const req = new Request("https://slaude.example.com/portal/api/link", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-portal-csrf": "1", cookie: signedIn("sub-1", "alice@example.com") },
      body: JSON.stringify({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }),
    });

    const res = await createPortalApi().fetch(req);

    expect(res!.status).toBe(200);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("a user cannot remove someone else's binding", async () => {
    const other = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: other.id, via: "signed-link" });
    const req = new Request("https://slaude.example.com/portal/api/link", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-portal-csrf": "1", cookie: signedIn("sub-1", "alice@example.com") },
      body: JSON.stringify({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }),
    });

    const res = await createPortalApi().fetch(req);

    expect(res!.status).toBe(404);
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.id).toBe(other.id);
  });
});
