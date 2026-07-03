// Google Meet navigator. Note: consumer-account meetings reject anonymous
// guests outright ("You can't join this video call") — a signed-in Google
// profile in the persistent browser profile is required for those.

import type { BrowserContext, Page } from "playwright";
import type { JoinOptions, Navigator } from "./navigator";

export const meetNavigator: Navigator = {
  matches: (url) => /(^|\.)meet\.google\.com$/.test(url.hostname),

  async join(ctx: BrowserContext, opts: JoinOptions): Promise<Page> {
    const page = await ctx.newPage();
    // hl=en forces Meet's UI language regardless of account/geo defaults.
    const url = new URL(opts.url);
    url.searchParams.set("hl", "en");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });

    // Promo tooltips ("Sign in with your Google account") overlay the form
    // and can swallow interactions — dismiss before touching anything.
    await page
      .getByRole("button", { name: /got it/i })
      .click({ timeout: 3_000 })
      .catch(() => {});

    // Guest flow: name field appears when not signed in.
    const nameBox = page.getByPlaceholder("Your name");
    if (await nameBox.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await nameBox.click();
      await nameBox.fill(opts.displayName);
      // The join button only enables once Meet registers a non-empty name.
      if ((await nameBox.inputValue()) !== opts.displayName) {
        await nameBox.pressSequentially(opts.displayName, { delay: 50 });
      }
    }

    // Pre-join screen: mute cam, keep mic (we ARE the mic).
    await page
      .getByRole("button", { name: /turn off camera/i })
      .click({ timeout: 5_000 })
      .catch(() => {}); // already off / not present

    // "Ask to join" may render as "... without microphone & camera" when Meet
    // sees no devices; both are fine for listen-only. The button stays
    // disabled until the name is non-empty.
    const joinBtn = page
      .getByRole("button", { name: /join now|ask to join/i })
      .first();
    try {
      await joinBtn.click({ timeout: 15_000 });
    } catch (err) {
      await page.screenshot({ path: "/tmp/meet-join-fail.png" }).catch(() => {});
      throw err;
    }

    // In-call marker: the leave-call control. Long timeout covers lobby approval.
    await page
      .getByRole("button", { name: /leave call/i })
      .waitFor({ state: "visible", timeout: opts.joinTimeoutMs ?? 120_000 });

    return page;
  },

  async leave(page: Page): Promise<void> {
    await page
      .getByRole("button", { name: /leave call/i })
      .click({ timeout: 5_000 })
      .catch(() => {});
    await page.close().catch(() => {});
  },
};
