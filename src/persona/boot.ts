/**
 * The persona boot step of src/server.ts, separate so it can be tested.
 *
 * A node reads the filesystem registry (its personas come from the runtime
 * bundle). A gateway or mono process reads the tenant's state; a tenant never
 * synced as code reads the filesystem, a managed one the database. `mono`
 * installs no child-env resolver, so a persona with `provider` references would
 * silently run on the process's own credentials: it refuses to start (WS-A
 * §5.2). The returned function stops the registry poll (Postgres only).
 */
import { assertNoProviderRefsInMono } from "../gateway/core/provider-secrets";
import { resolveDbConfig } from "../db/client";
import { isManaged } from "../db/personas";
import { checkDiskPersonas } from "./disk-check";
import {
  loadPersonaRegistry,
  personasWithProvider,
  refreshPersonaState,
  setPersonaRegistry,
  startRegistryRevalidation,
} from "./registry";

export type PersonaBootDeps = {
  refresh: (tenant: string) => Promise<unknown>;
  withProvider: () => string[];
  startRevalidation: (tenant: string) => () => void;
  loadFilesystem: () => void;
  /** A tenant that reads the filesystem (sqlite, or Postgres never synced as code). */
  isFilesystemTenant: (tenant: string) => Promise<boolean>;
  /** Stops on a SOUL.md with no agent.yaml; seeds a starter agent.yaml into a bare home. */
  checkDisk: () => { seeded?: string };
};

const defaultDeps: PersonaBootDeps = {
  refresh: refreshPersonaState,
  withProvider: () => personasWithProvider(),
  startRevalidation: startRegistryRevalidation,
  loadFilesystem: () => setPersonaRegistry(loadPersonaRegistry()),
  isFilesystemTenant: async (tenant) => resolveDbConfig().dialect === "sqlite" || !(await isManaged(tenant)),
  checkDisk: () => checkDiskPersonas(),
};

export async function bootPersonaState(
  role: "mono" | "gateway" | "node",
  dialect: "pg" | "sqlite",
  deps: PersonaBootDeps = defaultDeps,
): Promise<(() => void) | undefined> {
  if (role === "node") {
    deps.loadFilesystem();
    return undefined;
  }
  // A filesystem tenant must define each persona by an agent.yaml; a managed one reads the database.
  if (await deps.isFilesystemTenant("default")) {
    const { seeded } = deps.checkDisk();
    if (seeded) console.warn(`[persona] seeded a starter agent.yaml at ${seeded}: fill in who manages it before going live`);
  }
  await deps.refresh("default");
  assertNoProviderRefsInMono(role, deps.withProvider());
  return dialect === "pg" ? deps.startRevalidation("default") : undefined;
}
