import { afterEach, describe, expect, test } from "bun:test";
import { brainEnabled } from "../src/knowledge/brain";
import { brainMode } from "../src/knowledge/brain-config";

// The gateway gates its local brain source-bootstrap + nightly maintenance on
// `brainEnabled() && brainMode() === "local"`. In remote mode the separate
// brain-server process owns those; the gateway must NOT run them. This pins the
// decision the gateway block at gateway.ts:226 depends on.
function gatewayBootstrapsBrainLocally(): boolean {
  return brainEnabled() && brainMode() === "local";
}

afterEach(() => {
  delete process.env.SLAUDE_BRAIN_MODE;
  delete process.env.SLAUDE_BRAIN_DISABLED;
});

describe("gateway brain bootstrap gating", () => {
  test("local mode bootstraps the brain in-process", () => {
    expect(gatewayBootstrapsBrainLocally()).toBe(true);
  });

  test("remote mode defers bootstrap to the brain-server process", () => {
    process.env.SLAUDE_BRAIN_MODE = "remote";
    expect(gatewayBootstrapsBrainLocally()).toBe(false);
  });

  test("brain disabled never bootstraps", () => {
    process.env.SLAUDE_BRAIN_DISABLED = "1";
    expect(gatewayBootstrapsBrainLocally()).toBe(false);
  });
});
