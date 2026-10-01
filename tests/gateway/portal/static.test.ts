/**
 * How the portal's own mount serves the app: what needs a session and what does
 * not, and what must not be answered with the app at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Accounts from "../../../src/db/accounts";
import { createPortalApi } from "../../../src/gateway/portal/api";
import { mintPortalSession, PORTAL_AT_COOKIE } from "../../../src/gateway/portal/session";

const ISS = "https://idp.example.com";
const SECRET = "g".repeat(32);
const signedIn = () => `${PORTAL_AT_COOKIE}=${mintPortalSession({ sub: "alice", email: "alice@example.com", iss: ISS }, "portal_at")}`;

const get = (path: string, cookie?: string) =>
  new Request(`https://slaude.example.com${path}`, { headers: cookie ? { cookie } : {} });

beforeEach(async () => {
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://slaude.example.com";
  process.env.SLAUDE_PANEL_OIDC_ISSUER = ISS;
  await Accounts._wipeForTests();
  await Accounts.upsertAccount({ issuer: ISS, subject: "alice", email: "alice@example.com" });
});

describe("serving the portal app", () => {
  test("an anonymous visitor is sent to sign in, not handed the shell", async () => {
    const res = await createPortalApi().fetch(get("/portal"));
    expect(res!.status).toBe(302);
    expect(res!.headers.get("location")).toContain("/portal/auth/login");
  });

  test("a signed-in visitor gets the shell", async () => {
    const res = await createPortalApi().fetch(get("/portal", signedIn()));
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/html");
  });

  // Client routes must reach the app rather than a 404, or a reload of any
  // in-app URL breaks.
  test("a client route falls back to the shell", async () => {
    const res = await createPortalApi().fetch(get("/portal/integrations", signedIn()));
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/html");
  });

  test("an unknown auth path is not answered with the app", async () => {
    const res = await createPortalApi().fetch(get("/portal/auth/nope", signedIn()));
    expect(res!.status).toBe(404);
  });

  test("an unknown api path is not answered with the app", async () => {
    const res = await createPortalApi().fetch(get("/portal/api/nope", signedIn()));
    expect(res!.status).toBe(404);
  });

  // A literal `..` is already collapsed by URL parsing before the portal sees
  // it (that request leaves /portal entirely and falls through). An encoded one
  // survives parsing, so that is the case the mount itself has to refuse.
  test("encoded traversal out of the web root does not serve a file", async () => {
    const res = await createPortalApi().fetch(get("/portal/%2e%2e/%2e%2e/etc/passwd", signedIn()));
    expect(res === null || res.status === 403 || res.status === 404).toBe(true);
    if (res && res.status === 200) expect(await res.text()).not.toContain("root:");
  });

  afterEach(() => {
    process.env.SLAUDE_PORTAL = "1";
  });
});
