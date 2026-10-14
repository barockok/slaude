import { describe, it, expect } from "bun:test";
import { parseTranscript, runTranscript } from "../../../src/gateway/sim/transcript";
import { BEHAVIORS } from "../../../src/gateway/sim/stub-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n), "utf8");

describe("transcript", () => {
  it("parses layer/role + steps", () => {
    const t = parseTranscript(fx("restricted.yaml"));
    expect(t.layer).toBe("restricted");
    expect(t.as).toBe("outsider");
    expect(t.steps.length).toBe(2);
  });
  it("runs the restricted transcript green", async () => {
    await runTranscript(parseTranscript(fx("restricted.yaml")));
  });
  it("runs the approval transcript green", async () => {
    await runTranscript(parseTranscript(fx("approval.yaml")));
  });
  it("waits for an approval card that lands after slow I/O (a real Postgres insert)", async () => {
    // The approval card is posted only after the pending_gates insert; on real
    // Postgres that is a network round trip, longer than one event-loop tick.
    BEHAVIORS.slow_approval = async (a) => {
      await new Promise((r) => setTimeout(r, 30));
      return BEHAVIORS.request_approval!(a);
    };
    try {
      await runTranscript(parseTranscript([
        "layer: trusted",
        "as: member",
        "agent_behavior: slow_approval",
        "steps:",
        '  - send: { text: "deploy prod" }',
        "  - expect_card: { kind: approval }",
        "  - click: { as: U0APP, action: approve }",
        '  - expect_reply: { contains: "approved by" }',
      ].join("\n")));
    } finally {
      delete BEHAVIORS.slow_approval;
    }
  });
  it("fails a transcript whose assertion does not hold", async () => {
    const bad = parseTranscript("layer: dm\nas: manager\nsteps:\n  - send: { text: hi }\n  - expect_drop: { reason: whitelist }\n");
    await expect(runTranscript(bad)).rejects.toThrow(/expect_drop/);
  });
});
