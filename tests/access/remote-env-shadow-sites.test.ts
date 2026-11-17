/**
 * Slice C task 17: 1on1, remote and env owner compares go through the shadow
 * seam and keep the legacy outcome under every source mode and a broken
 * resolver or engine. oauth-home keeps its Slack-id storage key and has no
 * owner comparison to move (it is told the lock owner by its caller).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { settleShadows } from "../../src/access/wired";
import * as CronJobs from "../../src/db/cron-jobs";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as Envs from "../../src/db/environments";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Remote from "../../src/db/remote";
import { db } from "../../src/db/schema";
import { handleEnvCommand, useEnvironment, type EnvCommandDeps } from "../../src/gateway/core/env-command";
import { handleRemoteCommand } from "../../src/gateway/core/remote-command";
import { threadIdentity } from "../../src/gateway/core/thread-identity";
import { activeRemoteTarget } from "../../src/remote/active";
import { compared, decisions, sameAsLegacyBaseline, useShadowEnv } from "../helpers/shadow-modes";

const TEAM = "T0EXAMPLE";
let log: string[];
const ctx = (userId: string, o: { isManager?: boolean; threadTs?: string; offer?: boolean } = {}) => ({
  teamId: TEAM, channelId: "C0EXAMPLE", threadTs: o.threadTs ?? "1.0", userId, sessionId: "S1", isManager: o.isManager ?? false,
  reply: async (t: string) => void log.push(`reply:${t}`),
  sayPrivately: async (t: string) => void log.push(`private:${t}`),
  reload: () => {},
  reloadThread: async () => {},
  ...(o.offer ? { offerConnect: async () => void log.push("offer") } : {}),
});
const deps: EnvCommandDeps = {
  preflight: async (i: any) => ({ ok: true, dir: `/abs${String(i.dir).replace(/^~/, "/home/a")}` }),
  cleanup: async () => {},
  status: async () => "reachable",
  provision: async () => {},
  generateKeyPair: (c: string) => ({ privateKey: `PRIV-${c}`, publicKey: `ssh-ed25519 AAAA ${c}` }),
  validKey: () => true,
  listForeignThreadCrons: CronJobs.countForeignThreadJobs,
} as never;

useShadowEnv({
  before: async () => {
    process.env.SLAUDE_REMOTE = "1";
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
    process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK = "1";
    __resetMasterKeyCache();
    log = [];
    await OneOnOne._wipeForTests();
    await Remote._wipeForTests();
    await db.run("DELETE FROM cron_jobs");
  },
  after: () => {
    delete process.env.SLAUDE_REMOTE;
    delete process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK;
  },
});

async function reset(): Promise<void> {
  log = [];
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
  await db.run("DELETE FROM cron_jobs");
  await db.run("DELETE FROM thread_environments").catch(() => {});
}

/** Everything the group decides, as a transcript. */
async function scenario(): Promise<unknown> {
  await reset();
  const out: Record<string, unknown> = {};
  const note = (k: string) => (out[k] = log.splice(0));
  await Remote.putKeyIfAbsent(TEAM, "U0OWNER", { privateKey: "PRIV", publicKey: "PUB" });

  // remote/active.ts and thread identity: a user-machine target needs its owner's lock.
  await Remote.setTarget({ channelId: "C0EXAMPLE", threadTs: "9.0", teamId: TEAM, userId: "U0OWNER", addr: "tcA", dir: "/r", lockByRemote: true });
  await OneOnOne.lock({ channelId: "C0EXAMPLE", threadTs: "9.0", lockedUser: "U0MGR", createdBy: "U0MGR", teamId: TEAM });
  out.activeOtherLock = (await activeRemoteTarget("C0EXAMPLE", "9.0")) === null;
  await OneOnOne.lock({ channelId: "C0EXAMPLE", threadTs: "9.0", lockedUser: "U0OWNER", createdBy: "U0OWNER", teamId: TEAM });
  out.activeOwnLock = (await activeRemoteTarget("C0EXAMPLE", "9.0")) !== null;
  out.identityOwner = !!(await threadIdentity("C0EXAMPLE", "9.0", async () => "U0OWNER")).remote;
  out.identityOther = !!(await threadIdentity("C0EXAMPLE", "9.0", async () => "U0OTHER")).remote;

  // /remote status off: the connect form is offered to the lock owner or when unlocked.
  await handleRemoteCommand({ kind: "remote", action: "status" } as never, ctx("U0OWNER", { threadTs: "5.0", offer: true }) as never, deps);
  await OneOnOne.lock({ channelId: "C0EXAMPLE", threadTs: "5.0", lockedUser: "U0OWNER", createdBy: "U0OWNER", teamId: TEAM });
  await handleRemoteCommand({ kind: "remote", action: "status" } as never, ctx("U0OWNER", { threadTs: "5.0", offer: true }) as never, deps);
  await handleRemoteCommand({ kind: "remote", action: "status" } as never, ctx("U0OTHER", { threadTs: "5.0", offer: true }) as never, deps);
  note("offer");

  // /env use: another person's environment, a lock held by someone else, then the owner's own.
  const mine = await Envs.createEnv({ teamId: TEAM, userId: "U0OWNER", name: "lap", kind: "tailcat", config: { addr: "tcA" }, defaultDir: "/r" });
  await useEnvironment(mine, undefined, ctx("U0OTHER", { threadTs: "2.0" }) as never, deps);
  await OneOnOne.lock({ channelId: "C0EXAMPLE", threadTs: "3.0", lockedUser: "U0OTHER", createdBy: "U0OTHER", teamId: TEAM });
  await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx("U0OWNER", { threadTs: "3.0" }) as never, deps);
  await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
  await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
  await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcA", dir: "/r" } as never, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
  note("use");

  // /env off: a guest is refused, the owner and a manager are not; /env rm.
  await handleEnvCommand({ kind: "env", action: "off" }, ctx("U0GUEST", { threadTs: "1.0" }) as never, deps);
  await handleEnvCommand({ kind: "env", action: "off" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
  await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
  await handleEnvCommand({ kind: "env", action: "off" }, ctx("U0MGR", { threadTs: "1.0", isManager: true }) as never, deps);
  await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
  await handleEnvCommand({ kind: "env", action: "rm", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
  note("off");
  out.leftoverLocks = [await OneOnOne.find("C0EXAMPLE", "1.0")].map((l) => l?.locked_user ?? null);
  return out;
}

describe("remote and env owner compares", () => {
  sameAsLegacyBaseline("the whole group", scenario, (b: any) => {
    expect(b.activeOtherLock).toBe(true);
    expect(b.activeOwnLock).toBe(true);
    expect(b.identityOwner).toBe(true);
    expect(b.identityOther).toBe(false);
    expect(b.offer.filter((l: string) => l === "offer")).toHaveLength(2);
    expect(b.use.join("\n")).toContain("only use your own environments");
    expect(b.use.join("\n")).toContain("only its owner");
    expect(b.off.join("\n")).toContain("Only <@U0OWNER>");
  });

  test("every site of the group counts decisions", async () => {
    await scenario();
    await settleShadows();
    for (const site of ["remote.active_lock_owner", "remote.offer_connect_lock_owner", "remote.own_current", "remote.thread_identity_run_as", "env.own_environment", "env.use_lock_owner", "env.inherit_lock_by_env", "env.turn_off_owner", "env.release_lock_owner", "env.remove_lock_owner"]) {
      expect({ site, n: decisions(site) }).toEqual({ site, n: expect.any(Number) });
      expect(decisions(site)).toBeGreaterThan(0);
      expect(compared(site)).toBeGreaterThan(0);
    }
  });
});
