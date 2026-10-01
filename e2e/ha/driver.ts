// Setup shared by every cluster case (the baseline and the follow-up HA scenarios).
//
// Spawns kubectl, so only *.e2e.ts files import it; the pure parts live in ./suite-logic.ts.
// Targets the slaude-e2e profile and the slaude-scale namespace through e2e/harness/kube.ts.
//
// setupSuite() is idempotent: it (re)creates the app in the fake and re-seeds the persona with the
// same credentials every time, whatever an earlier run left behind. The credentials are derived
// from the app id (stableCredentials), because a live gateway loads the slack_apps registry once
// and would keep the OLD signing secret if a re-run registered fresh ones. Bot tokens and signing
// secrets are never printed.
//
// Gateways and nodes memoize the structured soul at boot, and a gateway loads the registered apps
// once. Seeding writes files and rows but cannot reach a running process, so setupSuite takes a
// fingerprint of that state before and after the seed and restarts gateway and node when the seed
// changed it or when the pods booted with some other state (recorded as BOOT_ANNOTATION on each
// Deployment after a harness restart). When nothing changed, nothing restarts.
import { join } from "node:path";
import { createControlClient } from "../fake-slack/control-client";
import { until } from "../fake-slack/util";
import { copyTo, execIn, kubectl, podIps, podNames, portForward } from "../harness/kube";
import {
  adoptedCredentials,
  appsToAdopt,
  parseRegisteredApps,
  slackAppAddCommand,
  BOOT_ANNOTATION,
  bootAnnotations,
  bootFingerprint,
  dmChannelId,
  maskSecrets,
  podUrls,
  restartDecision,
  seedCommand,
  SEED_REMOTE_PATH,
  SOUL_GUARD_REMOTE_PATH,
  stableCredentials,
  STARTUP_FILES_SCRIPT,
} from "./suite-logic";

export type ControlClient = ReturnType<typeof createControlClient>;

export interface SuiteApp {
  apiAppId: string;
  botUserId: string;
  personaId: string;
  teamId: string;
}

export interface Suite {
  fake: ControlClient;
  /** In-cluster URL the fake delivers events to (the Service; round-robins over the replicas). */
  gatewayUrl: string;
  /** Direct gateway pod URLs, for replica-targeted delivery. Re-read on every call: pod IPs change when a gateway is killed or restarted. */
  gatewayPodUrls(): Promise<string[]>;
  app: SuiteApp;
  /** The human who DMs the agent: the soul fixture's manager, so a DM from them engages. */
  manager: string;
  /** A fresh DM channel between the manager and the bot, unique per call. */
  newChannel(): Promise<string>;
  teardown(): Promise<void>;
}

export interface SuiteOptions {
  personaId?: string;
  apiAppId?: string;
}

// The fake's workspace team id (its default; the control API does not return it).
const TEAM_ID = ["T0", "FAKE"].join("");
// Users from the sim soul fixture (src/gateway/sim/soul-fixture.ts WORLD).
const MANAGER = ["U0", "MGR"].join("");
const USERS: Array<[string, string]> = [
  [MANAGER, "manager"],
  [["U0", "APP"].join(""), "approver"],
];

const SEED_SOURCE = join(import.meta.dir, "..", "harness", "in-pod", "seed-persona.ts");
const SOUL_GUARD_SOURCE = join(import.meta.dir, "..", "harness", "in-pod", "soul-guard.ts");

export async function setupSuite(opts: SuiteOptions = {}): Promise<Suite> {
  const personaId = opts.personaId ?? "alpha";
  const apiAppId = opts.apiAppId ?? ["A0", "E2E", personaId.toUpperCase()].join("");
  const pf = await portForward("svc/fake-slack", 8080);
  try {
    const fake = createControlClient(`http://127.0.0.1:${pf.localPort}`);
    for (const [id, name] of USERS) await fake.addUser({ id, name });
    const created = await fake.addApp({ apiAppId, name: `e2e-${personaId}`, ...stableCredentials(apiAppId, personaId) });
    const secrets = [created.botToken, created.signingSecret];

    const gateways = await podNames("gateway");
    if (gateways.length === 0) throw new Error("no running gateway pod to seed the persona from");
    const seedPod = gateways[0]!;
    const before = await fingerprintIn(seedPod, false);
    await copyTo(seedPod, "gateway", SOUL_GUARD_SOURCE, SOUL_GUARD_REMOTE_PATH);
    await copyTo(seedPod, "gateway", SEED_SOURCE, SEED_REMOTE_PATH);
    const seeded = await execIn(
      seedPod,
      "gateway",
      seedCommand({
        personaId,
        apiAppId: created.apiAppId,
        teamId: TEAM_ID,
        botToken: created.botToken,
        signingSecret: created.signingSecret,
        botUserId: created.botUserId,
      }),
      { timeoutMs: 120_000 },
    );
    if (seeded.code !== 0) {
      throw new Error(`persona seed failed (exit ${seeded.code}): ${maskSecrets(seeded.stdout + seeded.stderr, secrets).trim()}`);
    }
    console.log(`[e2e] seeded persona ${personaId}: app ${created.apiAppId} team ${TEAM_ID} bot ${created.botUserId} (via ${seedPod})`);

    await adoptOtherApps(fake, seedPod, created.apiAppId);

    const after = await fingerprintIn(seedPod);
    const decision = restartDecision({ before, after, booted: await bootedFingerprints() });
    console.log(`[e2e] restart ${decision.restart ? "needed" : "not needed"}: ${decision.reason}`);
    if (decision.restart) await restartSlaude(after);

    const app: SuiteApp = { apiAppId: created.apiAppId, botUserId: created.botUserId, personaId, teamId: TEAM_ID };
    return {
      fake,
      gatewayUrl: "http://slaude-gateway:8080",
      gatewayPodUrls: async () => podUrls(await podIps("gateway")),
      app,
      manager: MANAGER,
      async newChannel() {
        const id = dmChannelId();
        await fake.addChannel({ id, name: `dm-${id.toLowerCase()}`, isIm: true, members: [MANAGER, app.botUserId] });
        return id;
      },
      async teardown() {
        pf.stop();
      },
    };
  } catch (e) {
    pf.stop();
    throw e;
  }
}

