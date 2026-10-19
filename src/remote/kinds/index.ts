/**
 * Environment kind registry (spec §3.3). tailcat and ssh are built in.
 * Provisioned kinds (dind, firecracker) register here once their provisioner
 * exists (spec §7). A provisioned kind must not be registered until every node
 * runs a version that knows environments: an older node reads only the legacy
 * claim and would run an unlocked sandbox thread's tools locally.
 */
import { sshKind } from "./ssh";
import { tailcatKind } from "./tailcat";
import type { EnvironmentKind, StoredEnv } from "./types";
import type { EnvTrust } from "../types";

export type { EnvironmentKind, FieldSpec, ParseResult, ProvisionedEndpoint, StoredEnv } from "./types";

const kinds = new Map<string, EnvironmentKind>();

export function registerKind(k: EnvironmentKind): void {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(k.kind)) throw new Error(`invalid environment kind name: ${k.kind}`);
  if (k.trust === "provisioned" && (!k.provision || !k.teardown)) throw new Error(`provisioned kind ${k.kind} needs provision and teardown`);
  if (k.trust === "user-machine" && !k.transport) throw new Error(`user-machine kind ${k.kind} needs transport`);
  kinds.set(k.kind, k);
}

export function unregisterKind(kind: string): void {
  if (kind === "tailcat" || kind === "ssh") throw new Error("built-in kinds cannot be removed");
  kinds.delete(kind);
}

export function getKind(kind: string): EnvironmentKind | undefined {
  return kinds.get(kind);
}

export function listKinds(): EnvironmentKind[] {
  return [...kinds.values()];
}

/** The trust class an environment is treated with. A provisioned environment
 *  that carries secrets is treated as user-machine (spec §4): once bound to an
 *  unlocked thread anyone there could steer it, so it needs the owner's lock. */
export function trustOf(env: Pick<StoredEnv, "kind" | "secrets">): EnvTrust {
  const k = kinds.get(env.kind);
  if (!k) return "user-machine";
  if (k.trust === "provisioned" && Object.keys(env.secrets ?? {}).length > 0) return "user-machine";
  return k.trust;
}

registerKind(tailcatKind);
registerKind(sshKind);
