/**
 * Harness selection.
 *
 * Adapters register themselves here; `SLAUDE_HARNESS` picks one (default
 * "claude"). Until an adapter exists for a descriptor, `resolveAdapter` refuses
 * with the negotiation report for that harness — which is the useful answer
 * anyway: it says exactly what would have to be built or degraded.
 */

import type { HarnessAdapter, HarnessCapabilities } from "./types";
import { DESCRIPTORS } from "./adapters/descriptors";
import { negotiate, formatNegotiation, assertUsable, type Feature, type Negotiation } from "./capabilities";

const adapters = new Map<string, HarnessAdapter>();

export function registerAdapter(a: HarnessAdapter): void {
  adapters.set(a.capabilities.id, a);
}

/** Harness id this deployment is configured for. */
export function selectedHarnessId(envValue = process.env.SLAUDE_HARNESS): string {
  return (envValue || "claude").trim().toLowerCase();
}

/** Declared capabilities for an id — from a registered adapter if there is one, else the descriptor. */
export function capabilitiesFor(id: string): HarnessCapabilities | null {
  return adapters.get(id)?.capabilities ?? DESCRIPTORS[id] ?? null;
}

/**
 * Score a harness against slaude's requirements without booting anything.
 * Powers the boot log and the "can we run on X?" question.
 */
export function reportFor(id: string, disabled?: readonly Feature[]): Negotiation {
  const caps = capabilitiesFor(id);
  if (!caps) throw new Error(`unknown harness "${id}" (known: ${Object.keys(DESCRIPTORS).join(", ")})`);
  return negotiate(caps, { disabled });
}

/** Human-readable comparison of every known harness. Used by the CLI report. */
export function compareAll(disabled?: readonly Feature[]): string {
  return Object.keys(DESCRIPTORS)
    .map((id) => formatNegotiation(reportFor(id, disabled)))
    .join("\n\n");
}

/**
 * Resolve the adapter for the configured harness, asserting it can host slaude.
 * Throws — loudly and with the missing-capability list — rather than booting a
 * session whose approval gate or surface tools would silently be absent.
 */
export function resolveAdapter(
  id = selectedHarnessId(),
  disabled?: readonly Feature[],
): HarnessAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    const known = capabilitiesFor(id);
    const hint = known
      ? `\nIts declared capabilities negotiate as:\n${formatNegotiation(negotiate(known, { disabled }))}`
      : "";
    throw new Error(
      `no harness adapter registered for "${id}" — registered: ${[...adapters.keys()].join(", ") || "(none)"}${hint}`,
    );
  }
  assertUsable(negotiate(adapter.capabilities, { disabled }));
  return adapter;
}
