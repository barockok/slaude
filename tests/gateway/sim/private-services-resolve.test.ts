import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../src/config/home";
import { SimSession } from "../../../src/gateway/sim/engine";
import * as Sessions from "../../../src/db/sessions";
import * as OneOnOne from "../../../src/db/one-on-one";

// End-to-end: prove /1on1 actually strips the agent's credentials from a
// whitelisted `.mcp.json` server in the resolved mount map — the overlay the
// private-services finding left unverified. Drives the real gateway resolver
// via the __resolveMcp seam.
const MCP_PATH = join(paths.home, ".mcp.json");
let s: SimSession | undefined;
// The lock table is shared across sim test files in one process — start clean so a
// stale lock from another file can't pre-strip creds (or mask a missing strip).
beforeEach(() => OneOnOne._wipeForTests());
afterEach(async () => { await s?.dispose(); s = undefined; try { rmSync(MCP_PATH, { force: true }); } catch {} });

function writeMcp() {
  writeFileSync(
    MCP_PATH,
    JSON.stringify({
      mcpServers: { demo: { command: "demo-server", args: [], env: { SECRET: "agent-token" } } },
      privateServices: ["demo"],
    }),
    "utf8",
  );
}

describe("/1on1 clears credentials of whitelisted .mcp.json services in the resolved mount", () => {
  it("strips env when locked, keeps agent creds when unlocked", async () => {
    writeMcp(); // must exist before createGateway (loadExternalMcp runs once at boot)
    s = await SimSession.create({ agent: "stub", layer: "trusted", as: "member" });
    s.thread = "T1"; // pin so the lock and the session share one thread_ts

    await s.send({ text: "hello" }); // engage thread T1 → creates session + route, runs resolver
    const row = Sessions.findByThread({ team_id: "T0SIM", channel_id: "C0TEAM", thread_ts: "T1" });
    expect(row).toBeTruthy();
    const sid = row!.id;

    // Unlocked: agent identity intact.
    const before = s.handle.__resolveMcp(sid)!;
    expect((before.demo as any).env).toEqual({ SECRET: "agent-token" });

    await s.send({ text: "/1on1" }); // lock thread T1

    // Locked: whitelisted server mounts anonymous (env emptied).
    const after = s.handle.__resolveMcp(sid)!;
    expect((after.demo as any).env).toEqual({});
    expect((after.demo as any).command).toBe("demo-server"); // still launches, just credless

    await s.send({ as: "U0MGR", text: "/1on1 off", thread: "T1" }); // release
    const restored = s.handle.__resolveMcp(sid)!;
    expect((restored.demo as any).env).toEqual({ SECRET: "agent-token" });
  });

  it("does NOT clear when the lock and the chat land on different threads (unpinned)", async () => {
    writeMcp();
    s = await SimSession.create({ agent: "stub", layer: "trusted", as: "member" });
    // No s.thread pin: each send gets its own thread_ts → its own session.
    await s.send({ text: "/1on1", thread: "TA" }); // lock thread TA
    await s.send({ text: "hello", thread: "TB" }); // chat lands on thread TB

    const rowB = Sessions.findByThread({ team_id: "T0SIM", channel_id: "C0TEAM", thread_ts: "TB" });
    const after = s.handle.__resolveMcp(rowB!.id)!;
    // TB has no lock → agent creds NOT stripped. This is the reported symptom:
    // the lock is keyed to a thread the chat session never shares.
    expect((after.demo as any).env).toEqual({ SECRET: "agent-token" });
  });
});
