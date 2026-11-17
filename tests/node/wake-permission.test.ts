/**
 * The node resolver refuses every permission request during a wake before the
 * node's local policy (src/node/shims/permission.ts), as mono does: a tool in
 * the node's SLAUDE_AUTO_ALLOW_TOOLS is denied in a wake and allowed again on
 * the session's next normal turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isWakeTurn, makeNodePermissionResolver } from "../../src/node/shims/permission";
import { wakeRefusal } from "../../src/proactive/wake-guard";

const token = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const WAKE = token({ session: "S1", origin: "cron", bgRun: "run-1", wake: true });
const NORMAL = token({ session: "S1", origin: "slack" });

const saved = process.env.SLAUDE_AUTO_ALLOW_TOOLS;
beforeAll(() => {
  process.env.SLAUDE_AUTO_ALLOW_TOOLS = "Bash";
});
afterAll(() => {
  if (saved === undefined) delete process.env.SLAUDE_AUTO_ALLOW_TOOLS;
  else process.env.SLAUDE_AUTO_ALLOW_TOOLS = saved;
});

/** A client that fails the test if the resolver reaches the gateway. */
const noWire: any = {
  postTool: async () => {
    throw new Error("the gateway must not be asked");
  },
};
const ctx: any = { signal: new AbortController().signal, toolUseID: "tu-1" };

function resolverOn(bound: { token?: string; jobWake: boolean }) {
  return makeNodePermissionResolver({
    client: noWire,
    tokenFor: () => bound.token,
    wakeFor: () => isWakeTurn(bound.token, bound.jobWake),
  });
}

describe("node wake refusal", () => {
  test("an auto-allowed tool is denied during a wake, with mono's refusal, without asking the gateway", async () => {
    const r = resolverOn({ token: WAKE, jobWake: true });
    expect(await r("S1", "Bash", { command: "ls" }, ctx)).toEqual({ behavior: "deny", message: wakeRefusal("Bash") });
  });

  test("the next normal turn on the same session is allowed again", async () => {
    const bound = { token: WAKE, jobWake: true };
    const r = resolverOn(bound);
    expect((await r("S1", "Bash", { command: "ls" }, ctx)).behavior).toBe("deny");
    // The next job binds its own token (worker.ts runLockedTurn) and clears the job flag.
    bound.token = NORMAL;
    bound.jobWake = false;
    expect((await r("S1", "Bash", { command: "ls" }, ctx)).behavior).toBe("allow");
  });

  test("a normal thread keeps the node's auto-allow list", async () => {
    const r = resolverOn({ token: NORMAL, jobWake: false });
    expect((await r("S1", "Bash", { command: "ls" }, ctx)).behavior).toBe("allow");
    // Without a wakeFor (an older caller) nothing changes either.
    const plain = makeNodePermissionResolver({ client: noWire, tokenFor: () => NORMAL });
    expect((await plain("S1", "Bash", { command: "ls" }, ctx)).behavior).toBe("allow");
  });

  test("either the signed claim or the job's flag makes it a wake", () => {
    expect(isWakeTurn(WAKE, false)).toBe(true);
    expect(isWakeTurn(WAKE, true)).toBe(true);
    expect(isWakeTurn(NORMAL, true)).toBe(true);
    expect(isWakeTurn(NORMAL, false)).toBe(false);
    expect(isWakeTurn(undefined, true)).toBe(true);
    expect(isWakeTurn("not-a-jwt", true)).toBe(true);
    expect(isWakeTurn(undefined, false)).toBe(false);
  });
});
