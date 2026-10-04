/**
 * Scenario (node labels spec §4.6, §4.8): relabel end to end through a gateway
 * replica, the /v1 gate and two label worker sets, real Redis, gated.
 *
 *   scen-rl-eng  signed credential {engineering}
 *   scen-rl-fin  signed credential {finance}
 *
 * The default persona runs on engineering and its session is warm on
 * scen-rl-eng, which is mid-turn when the persona is relabelled to finance
 * and the old node is re-credentialed without the label (the operator moved
 * the agent off it). Then:
 *
 *   - a new message goes to the finance queue: warm routing ignores the old
 *     node, which lacks the new label;
 *   - a message coalesced into a pending job while the turn was in flight is
 *     moved, never stranded on the old node;
 *   - the in-flight turn's next call is refused by the gate (403), the turn
 *     ends with LABEL_MISMATCH instead of done, and the gateway re-dispatches
 *     it once to finance, posting nothing;
 *   - every message runs exactly once, on the finance node, and the user never
 *     sees the LABEL_MISMATCH text.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  realEnabled,
  until,
  cleanupPrefix,
  setupScenarioEnv,
  teardownScenarioEnv,
  bootReplica,
  bootNode,
  dm,
  replies,
  REAL_URL,
  NODE_TOKEN,
  testPrefix,
  type Replica,
} from "./harness";

const d = describe.skipIf(!realEnabled);

const CH = "D0RELABEL";
const T1 = "8700.1";
const NODE_KEY = "relabel-scenario-node-key-0123456789abcdef";

let redis: any;
let keys: any;
let registry: any;
let gw: Replica;
let eng: { agent: any; worker: any };
let fin: { agent: any; worker: any };
let sessions: any;
let failureText: (c: string) => string = () => "";
let setRegistry: (r: any) => void = () => {};
let resetRegistry: () => void = () => {};
/** Flips the engineering node's bearer to a credential without the label. */
let engCredentialSwapped = false;

const managedDefault = (label: string | null) => ({
  lookupByUserId: () => null,
  lookupByName: () => null,
  list: () => [],
  isMultiPersonaMode: () => false,
  isManaged: () => true,
  tombstonedPersonaFor: () => null,
  defaultPersona: () => ({ model: null, mcp: null, runsOn: label }),
});

