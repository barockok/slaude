// Google Meet join flow — Playwright driving real (headful) Chromium under Xvfb.
// Meet blocks headless-shell; run via `xvfb-run`. Audio is wired by pointing the
// browser at the null-sinks with PULSE_SINK / PULSE_SOURCE.

import { chromium, type BrowserContext, type Page } from "playwright";
import { CALL_SINK, MIC_SOURCE } from "./audio";

const PROFILE_DIR = `${process.env.HOME}/.slaude/voice/chrome-profile`;

export interface JoinOptions {
  url: string;
  displayName: string;
  joinTimeoutMs?: number; // how long to wait in the "asking to join" lobby
}

export async function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, // real Chrome under Xvfb; Meet rejects headless
    viewport: { width: 1280, height: 720 },
    permissions: ["microphone", "camera"],
    locale: "en-US", // geo-derived locales break our selectors
    args: [
      "--use-fake-ui-for-media-stream", // auto-accept mic/cam prompts
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled",
      "--lang=en-US",
      "--remote-debugging-port=9222", // lets us attach/screenshot a live bridge
    ],
    env: {
      ...process.env,
      PULSE_SINK: CALL_SINK, // browser speaker → call_out
      PULSE_SOURCE: MIC_SOURCE, // browser mic ← bot_mic.monitor
    },
  });
}

/** Join a Meet as a guest (no Google login). Resolves once in the call. */
export async function joinMeet(ctx: BrowserContext, opts: JoinOptions): Promise<Page> {
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
  // sees no devices; both are fine for the listen-only milestone. The button
  // stays disabled until the name is non-empty.
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
}

export async function leaveMeet(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /leave call/i })
    .click({ timeout: 5_000 })
    .catch(() => {});
  await page.close().catch(() => {});
}