const DEPLOYMENTS = ["slaude-gateway", "slaude-node"];
// Both Deployments take their env from this ConfigMap (envFrom), read at pod start.
const ENV_CONFIGMAP = "slaude-scale-config";

async function must(what: string, r: Promise<{ stdout: string; stderr: string; code: number }>): Promise<string> {
  const got = await r;
  if (got.code !== 0) throw new Error(`${what} failed (exit ${got.code}): ${got.stderr.trim()}`);
  return got.stdout;
}

/** Fingerprint of the startup-only state (SOUL.md, soul cache, registered apps), read in a gateway pod. */
async function fingerprintIn(pod: string, requireSoul = true): Promise<string> {
  const sums = await must(
    "checksumming the soul",
    execIn(pod, "gateway", ["sh", "-c", STARTUP_FILES_SCRIPT]),
  );
  const apps = await must("slack-app list", execIn(pod, "gateway", ["sh", "-c", "cd /app && bun run slack-app list"], { timeoutMs: 60_000 }));
  const config = await must("reading the env ConfigMap", kubectl(["get", "configmap", ENV_CONFIGMAP, "-o", "json"]));
  return bootFingerprint(sums, apps, config, { requireSoul });
}

/**
 * Re-key every other registered app in the fake's team to fixed credentials, in the fake and in
 * the registry (an upsert; no row is removed). The gateway sends outbound calls through its
 * primary (oldest) app, so an app the fake does not know, for example after the fake restarted
 * and lost its in-memory apps, turns every reply into invalid_auth.
 */
async function adoptOtherApps(fake: ControlClient, pod: string, suiteAppId: string): Promise<void> {
  const list = await must("slack-app list", execIn(pod, "gateway", ["sh", "-c", "cd /app && bun run slack-app list"], { timeoutMs: 60_000 }));
  for (const row of appsToAdopt(parseRegisteredApps(list), suiteAppId, TEAM_ID)) {
    const creds = adoptedCredentials(row.apiAppId);
    await fake.addApp({ apiAppId: row.apiAppId, name: `e2e-adopted-${row.apiAppId.toLowerCase()}`, ...creds });
    const r = await execIn(pod, "gateway", slackAppAddCommand(row, creds), { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`re-keying ${row.apiAppId} failed (exit ${r.code}): ${maskSecrets(r.stdout + r.stderr, [creds.botToken, creds.signingSecret]).trim()}`);
    console.log(`[e2e] adopted registered app ${row.apiAppId} (persona ${row.personaId}, bot ${creds.botUserId}) into the fake`);
  }
}

async function bootedFingerprints(): Promise<string[]> {
  return bootAnnotations(await must("reading the boot fingerprints", kubectl(["get", "deploy", ...DEPLOYMENTS, "-o", "json"])), DEPLOYMENTS);
}

/**
 * Restart gateway and node, wait for both rollouts and then every gateway pod's /healthz, and
 * record the fingerprint they booted with. Prints how long it took (cases that restart budget for it).
 */
async function restartSlaude(fingerprint: string): Promise<void> {
  const t0 = Date.now();
  await must("rollout restart", kubectl(["rollout", "restart", ...DEPLOYMENTS.map((d) => `deploy/${d}`)]));
  for (const d of DEPLOYMENTS) {
    await must(`rollout status ${d}`, kubectl(["rollout", "status", `deploy/${d}`, "--timeout=300s"], { timeoutMs: 320_000 }));
  }
  for (const pod of await podNames("gateway")) {
    const pf = await portForward(`pod/${pod}`, 8080);
    try {
      await until(() => fetch(`http://127.0.0.1:${pf.localPort}/healthz`).then((r) => r.ok, () => false), {
        timeoutMs: 60_000,
        intervalMs: 500,
        what: `gateway ${pod} /healthz after its rollout`,
      });
    } finally {
      pf.stop();
    }
  }
  await must("recording the boot fingerprint", kubectl(["annotate", "deploy", ...DEPLOYMENTS, `${BOOT_ANNOTATION}=${fingerprint}`, "--overwrite"]));
  console.log(`[e2e] restarted ${DEPLOYMENTS.join(" and ")} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
