import { beforeEach, describe, expect, test } from "bun:test";
import { createPortalApi } from "../../../src/gateway/portal/api";
import { mintPortalSession, PORTAL_AT_COOKIE } from "../../../src/gateway/portal/session";
import { mintLinkToken } from "../../../src/gateway/portal/link-token";
import * as Accounts from "../../../src/db/accounts";

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
  await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
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

  test("the confirmation page does not itself bind", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(
      new Request(`https://slaude.example.com/portal/link?t=${t}`, { headers: { cookie: signedIn("sub-1", "alice@example.com") } }),
    );

    expect(res!.status).toBe(200);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
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
