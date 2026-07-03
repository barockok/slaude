// Jitsi Meet navigator — anonymous guest join. meet.jit.si requires an
// authenticated moderator to START a room (2023 policy); guests join
// anonymously once it exists. Uses Jitsi's stable data-testid attributes.

import type { BrowserContext, Page } from "playwright";
import type { JoinOptions, Navigator } from "./navigator";

export const jitsiNavigator: Navigator = {
  matches: (url) => /jit\.si$|8x8\.vc$/.test(url.hostname),

  async join(ctx: BrowserContext, opts: JoinOptions): Promise<Page> {
    const page = await ctx.newPage();
    const url = new URL(opts.url);
    url.hash =
      '#config.prejoinConfig.enabled=true&userInfo.displayName="' +
      encodeURIComponent(opts.displayName) +
      '"';
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });

    // Prejoin: name field (may be prefilled from the URL fragment) + join.
    const nameBox = page.locator("input[placeholder]").first();
    if (await nameBox.isVisible({ timeout: 15_000 }).catch(() => false)) {
      const current = await nameBox.inputValue().catch(() => "");
      if (!current) await nameBox.fill(opts.displayName);
    }
    const joinBtn = page
      .locator('[data-testid="prejoin.joinMeeting"], [aria-label="Join meeting"]')
      .first();
    await joinBtn.click({ timeout: 15_000 });

    // In-call marker: the hangup control. Long timeout covers "waiting for
    // moderator" when the host hasn't started the room yet. (Known gap: the
    // lobby shows a hangup control too — this can fire before audio flows.)
    await page
      .locator('[data-testid="toolbox-hangup"], [aria-label*="eave"]')
      .first()
      .waitFor({ state: "visible", timeout: opts.joinTimeoutMs ?? 300_000 });

    return page;
  },

  async leave(page: Page): Promise<void> {
    await page
      .locator('[data-testid="toolbox-hangup"]')
      .first()
      .click({ timeout: 5_000 })
      .catch(() => {});
    await page.close().catch(() => {});
  },
};
