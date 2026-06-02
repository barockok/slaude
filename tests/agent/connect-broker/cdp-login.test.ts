import { describe, it, expect } from "bun:test";
import { CHROME_CONFINE_FLAGS, captureReady, CdpLoginHost } from "../../../src/agent/connect-broker/cdp-login";

describe("cdp login confinement + capture", () => {
  it("ships the confinement flag set (kiosk, no devtools)", () => {
    expect(CHROME_CONFINE_FLAGS).toContain("--kiosk");
    expect(CHROME_CONFINE_FLAGS.join(" ")).toContain("--disable-dev-tools");
  });

  it("token capture: ready when an access token is observed", () => {
    expect(captureReady("token", { tokenSeen: true, cookiesForDomain: false, userClickedDone: false })).toBe(true);
    expect(captureReady("token", { tokenSeen: false, cookiesForDomain: false, userClickedDone: false })).toBe(false);
  });

  it("cookie capture: ready when target-domain cookies present OR user clicks Done", () => {
    expect(captureReady("cookie", { tokenSeen: false, cookiesForDomain: true, userClickedDone: false })).toBe(true);
    expect(captureReady("cookie", { tokenSeen: false, cookiesForDomain: false, userClickedDone: true })).toBe(true);
    expect(captureReady("cookie", { tokenSeen: false, cookiesForDomain: false, userClickedDone: false })).toBe(false);
  });

  it("CdpLoginHost.start is a deploy-time seam (throws until wired)", async () => {
    const host = new CdpLoginHost();
    await expect(
      host.start({ service: "jira", slackUserId: "U1", loginUrl: "https://x", authStrategy: "token" }),
    ).rejects.toThrow(/deploy time/);
  });
});
