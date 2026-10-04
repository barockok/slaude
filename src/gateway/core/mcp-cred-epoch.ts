/**
 * MCP credential epochs (review F2 on the MCP bridge).
 *
 * A node fetches a bridged server's tool list once, when the session's agent
 * process starts (WS-C §4.2.5). A server that needed connecting at that moment
 * is mounted with no tools, and connecting it later changes nothing on that
 * warm session. So each connect or disconnect bumps a counter for the identity
 * it concerns, and dispatch mixes the counters of the turn's identities into
 * the signed session-config fingerprint: the next turn's fingerprint differs,
 * the node reboots the session, and the reboot re-lists.
 *
 * Keys are what dispatch already holds, so reading costs one Redis MGET per
 * message and no database query:
 *   the agent    (tenant, persona)
 *   a person     (Slack team, Slack user id): an account's connect bumps
 *                every Slack identity bound to it (looked up at connect time)
 *
 * A missing key is 0, and an all-zero epoch leaves the fingerprint exactly as
 * it was before epochs existed, so an upgrade reboots no session.
 */
import type { Redis } from "ioredis";
import type { CredentialOwner } from "../../agent/credential-owner";
import { slackIdentitiesForAccount } from "../../db/accounts";
import { env } from "../../config/env";
import { getRedis } from "../../queue/redis";
import { redisPrefix } from "../../queue/keys";

export type EpochOwner =
  | { kind: "agent"; tenant: string; persona: string }
  | { kind: "user"; team: string; slackUserId: string };

export interface McpCredEpochs {
  bump(owners: EpochOwner[]): Promise<void>;
  /** The counters, in order; a missing one is 0. */
  read(owners: EpochOwner[]): Promise<number[]>;
}

const keyOf = (o: EpochOwner): string =>
  JSON.stringify(o.kind === "agent" ? ["agent", o.tenant, o.persona || "default"] : ["user", o.team, o.slackUserId]);

export function localEpochs(): McpCredEpochs {
  const m = new Map<string, number>();
  return {
    async bump(owners) {
      for (const o of owners) m.set(keyOf(o), (m.get(keyOf(o)) ?? 0) + 1);
    },
    async read(owners) {
      return owners.map((o) => m.get(keyOf(o)) ?? 0);
    },
  };
}

/** Shared by every gateway replica. */
export function redisEpochs(redis: Redis, prefix: string): McpCredEpochs {
  const k = (o: EpochOwner) => `${prefix}:mcpcred-epoch:${keyOf(o)}`;
  return {
    async bump(owners) {
      if (!owners.length) return;
      const tx = redis.multi();
      for (const o of owners) tx.incr(k(o));
      await tx.exec();
    },
    async read(owners) {
      if (!owners.length) return [];
      const vals = await redis.mget(...owners.map(k));
      return vals.map((v) => {
        const n = Number(v);
        return Number.isSafeInteger(n) && n > 0 ? n : 0;
      });
    },
  };
}

let shared: McpCredEpochs | undefined;
/** Redis in the gateway role (every replica sees every bump), else in-process. */
export function defaultEpochs(): McpCredEpochs {
  return (shared ??= env.role() === "gateway" ? redisEpochs(getRedis(), redisPrefix()) : localEpochs());
}
/** TEST SEAM. */
export function __setDefaultEpochs(e: McpCredEpochs | undefined): void {
  shared = e;
}

/** The epoch owners a credential owner maps to: the agent itself, or every
 *  Slack identity bound to the account. */
export async function epochOwnersFor(owner: CredentialOwner): Promise<EpochOwner[]> {
  if (owner.kind === "agent") return [{ kind: "agent", tenant: owner.tenant, persona: owner.persona }];
  const ids = await slackIdentitiesForAccount(owner.accountId);
  return ids.map((i) => ({ kind: "user" as const, team: i.team_id, slackUserId: i.slack_user_id }));
}

/** Bump after a credential was stored or removed. Never fails the caller: a
 *  missed bump only delays the re-list to the session's next restart. */
export async function bumpMcpCredEpoch(owners: EpochOwner[] | CredentialOwner, epochs: McpCredEpochs = defaultEpochs()): Promise<void> {
  try {
    const list = Array.isArray(owners) ? owners : await epochOwnersFor(owners);
    await epochs.bump(list);
  } catch (e) {
    console.warn(`[mcp-cred-epoch] bump failed: ${e instanceof Error ? e.name : typeof e}`);
  }
}

/** The fingerprint input for a turn: the agent's and (when it runs as a
 *  person) that person's counters. "" when both are 0. */
export async function turnMcpEpoch(
  a: { tenant: string; persona: string; team: string; runAsUser: string | null | undefined },
  epochs: McpCredEpochs = defaultEpochs(),
): Promise<string> {
  const owners: EpochOwner[] = [{ kind: "agent", tenant: a.tenant, persona: a.persona }];
  if (a.runAsUser) owners.push({ kind: "user", team: a.team, slackUserId: a.runAsUser });
  let vals: number[];
  try {
    vals = await epochs.read(owners);
  } catch (e) {
    // A dispatch never fails on this: at worst one spurious session reboot.
    console.warn(`[mcp-cred-epoch] read failed: ${e instanceof Error ? e.name : typeof e}`);
    return "";
  }
  return vals.some((v) => v > 0) ? vals.join(":") : "";
}
