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
