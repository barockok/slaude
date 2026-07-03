// Generic browser session for the voice bridge. Platform-free by design:
// from the bridge's point of view a meeting is just a web page; the real
// interface is the virtual audio pair (speaker sink + mic source). Anything
// page-specific (join buttons, lobbies) lives in a navigator, not here.

import { chromium, type BrowserContext } from "playwright";
import { CALL_SINK, MIC_SOURCE } from "./audio";

const PROFILE_DIR = `${process.env.HOME}/.slaude/voice/chrome-profile`;

export async function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, // real Chrome under Xvfb; call platforms reject headless
    viewport: { width: 1280, height: 720 },
    permissions: ["microphone", "camera"],
    locale: "en-US", // geo-derived locales break navigator selectors
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
      PULSE_SOURCE: MIC_SOURCE, // browser mic ← virtmic (bot_mic remap)
    },
  });
}