/** What the finance node ran, one entry per turn. */
const finTurns: string[] = [];

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  process.env.SLAUDE_NODE_KEY = NODE_KEY;
  process.env.SLAUDE_NODE_LEGACY_TOKEN = NODE_TOKEN;
  const { makeKeys } = await import("../../src/queue/keys");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { mintNodeCredential } = await import("../../src/gateway/auth/node-credential");
  const { NodeClient } = await import("../../src/node/client");
  const reg = await import("../../src/persona/registry");
  failureText = (await import("../../src/gateway/core/failure-codes")).failureText;
  const { Redis } = await import("ioredis");
  sessions = await import("../../src/db/sessions");
  setRegistry = reg.setPersonaRegistry as any;
  resetRegistry = reg.__resetPersonaRegistry;

  keys = makeKeys(testPrefix("relabel"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  registry = makeRegistry({ redis, keys, heartbeatSec: 1 });
  gw = await bootReplica(keys);
  const credEng = mintNodeCredential({ id: "scen-rl-eng", labels: ["engineering"] }, { key: NODE_KEY });
  const credEngNoLabel = mintNodeCredential({ id: "scen-rl-eng", labels: ["default"] }, { key: NODE_KEY });
  const credFin = mintNodeCredential({ id: "scen-rl-fin", labels: ["finance"] }, { key: NODE_KEY });
  const swappable = (async (url: string, init: RequestInit) => {
    if (engCredentialSwapped) init = { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${credEngNoLabel}` } };
    return fetch(url, init);
  }) as unknown as typeof fetch;
  eng = await bootNode(keys, gw.url, {
    nodeId: "scen-rl-eng",
    worker: { labels: ["engineering"], client: new NodeClient({ baseUrl: gw.url, token: credEng, baseDelayMs: 5, fetchImpl: swappable }) },
  });
  fin = await bootNode(keys, gw.url, {
    nodeId: "scen-rl-fin",
    worker: { labels: ["finance"], client: new NodeClient({ baseUrl: gw.url, token: credFin, baseDelayMs: 5 }) },
  });
  fin.agent.run = async ({ envelope, ctx }: any) => {
    finTurns.push(String(envelope));
    await ctx.surface.reply({ text: "rl-reply via=scen-rl-fin" });
  };
});

afterAll(async () => {
  if (!realEnabled) return;
  resetRegistry();
  for (const n of [eng, fin]) await n?.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  delete process.env.SLAUDE_NODE_KEY;
  delete process.env.SLAUDE_NODE_LEGACY_TOKEN;
  teardownScenarioEnv();
});

const viaOf = (text: string) => text.match(/via=(\S+)/)?.[1];

d("relabel end to end (real Redis)", () => {
  test("a relabel moves new and pending messages, and the in-flight turn is re-dispatched once", async () => {
    setRegistry(managedDefault("engineering"));
    eng.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: "rl-reply via=scen-rl-eng" });
    await gw.transport.feedMessage(dm(CH, T1, "first"));
    await until(() => replies(gw.transport, "rl-reply").length >= 1, 20_000);
    expect(viaOf(replies(gw.transport, "rl-reply")[0]!.text)).toBe("scen-rl-eng");
    const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    await until(async () => (await registry.lookup(row!.id))?.node === "scen-rl-eng", 10_000);

    // A long turn starts on the engineering node (warm-routed).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let started = false;
    eng.agent.run = async ({ ctx }: any) => {
      started = true;
      await held;
      await ctx.surface.reply({ text: "rl-reply via=scen-rl-eng" });
    };
    await gw.transport.feedMessage({ ...dm(CH, "8700.2", "second"), thread_ts: T1 });
    await until(() => started, 20_000);
    // A follow-up while it runs: pending behind the session lock.
    await gw.transport.feedMessage({ ...dm(CH, "8700.3", "third"), thread_ts: T1 });

    // Relabel: the persona moves to finance and the old node loses the label.
    setRegistry(managedDefault("finance"));
    engCredentialSwapped = true;
    await gw.transport.feedMessage({ ...dm(CH, "8700.4", "fourth"), thread_ts: T1 });

    // The in-flight turn's reply is refused by the gate: LABEL_MISMATCH.
    release();

    // Every message after the relabel runs on finance, exactly once.
    await until(() => ["second", "third", "fourth"].every((t) => finTurns.join("\n").includes(t)), 30_000);
    await new Promise((r) => setTimeout(r, 1500)); // room for a duplicate or a stray post
    for (const t of ["second", "third", "fourth"]) {
      expect(finTurns.join("\n").split(t).length - 1).toBe(1);
    }
    const all = replies(gw.transport, "rl-reply");
    expect(all.slice(1).every((r: any) => viaOf(r.text) === "scen-rl-fin")).toBe(true);
    expect(all.filter((r: any) => viaOf(r.text) === "scen-rl-eng")).toHaveLength(1); // only the first turn
    expect(all.length - 1).toBe(finTurns.length);
    // The re-dispatch posted nothing: no failure text in the thread.
    const posted = gw.transport.outbound.filter((c: any) => c.kind === "message").map((c: any) => String(c.text));
    expect(posted.some((t: string) => t === failureText("LABEL_MISMATCH"))).toBe(false);
    // The in-flight turn's job failed with the code on the old node's queue.
    const failed = await gw.qd.turns.queue("turns.scen-rl-eng").getJobs(["failed"]);
    expect(failed.map((j: any) => j.failedReason)).toContain("LABEL_MISMATCH");
  }, 90_000);
});
