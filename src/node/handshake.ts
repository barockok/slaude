/**
 * The node's boot handshake (node labels spec §4.2): GET /v1/node/whoami.
 *
 *   - 401: the credential is bad, expired or revoked. The node must not run;
 *     the caller exits with a clear message (never the token).
 *   - network error, 5xx or any other 4xx: the gateway is not up yet (cluster
 *     cold start), or a proxy or a rollout is in the way.
 *     Retry with capped exponential backoff instead of crash-looping.
 *   - 404: a gateway that predates whoami. A legacy token still works there,
 *     so continue; a signed credential would have been refused with 401.
 *   - fewer than 14 days left on a signed credential: warn.
 */
import { NodeApiError, type NodeClient, type NodeWhoami } from "./client";

export const EXPIRY_WARN_SEC = 14 * 86400;

export type HandshakeResult =
  | { ok: true; identity: NodeWhoami | null }
  | { ok: false; reason: "unauthorized"; message: string };

export interface HandshakeOpts {
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Give up after this many attempts (tests). Default: never. */
  maxAttempts?: number;
}

export async function nodeHandshake(client: Pick<NodeClient, "whoami">, opts: HandshakeOpts = {}): Promise<HandshakeResult> {
  const log = opts.log ?? ((m) => console.log(m));
  const warn = opts.warn ?? ((m) => console.warn(m));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const id = await client.whoami();
      log(
        `[node] authenticated to the gateway as id=${id.id} labels=${id.labels.join(",")}${id.legacy ? " (legacy shared token)" : ""}`,
      );
      if (id.expiresInSec !== null && id.expiresInSec < EXPIRY_WARN_SEC) {
        warn(
          `[node] the node credential '${id.id}' expires in ${Math.floor(id.expiresInSec / 86400)} day(s); mint a new one (bun run node-token mint) and roll this node`,
        );
      }
      return { ok: true, identity: id };
    } catch (e) {
      if (e instanceof NodeApiError) {
        if (e.status === 401) {
          return {
            ok: false,
            reason: "unauthorized",
            message:
              "[node] the gateway refused this node's credential (401): SLAUDE_NODE_TOKEN is wrong, expired or revoked, " +
              "or it is a signed credential and the gateway does not accept signed credentials. Not starting.",
          };
        }
        if (e.status === 404) {
          warn("[node] the gateway has no /v1/node/whoami (an older gateway); continuing without the handshake");
          return { ok: true, identity: null };
        }
        // Any other answer (429, 403, 400, 5xx) may be a proxy or a gateway
        // mid-rollout: retry rather than crash-loop. Only 401 stops the node.
      }
      if (opts.maxAttempts !== undefined && attempt >= opts.maxAttempts) throw e;
      const delay = Math.min(max, base * 2 ** Math.min(attempt - 1, 16));
      warn(`[node] gateway handshake failed (${e instanceof NodeApiError ? e.status : e instanceof Error ? e.message : String(e)}); retrying in ${delay} ms`);
      await sleep(delay);
    }
  }
}
