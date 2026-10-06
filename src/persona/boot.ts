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
};

const defaultDeps: PersonaBootDeps = {
  refresh: refreshPersonaState,
  withProvider: () => personasWithProvider(),
  startRevalidation: startRegistryRevalidation,
  loadFilesystem: () => setPersonaRegistry(loadPersonaRegistry()),
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
  await deps.refresh("default");
  assertNoProviderRefsInMono(role, deps.withProvider());
  return dialect === "pg" ? deps.startRevalidation("default") : undefined;
}
