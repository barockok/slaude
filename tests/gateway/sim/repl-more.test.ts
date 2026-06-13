import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { ReplController, replCommandNames, SIM_COMMANDS } from "../../../src/gateway/sim/repl";
import { paths } from "../../../src/config/home";
import { setSoulData } from "../../../src/soul/extract";
import { SoulDataSchema } from "../../../src/soul/data";

let r: ReplController | undefined;
afterEach(async () => { await r?.dispose(); r = undefined; });

describe("REPL controller — gates, clicks, inspection, shared mode", () => {
  it("replCommandNames merges sim-native heads with the agent slash heads", () => {
    const names = replCommandNames();
    for (const c of SIM_COMMANDS) expect(names).toContain(c);
    expect(names).toContain("/1on1");      // derived from AGENT_COMMANDS usage strings
  });

  it("bare input answers an open gate: hints, aliases, numerics, and resolution", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.startDefault();                       // dm, acting as manager U0MGR
    await r.handle("/behavior request_approval");
    await r.handle("deploy please");              // opens an approval gate
    expect(out.join("\n").toLowerCase()).toContain("approval");

    // bogus input while the gate is open → usage hint, gate untouched
    out.length = 0;
    await r.handle("zzz");
    expect(out.join("\n")).toContain("open gate");

    // "A"/always doesn't exist on approval gates → hint again (mapVerb finds no always verb)
    out.length = 0;
    await r.handle("A");
    expect(out.join("\n")).toContain("open gate");

    // exact verb / numeric / deny-alias as the manager — NOT an approver, so it stays pending
    await r.handle("approve");
    await r.handle("1");
    await r.handle("d");

    // the approver allows with the "a" alias → gate resolves, behavior replies
    await r.handle("/as approver");
    await r.handle("a");
    out.length = 0;
    await r.handle("/cards");
    const o = out.join("\n");
    expect(o).toContain("(resolved)");
    expect(o).toContain("approved by");
  });

  it("/click clicks a live card by index (default + explicit verb) and reports a missing one", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.startDefault();
    await r.handle("/behavior request_approval");
    await r.handle("ship it");                    // approval card = live card #1

    out.length = 0;
    await r.handle("/click 9");
    expect(out.join("\n")).toContain("no live card #9");

    await r.handle("/click 1 deny");              // explicit verb (manager unauthorized → pending)
    out.length = 0;
    await r.handle("/click 1");                   // default verb = first action id
    expect(out.join("\n")).toContain("[card");    // stub path re-dumps the cards
  });

  it("/memory on a stub session reports there is no real-agent session", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.startDefault();
    out.length = 0;
    await r.handle("/memory");
    expect(out.join("\n")).toContain("no active real-agent session");
  });

  it("startShared boots against $SLAUDE_HOME and warns when no manager resolves", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;       // extractor throws fast → regex fallback (no manager)
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    rmSync(paths.soul, { recursive: true, force: true });
    writeFileSync(paths.soul, "# SOUL\n\nA plain persona with no ids.\n", "utf8");
    try {
      r = new ReplController();
      const out: string[] = [];
      r.onOutput((l) => out.push(l));
      await r.startShared();
      const o = out.join("\n");
      expect(o).toContain("shared config");
      expect(o).toContain("no manager resolved");
    } finally {
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
      if (oauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
    }
  });

  it("startShared greets as the resolved manager when soul data has one", async () => {
    // Make loadSoulData throw (SOUL.md is a directory) so the pre-seeded memo survives the
    // prewarm — that's the engine's catch path, and the repl then reads the memo's manager.
    rmSync(paths.soul, { recursive: true, force: true });
    mkdirSync(paths.soul);
    setSoulData(SoulDataSchema.parse({ manager: { userId: "U0MGR" } }));
    try {
      r = new ReplController();
      const out: string[] = [];
      r.onOutput((l) => out.push(l));
      await r.startShared();
      const o = out.join("\n");
      expect(o).toContain("chatting as U0MGR");
      expect(o).not.toContain("no manager resolved");
    } finally {
      rmSync(paths.soul, { recursive: true, force: true });
    }
  });
});
