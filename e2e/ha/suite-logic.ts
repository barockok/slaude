// Pure helpers behind e2e/ha/driver.ts, kept apart so they are unit tested without a cluster
// (driver.ts spawns kubectl and is imported only by *.e2e.ts files).
import { createHash, randomBytes } from "node:crypto";
import type { CallRecord } from "../fake-slack/core/call-log";

/** Where the seed script lands inside the gateway pod. */
export const SEED_REMOTE_PATH = "/tmp/seed-persona.ts";

/** The gateway container's HTTP port (deploy/k8s-scale/40-gateway.yaml, SLAUDE_HTTP_PORT). */
export const GATEWAY_PORT = 8080;

export interface SeedInput {
  personaId: string;
  apiAppId: string;
  teamId: string;
  botToken: string;
  signingSecret: string;
  botUserId: string;
}

/**
 * The command run in the gateway pod: the seed's guard variable is set only here, through `env`,
 * and the secrets travel as argv to the in-pod script (never through a log line).
 */
export function seedCommand(s: SeedInput, remotePath: string = SEED_REMOTE_PATH): string[] {
  for (const [k, v] of Object.entries(s)) if (!v) throw new Error(`seed input ${k} is empty`);
  return [
    "env", "SLAUDE_E2E_SEED=1", "bun", remotePath,
    "--persona-id", s.personaId,
    "--api-app-id", s.apiAppId,
    "--team-id", s.teamId,
    "--bot-token", s.botToken,
    "--signing-secret", s.signingSecret,
    "--bot-user-id", s.botUserId,
  ];
}

export interface AppCredentials {
  botUserId: string;
  botToken: string;
  signingSecret: string;
}

/**
 * Fixed fake-Slack credentials for one app id. A gateway loads the slack_apps registry once and
 * only reloads it while empty, so an app re-registered with NEW credentials keeps failing
 * signature checks on a live gateway until it restarts. Deriving the credentials from the app id
 * makes every setupSuite() hand the fake and the registry the same values. They are valid only
 * against the fake.
 */
export function stableCredentials(apiAppId: string, personaId: string): AppCredentials {
  if (!/^[a-z0-9]+$/.test(personaId)) throw new Error(`persona id '${personaId}' must be lowercase letters and digits`);
  const h = (what: string) => createHash("sha256").update(`slaude-e2e:${what}:${apiAppId}`).digest("hex");
  return {
    botUserId: `U0B${personaId.toUpperCase()}`,
    // Built from parts so no literal token shape appears in source (as the fake does).
    botToken: `${"xoxb"}-fake-${h("bot-token").slice(0, 24)}`,
    signingSecret: h("signing-secret").slice(0, 32),
  };
}

/** Replace every occurrence of each secret with `(masked)`, so seed output can be shown safely. */
export function maskSecrets(text: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((t, s) => t.split(s).join("(masked)"), text);
}

/**
 * A fresh Slack-shaped DM channel id: `D` + `0E2E` + 8 random base32 characters, so ids from
 * different cases (and runs) never collide and a case can only see its own messages.
 */
export function dmChannelId(rand: (n: number) => Buffer = randomBytes): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = rand(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i]! % 32];
  return `D0E2E${s}`;
}

/** Direct pod URLs of the gateway replicas, sorted by pod name, for replica-targeted delivery. */
export function podUrls(ips: Record<string, string>, port: number = GATEWAY_PORT): string[] {
  return Object.keys(ips)
    .sort()
    .filter((name) => ips[name])
    .map((name) => `http://${ips[name]}:${port}`);
}

/** Bot messages in a channel that carry the persona label `[<persona>]`. */
export function personaReplies<M extends { user: string; text: string }>(messages: M[], botUserId: string, persona: string): M[] {
  return messages.filter((m) => m.user === botUserId && m.text.includes(`[${persona}]`));
}

/** The highest call-log sequence number, used as a `since` mark so a case only judges its own calls. */
export function lastSeq(calls: CallRecord[]): number {
  return calls.reduce((n, c) => Math.max(n, c.seq), 0);
}

/** Calls to Slack methods the fake does not implement. */
export function unknownMethods(calls: CallRecord[]): string[] {
  return calls.filter((c) => c.unknown).map((c) => c.method);
}

export interface MockJournalRow {
  ts: number;
  method: string;
  path: string;
  retryCount: number;
  tag: string | null;
  action: string;
  messages: number;
  historyHash: string;
}

/** Mock-LLM journal rows for one scenario tag recorded at or after `sinceMs`. */
export function journalRowsFor(rows: MockJournalRow[], tag: string, sinceMs: number): MockJournalRow[] {
  return rows.filter((r) => r.tag === tag && r.ts >= sinceMs);
}

/** Deployment annotation recording the fingerprint the slaude pods last booted with. */
export const BOOT_ANNOTATION = "slaude-e2e/boot-fingerprint";

/**
 * The registered Slack apps from `slack-app list` output, as `app/team persona bot_user` lines,
 * sorted. The `updated=` stamp is dropped: every upsert bumps it, even one that changes nothing.
 * Credentials are encrypted and not listed; the bot user id stands in for them, since
 * stableCredentials derives both from the app id.
 */
export function registeredApps(listOutput: string): string[] {
  return listOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\S+\/\S+\s/.test(l) && !l.startsWith("$"))
    .map((l) => l.replace(/\s+updated=\S+/, "").replace(/\s+/g, " "))
    .sort();
}

/**
 * One digest of everything the slaude pods read only at startup: SOUL.md and the soul cache
 * (from `sha256sum` output, keyed by file name) and the registered-app set.
 */
export function bootFingerprint(sha256sumOutput: string, appListOutput: string): string {
  const files = sha256sumOutput
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2 && /^[0-9a-f]{64}$/.test(p[0]!))
    .map(([sum, path]) => `${path!.slice(path!.lastIndexOf("/") + 1)} ${sum}`)
    .sort();
  if (!files.some((f) => f.startsWith("SOUL.md "))) throw new Error("no SOUL.md checksum in the fingerprint input");
  const canon = [...files, "--", ...registeredApps(appListOutput)].join("\n");
  return createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/**
 * The BOOT_ANNOTATION value of each named Deployment from `kubectl get deploy -o json`, in the
 * order given; "" for a Deployment that is missing or has none.
 */
export function bootAnnotations(json: string, names: string[]): string[] {
  const list = JSON.parse(json) as { items?: any[] };
  const byName = new Map((list.items ?? []).map((d) => [d.metadata?.name as string, (d.metadata?.annotations?.[BOOT_ANNOTATION] ?? "") as string]));
  return names.map((n) => byName.get(n) ?? "");
}

export interface RestartInput {
  /** Fingerprint before the seed ran. */
  before: string;
  /** Fingerprint after the seed ran. */
  after: string;
  /** Fingerprint recorded on each slaude Deployment at its last restart by the harness ("" when absent). */
  booted: string[];
}

/**
 * Whether gateway and node must restart to see the seeded state. They must when the seed changed
 * something they read only at startup, and also when the pods booted with some other state (or
 * the harness never recorded one): a seed that changes nothing still leaves stale pods stale.
 */
export function restartDecision(i: RestartInput): { restart: boolean; reason: string } {
  if (i.before !== i.after) return { restart: true, reason: "the seed changed the soul or the registered apps" };
  if (i.booted.length === 0 || i.booted.some((b) => b !== i.after)) {
    return { restart: true, reason: "the pods booted before the current soul and registered apps (no matching boot fingerprint)" };
  }
  return { restart: false, reason: "nothing the pods read at startup changed since they booted" };
}
