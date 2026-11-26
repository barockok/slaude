/**
 * A node's answer to "which box does this session run in": the join of the
 * runtime bundle (the box's name, image and current policy) and the session
 * view (the pinned digest), over the node's own bundle cache and session
 * store (src/box/session-box.ts does the join and fails the boot when the
 * two disagree).
 *
 * The persona asked for is the one in the job token's claims, never the
 * unsigned persona id of the queue payload: the gateway answers a bundle only
 * to a token it signed for that persona. A session with no token or tenant
 * yet has no box here (it cannot have been dispatched as a boxed session).
 *
 * Built only on a node that offers a sandbox tier. On tier `none` nothing in
 * the worker asks.
 */
import { makeSessionBoxSource, type BundleBoxFacts } from "../box/session-box";
import { type NodeClient, bundleFetchFailure } from "./client";
import { decodeClaims } from "./remote";

export interface NodeSessionBoxDeps {
  client: Pick<NodeClient, "getRuntime">;
  tenantFor: (sessionId: string) => string | undefined;
  tokenFor: (sessionId: string) => string | undefined;
  /** The session row as the gateway's session view returns it. */
  sessionFor: (sessionId: string) => Promise<{ box_name?: string | null; box_digest?: string | null } | null | undefined>;
}

export type NodeSessionBoxes = ReturnType<typeof makeSessionBoxSource>;

export function makeNodeSessionBoxes(deps: NodeSessionBoxDeps): NodeSessionBoxes {
  return makeSessionBoxSource({
    bundle: async (sessionId) => {
      const token = deps.tokenFor(sessionId);
      const tenant = deps.tenantFor(sessionId);
      const persona = token ? decodeClaims(token)?.persona : undefined;
      if (!token || !tenant || !persona) return {};
      try {
        // Served from the node's bundle cache with an If-None-Match, so this is a cheap call per boot and per connection.
        const bundle = (await deps.client.getRuntime(tenant, persona, token)) as { box?: BundleBoxFacts | null };
        return bundle.box ? { box: bundle.box } : {};
      } catch (e) {
        throw bundleFetchFailure(e);
      }
    },
    session: async (sessionId) => (await deps.sessionFor(sessionId)) ?? null,
  });
}
