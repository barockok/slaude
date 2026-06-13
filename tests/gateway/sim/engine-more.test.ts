import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { SimSession } from "../../../src/gateway/sim/engine";
import { paths } from "../../../src/config/home";
import { setSoulData } from "../../../src/soul/extract";
import { SoulDataSchema } from "../../../src/soul/data";

let s: SimSession | undefined;
afterEach(async () => { await s?.dispose(); s = undefined; });

describe("SimSession — shared mode", () => {
  it("boots without fixtures: synthetic DM, fallback actor when no manager resolves", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;       // soul prewarm falls back to regex (no manager)
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    rmSync(paths.soul, { recursive: true, force: true });
    writeFileSync(paths.soul, "# SOUL\n\nA plain persona, no ids.\n", "utf8");
    try {
      s = await SimSession.create({ agent: "stub", mode: "shared" });
      expect(s.dm).toBe(true);
      expect(s.channel).toBe("D0SIM");
      expect(s.actor).toBe("U0MGR");            // fallback actor when the soul has no manager
      expect(s.behavior).toBe("reply");
      await s.send({ text: "hello" });          // DM gate may drop it — must not throw
    } finally {
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
      if (oauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
    }
  });

  it("warns when the soul prewarm throws and adopts the memoized manager as actor", async () => {
    rmSync(paths.soul, { recursive: true, force: true });
    mkdirSync(paths.soul);                      // loadSoul → readFileSync(dir) throws → catch path
    setSoulData(SoulDataSchema.parse({ manager: { userId: "U0REAL" } }));
    try {
      s = await SimSession.create({ agent: "stub", mode: "shared", behavior: "reply" });
      expect(s.actor).toBe("U0REAL");           // memo survived the failed prewarm
      expect(s.dm).toBe(true);
    } finally {
      rmSync(paths.soul, { recursive: true, force: true });
    }
  });
});

describe("SimSession — gate helpers and agent introspection", () => {
  it("pendingGate exposes the open gate; resolveGate falls back on unknown verbs and throws when none", async () => {
    s = await SimSession.create({ layer: "trusted", as: "member", behavior: "request_approval", agent: "stub" });
    await s.send({ text: "deploy" });
    const gate = s.pendingGate();
    expect(gate).toBeDefined();
    expect(gate!.kind).toBe("approval");

    // unknown verb → falls back to the first action id; U0BOB isn't an approver → stays pending
    s.actor = "U0BOB";
    await s.resolveGate("not-a-verb");
    expect(s.pendingGate()).toBeDefined();

    // the catchall approver resolves it
    s.actor = "U0APP";
    await s.resolveGate("approve");
    expect(s.pendingGate()).toBeUndefined();

    await expect(s.resolveGate("approve")).rejects.toThrow("no pending gate");
  });

  it("onAgentEvent / abort / usage / liveCount are safe no-ops on a stub session", async () => {
    s = await SimSession.create({ layer: "dm", as: "manager", agent: "stub" });
    const off = s.onAgentEvent(() => {});       // stub → no-op unsubscribe
    off();
    s.abort("nope");                            // inherited AgentManager.abort: unknown id no-op
    expect(s.usage("nope")).toBeNull();
    expect(s.liveCount()).toBe(0);
  });
});
