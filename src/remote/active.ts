import { createHash } from "node:crypto";
import * as Envs from "../db/environments";
import * as OneOnOne from "../db/one-on-one";
import { getKind, trustOf, type StoredEnv } from "./kinds";
import type { RemoteTarget } from "./types";

/** Changes whenever the environment's config does (`updated_at` moves on every
 *  edit) or a sandbox is re-provisioned. Carries no config: it rides in tokens. */
export function envHash(env: Pick<StoredEnv, "id" | "kind" | "config" | "updatedAt">, generation = 0): string {
  const config = Object.fromEntries(Object.entries(env.config).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify([env.id, env.kind, config, env.updatedAt, generation])).digest("hex").slice(0, 16);
}

/** The thread's binding and environment, when both exist and the kind is known. */
export async function boundEnv(channelId: string, threadTs: string): Promise<{ binding: Envs.BindingRow; env: StoredEnv } | null> {
  const binding = await Envs.findBinding(channelId, threadTs);
  if (!binding) return null;
  const env = await Envs.getEnv(binding.env_id);
  if (!env || !getKind(env.kind)) return null;
  return { binding, env };
}

/** The thread's remote target, only while its trust class allows it (spec §4):
 *  a user-machine environment needs a LOCKED 1on1 owned by its owner; a
 *  provisioned sandbox runs in any thread it is bound to. Anything else means
 *  "run locally". */
export async function activeRemoteTarget(channelId: string, threadTs: string): Promise<RemoteTarget | null> {
  const [b, lock] = await Promise.all([boundEnv(channelId, threadTs), OneOnOne.find(channelId, threadTs)]);
  if (!b) return null;
  const { binding, env } = b;
  const trust = trustOf(env);
  if (trust === "user-machine" && (!lock || lock.open_scope !== null || lock.locked_user !== env.userId)) return null;
  const kind = getKind(env.kind)!;
  return {
    teamId: env.teamId,
    userId: env.userId,
    addr: kind.legacyAddr?.(env) ?? "",
    dir: binding.dir,
    env: { id: env.id, kind: env.kind, trust, name: env.name, hash: envHash(env, Number(binding.generation)) },
  };
}
