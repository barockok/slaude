// Pure helpers behind e2e/ha/driver.ts, kept apart so they are unit tested without a cluster
// (driver.ts spawns kubectl and is imported only by *.e2e.ts files).
import { createHash, randomBytes } from "node:crypto";
import type { CallRecord } from "../fake-slack/core/call-log";

/** Where the seed script lands inside the gateway pod. */
export const SEED_REMOTE_PATH = "/tmp/seed-persona.ts";
/** seed-persona.ts imports ./soul-guard.ts, so the guard lands next to it. */
export const SOUL_GUARD_REMOTE_PATH = "/tmp/soul-guard.ts";

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

export interface RegisteredApp {
  apiAppId: string;
  teamId: string;
  personaId: string;
  botUserId: string;
}

/** Rows of `slack-app list` output (`A…/T…  tenant=… persona=… bot_user=… updated=…`). */
export function parseRegisteredApps(listOutput: string): RegisteredApp[] {
  const out: RegisteredApp[] = [];
  for (const line of listOutput.split("\n")) {
    const m = /^(\S+)\/(\S+)\s.*\bpersona=(\S+)\s+bot_user=(\S+)/.exec(line.trim());
    if (m) out.push({ apiAppId: m[1]!, teamId: m[2]!, personaId: m[3]!, botUserId: m[4]! });
  }
  return out;
}

/**
 * Fixed credentials for a registered app the suite did not create (for example one an earlier
 * task left). The gateway posts outbound through its primary (oldest) app, so every app in the
 * registry must exist in the fake with the registry's credentials; after a fake restart the
 * suite re-keys such apps to these values in both places. The bot user id is derived from the
 * app id so it cannot collide with a persona app's `U0B<PERSONA>`.
 */
export function adoptedCredentials(apiAppId: string): AppCredentials {
  const base = stableCredentials(apiAppId, "x");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = createHash("sha256").update(`slaude-e2e:bot-user:${apiAppId}`).digest();
  let id = "";
  for (let i = 0; i < 5; i++) id += alphabet[bytes[i]! % 32];
  return { ...base, botUserId: `U0B${id}0` };
}

/** Registered apps in the fake's team, other than the suite's own app: these get adopted. */
export function appsToAdopt(rows: RegisteredApp[], suiteAppId: string, teamId: string): RegisteredApp[] {
  return rows.filter((r) => r.teamId === teamId && r.apiAppId !== suiteAppId);
}

/** `slack-app add` for an adopted app, run in a gateway pod; the secrets travel as argv only. */
export function slackAppAddCommand(app: RegisteredApp, creds: AppCredentials): string[] {
  return [
    "sh", "-c", 'cd /app && exec bun src/cli/slack-app.ts "$@"', "slack-app",
    "add",
    "--api-app-id", app.apiAppId,
    "--team-id", app.teamId,
    "--bot-token", creds.botToken,
    "--signing-secret", creds.signingSecret,
    "--bot-user-id", creds.botUserId,
    "--persona", app.personaId,
  ];
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

/** Messages by one of the given bot users that carry the persona label `[<persona>]`. */
export function personaReplies<M extends { user: string; text: string }>(messages: M[], botUserIds: string | string[], persona: string): M[] {
  const bots = new Set(typeof botUserIds === "string" ? [botUserIds] : botUserIds);
  return messages.filter((m) => bots.has(m.user) && m.text.includes(`[${persona}]`));
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
  seq: number;
  ts: number;
  method: string;
  path: string;
  retryCount: number;
  tag: string | null;
  tagParams: Record<string, string> | null;
  action: string;
  messages: number;
  historyHash: string;
  persona: string | null;
  offersReply: boolean;
}

/** The mock journal's highest sequence number: a mark taken from the mock itself, no clocks. */
export function lastJournalSeq(rows: MockJournalRow[]): number {
  return rows.reduce((n, r) => Math.max(n, r.seq), 0);
}

/** One case's rows after a mark: tag `name` with `case=<caseId>`, in sequence order. */
export function caseJournalRows(rows: MockJournalRow[], mark: number, name: string, caseId: string): MockJournalRow[] {
  return rows
    .filter((r) => r.seq > mark && r.tag === name && r.tagParams?.case === caseId)
    .sort((a, b) => a.seq - b.seq);
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
 * The in-pod shell command whose `sha256sum` output feeds bootFingerprint: SOUL.md and every soul
 * cache entry, from the directory extraction reads. That is SLAUDE_SOUL_CACHE_DIR when set, else
 * $SLAUDE_HOME/cache, as cacheDir() in src/soul/extract.ts decides; run in the gateway container,
 * the variables are that container's. Missing files are not an error.
 */
export const STARTUP_FILES_SCRIPT =
  'sha256sum "$SLAUDE_HOME"/SOUL.md "${SLAUDE_SOUL_CACHE_DIR:-$SLAUDE_HOME/cache}"/soul.*.json 2>/dev/null || true';

/**
 * One digest of everything the slaude pods read only at startup: SOUL.md and the soul cache
 * (from `sha256sum` output, keyed by file name), the registered-app set, and the data of the
 * ConfigMap their env comes from (`kubectl get configmap -o json`; env is read at pod start).
 */
export function bootFingerprint(
  sha256sumOutput: string,
  appListOutput: string,
  configMapJson = "{}",
  opts: { requireSoul?: boolean } = {},
): string {
  const files = sha256sumOutput
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2 && /^[0-9a-f]{64}$/.test(p[0]!))
    .map(([sum, path]) => `${path!.slice(path!.lastIndexOf("/") + 1)} ${sum}`)
    .sort();
  // Before the first seed SOUL.md may not exist yet (a gateway that has not booted far enough to
  // write its starter): that is a defined state, not an error. After the seed it must exist.
  if (!files.some((f) => f.startsWith("SOUL.md "))) {
    if (opts.requireSoul !== false) throw new Error("no SOUL.md checksum in the fingerprint input");
    files.push("SOUL.md absent");
  }
  const canon = [...files, "--", ...registeredApps(appListOutput), "--", ...configEntries(configMapJson)].join("\n");
  return createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/** `key=value` lines of a ConfigMap's data, sorted (metadata such as resourceVersion is ignored). */
export function configEntries(configMapJson: string): string[] {
  const data = ((JSON.parse(configMapJson) as { data?: Record<string, string> }).data ?? {}) as Record<string, string>;
  return Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k]}`);
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
    return { restart: true, reason: "the pods booted before the current soul, registered apps or env ConfigMap (no matching boot fingerprint)" };
  }
  return { restart: false, reason: "nothing the pods read at startup changed since they booted" };
}
