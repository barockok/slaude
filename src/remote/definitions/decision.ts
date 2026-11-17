/**
 * The one decision every claim point asks before a thread's turn gets a remote
 * target (or a node gets the key). It wraps `activeRemoteTarget`, which keeps
 * its signature and its personal behaviour, and adds what a SHARED environment
 * needs: the asking persona must allow it, the row must belong to the tenant
 * and not be retired, `SLAUDE_REMOTE` must be on, and the turn must be
 * interactive. A shared row that fails any of that is a REFUSAL, never "no
 * target": no target means "run on the server", which is exactly what a
 * refused thread must not do. Anything that throws is a refusal.
 */
import { env } from "../../config/env";
import { db } from "../../db/schema";
import * as Envs from "../../db/environments";
import type { StoredEnv } from "../kinds/types";
import { definitionRowId } from "./resolve";
import { activeRemoteTarget } from "../active";
import { getKind } from "../kinds";
import type { RemoteTarget } from "../types";
import { allowedEnvironments, type AllowLookup } from "./policy";

/** What started the turn, as far as shared environments care. */
export type TurnKind = "interactive" | "scheduled" | "background" | "other";

export interface Refusal {
  code: "SHARED_ENV_REFUSED" | "SHARED_ENV_NOT_INTERACTIVE" | "SHARED_ENV_REMOTE_OFF";
  message: string;
}

export type RemoteDecision = { target: RemoteTarget } | { none: true } | { refused: Refusal };

export const REFUSED_NOTICE = "This thread is set to an environment this agent may not use. `/env off` returns to the server.";
export const REFUSED_NOT_INTERACTIVE_NOTICE = "This thread is set to a shared environment, and scheduled and background turns do not run on shared environments. `/env off` returns to the server.";

/** Remote mode was switched off while the thread was still bound to a shared machine: /env is off too, so the operator unbinds. */
export const REFUSED_REMOTE_OFF_NOTICE = "This thread is bound to a shared environment, but environments are switched off on this deployment. An operator can run `slaude env unbind-shared`.";

const refuse = (message = REFUSED_NOTICE): { refused: Refusal } => ({
  refused: {
    code: message === REFUSED_NOT_INTERACTIVE_NOTICE ? "SHARED_ENV_NOT_INTERACTIVE" : message === REFUSED_REMOTE_OFF_NOTICE ? "SHARED_ENV_REMOTE_OFF" : "SHARED_ENV_REFUSED",
    message,
  },
});

/** The turn kind a dispatch (or a job token) stands for. Anything not provably interactive is not. */
export function turnKindOf(i: { origin?: unknown; wake?: unknown; backgroundRunId?: unknown }): TurnKind {
  if (i.wake) return "background";
  if (i.backgroundRunId) return "background";
  if (i.origin === "cron") return "scheduled";
  return i.origin === "slack" || i.origin === "panel" ? "interactive" : "other";
}

export interface DecisionInput {
  tenant: string;
  /** The persona whose turn this is; undefined cannot use a shared environment. */
  persona: string | undefined;
  channel: string;
  thread: string;
  turnKind: TurnKind;
}

export interface DecisionDeps {
  lookup?: typeof activeRemoteTarget;
  allowed?: AllowLookup;
  remoteEnabled?: () => boolean;
}

/** Whether a thread is bound to a definition row at all (one read, no legacy conversion, no writes). Used while remote mode is off. */
export async function sharedBindingPresent(channel: string, thread: string): Promise<boolean> {
  const r = await db.one(
    "SELECT 1 AS x FROM env_bindings b JOIN environments e ON e.id = b.env_id WHERE b.channel_id = ? AND b.thread_ts = ? AND e.source = 'definition'",
    [channel, thread],
  );
  return r !== null;
}

let testDeps: DecisionDeps = {};
/** Test seam: replace the policy lookup (or the flag) for every caller of {@link remoteDecision}. */
export function __setDecisionDepsForTests(d: DecisionDeps | null): void {
  testDeps = d ?? {};
}

export async function remoteDecision(i: DecisionInput, explicit: DecisionDeps = {}): Promise<RemoteDecision> {
  const deps = { ...testDeps, ...explicit };
  const lookup = deps.lookup ?? activeRemoteTarget;
  // A lookup that fails here throws, as it always did: callers must not default to running on the server.
  const binding = await Envs.findBinding(i.channel, i.thread);
  const row = binding ? await Envs.getEnv(binding.env_id) : null;
  // Personal rows (and no binding, and a missing row): exactly the old answer.
  if (!row || row.source !== "definition") {
    const t = await lookup(i.channel, i.thread);
    return t ? { target: t } : { none: true };
  }
  // A shared row, of a kind this process does not know too: every doubt is a refusal, never "none".
  try {
    if (!getKind(row.kind)) return refuse();
    if (row.retired) return refuse();
    if (!(deps.remoteEnabled ?? env.remote.enabled)()) return refuse(REFUSED_REMOTE_OFF_NOTICE);
    if (i.turnKind !== "interactive") return refuse(REFUSED_NOT_INTERACTIVE_NOTICE);
    if (!i.persona || row.tenantId !== i.tenant) return refuse();
    if (row.config.shared !== "true" || row.config.trust !== "unlocked") return refuse();
    const allowed = await (deps.allowed ?? allowedEnvironments)(i.tenant, i.persona);
    // A definition row's name is its definition name (the owner column holds the same text).
    if (!allowed.includes(row.name)) return refuse();
    const t = await lookup(i.channel, i.thread);
    // A bound shared row that yields no target is a refusal, never the server.
    return t ? { target: t } : refuse();
  } catch {
    return refuse();
  }
}

/**
 * The shared environment `name` as this persona may use it right now, or null.
 * Null for every reason alike (unknown, retired, another tenant, not allowed, a
 * lookup that threw), so a reply built from it cannot tell the caller which.
 */
export async function usableSharedByName(tenant: string, persona: string | undefined, name: string, explicit: DecisionDeps = {}): Promise<StoredEnv | null> {
  const deps = { ...testDeps, ...explicit };
  try {
    if (!persona || !(deps.remoteEnabled ?? env.remote.enabled)()) return null;
    const row = await Envs.getEnv(definitionRowId(tenant, name));
    if (!row || row.source !== "definition" || row.retired || row.tenantId !== tenant || row.name !== name) return null;
    if (row.config.shared !== "true" || row.config.trust !== "unlocked") return null;
    const allowed = await (deps.allowed ?? allowedEnvironments)(tenant, persona);
    return allowed.includes(name) ? row : null;
  } catch {
    return null;
  }
}

/** Every shared environment this persona may use now (for `/env list`). */
export async function usableShared(tenant: string, persona: string | undefined, explicit: DecisionDeps = {}): Promise<StoredEnv[]> {
  const deps = { ...testDeps, ...explicit };
  try {
    if (!persona) return [];
    const names = await (deps.allowed ?? allowedEnvironments)(tenant, persona);
    const rows = await Promise.all(names.map((n) => usableSharedByName(tenant, persona, n, explicit)));
    return rows.filter((r): r is StoredEnv => r !== null);
  } catch {
    return [];
  }
}
