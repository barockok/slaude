// The brain backend seam. brainCall/brainAdminCall route through getBackend(),
// which returns either the in-process LocalBackend (default) or the RemoteBackend
// (an OAuth'd MCP client to a separate brain server) based on SLAUDE_BRAIN_MODE.
//
// Scope resolution and write-gating stay in slaude (mcp-tools.ts / gated-dispatch.ts);
// the backend only carries an already-resolved scope to where the engine lives.

import type { BrainScope } from "./scope";
import { brainMode, brainRemoteUrl } from "./brain-config";
import { runAdminOp, runScopedOp } from "./brain";

export interface BrainBackend {
  call(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown>;
  adminCall(name: string, params: Record<string, unknown>, sourceId: string): Promise<unknown>;
}

/** In-process engine — the historical path. */
export class LocalBackend implements BrainBackend {
  call(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> {
    return runScopedOp(name, params, scope);
  }
  adminCall(name: string, params: Record<string, unknown>, sourceId: string): Promise<unknown> {
    return runAdminOp(name, params, sourceId);
  }
}

// RemoteBackend is registered by the brain-client module (avoids a static import
// cycle and keeps the MCP client out of the local-only code path). The factory is
// resolved lazily the first time a remote backend is needed.
type RemoteFactory = (url: string) => BrainBackend;
let remoteFactory: RemoteFactory | undefined;

export function registerRemoteBackend(factory: RemoteFactory): void {
  remoteFactory = factory;
}

let cached: BrainBackend | undefined;

export function getBackend(): BrainBackend {
  if (cached) return cached;
  if (brainMode() === "remote") {
    if (!remoteFactory) {
      // Trigger registration side-effect, then retry.
      require("./remote/brain-client");
    }
    if (!remoteFactory) throw new Error("remote brain backend factory not registered");
    cached = remoteFactory(brainRemoteUrl());
  } else {
    cached = new LocalBackend();
  }
  return cached;
}

/** Test seam: force a backend instance. */
export function setBackendForTest(b: BrainBackend | undefined): void {
  cached = b;
}

/** Test seam: clear the cached backend so the next getBackend() re-selects. */
export function resetBackend(): void {
  cached = undefined;
}
