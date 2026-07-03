// A navigator gets the bridge's browser onto the meeting page and back off.
// It is the ONLY layer allowed to know platform specifics; the bridge core
// interfaces with the call purely through the virtual audio devices.

import type { BrowserContext, Page } from "playwright";

export interface JoinOptions {
  url: string;
  displayName: string;
  joinTimeoutMs?: number;
}

export interface Navigator {
  /** Claim URLs this navigator understands. */
  matches(url: URL): boolean;
  /** Get into the call; resolve once audio can flow. */
  join(ctx: BrowserContext, opts: JoinOptions): Promise<Page>;
  /** Get out gracefully. */
  leave(page: Page): Promise<void>;
}

/**
 * Fallback for unknown platforms: open the page and stop. Whoever operates
 * the bridge (human via noVNC, or the big-brain session via the debug port)
 * completes the join; audio plumbing works regardless.
 */
export const genericNavigator: Navigator = {
  matches: () => true,
  async join(ctx, opts) {
    const page = await ctx.newPage();
    await page.goto(opts.url, { waitUntil: "domcontentloaded" });
    return page;
  },
  async leave(page) {
    await page.close().catch(() => {});
  },
};
