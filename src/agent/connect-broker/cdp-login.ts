import type { LoginHost, LoginSession } from "./login-types";

/** Chrome flags that confine the login browser to "just the auth page". */
export const CHROME_CONFINE_FLAGS = [
  "--kiosk",
  "--disable-dev-tools",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  // navigation/file access are further locked via CDP Page.setDownloadBehavior=deny
  // and a Page.navigate allowlist; see start().
];

export type CaptureSignals = { tokenSeen: boolean; cookiesForDomain: boolean; userClickedDone: boolean };

/** Decide whether the credential is ready to capture given the live signals. */
export function captureReady(strategy: "token" | "cookie", s: CaptureSignals): boolean {
  if (strategy === "token") return s.tokenSeen;
  return s.cookiesForDomain || s.userClickedDone;
}

/**
 * Real Chrome-backed implementation. NOT exercised in CI (requires a headful
 * Chrome + display). Verified manually per docs/connect-broker-login.md.
 *
 * Responsibilities:
 *  - spawn Chrome with CHROME_CONFINE_FLAGS + CDP enabled on a random loopback port (never exposed)
 *  - serve a server-mediated web-CDP screencast live-view behind the signed token
 *    (Page.startScreencast + Input.dispatch*; Target.setAutoAttach for window.open popups)
 *  - watch capture signals; when captureReady(), capture token (OAuth redirect) or
 *    storageState (cookies); verify the completing slack user == bound user
 *  - resolve LoginSession.done with the CapturedCred, then tear the browser down
 */
export class CdpLoginHost implements LoginHost {
  async start(_args: { service: string; slackUserId: string; loginUrl: string; authStrategy: "token" | "cookie" }): Promise<LoginSession> {
    throw new Error("CdpLoginHost.start is wired at deploy time; see Task 14 + docs/connect-broker-login.md");
  }
}
