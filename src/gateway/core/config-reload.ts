/**
 * One place that announces a configuration change.
 *
 * `publishReload` had a live subscriber on every node and no publisher anywhere
 * in src/, so adding or editing a persona reached other processes only when an
 * ETag revalidation happened to run, and reached THIS process not at all — the
 * persona registry is memoized at boot, so adding an agent meant restarting the
 * gateway and every node.
 *
 * Announcing does two things: drop this replica's memoized persona map, and
 * publish on the tenant channel so every node drops its cached runtime bundles
 * for that tenant. Other gateway replicas learn the same way their nodes do.
 */
import { invalidatePersonaRegistry } from "../../persona/registry";
import type { PubSub } from "../../queue/pubsub";

export interface ConfigReloadResult {
  /** Subscribers the publish reached; null when there was no pub/sub to use. */
  notified: number | null;
  /** Set when the publish failed. The local invalidation still happened. */
  error?: string;
}

/**
 * Announce a configuration change for one tenant.
 *
 * A failed publish never throws: the local invalidation has already happened
 * and ETag revalidation still converges every node on its next fetch, so a
 * Redis blip must not fail the config write that triggered this.
 */
export async function publishConfigReload(
  pubsub: PubSub | null,
  tenantId: string,
): Promise<ConfigReloadResult> {
  invalidatePersonaRegistry();
  if (!pubsub) return { notified: null };
  try {
    const notified = await pubsub.publishReload(tenantId);
    return { notified };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[config-reload] publish failed tenant=${tenantId}: ${error}`);
    return { notified: null, error };
  }
}
