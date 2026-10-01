/**
 * The pipeline's door. Its own prefix and its own token, deliberately not /v1:
 * /v1 authenticates with SLAUDE_NODE_TOKEN, which every node holds, and a shared
 * prefix or token would leave nodes one misrouted handler away from rewriting
 * identity.
 *
 *   POST /deploy/v1/tenants/:tenant/personas[?dryRun=1]
 */
import { env } from "../../config/env";
import { timingSafeStringEqual } from "../api/auth";
import { json, readJson } from "../api/http";
import { runSync, SyncFailure } from "../../persona/sync/run";
import { publishConfigReload } from "../core/config-reload";
import type { PubSub } from "../../queue/pubsub";

export interface DeployApiOptions {
  pubsub: PubSub | null;
  env?: () => Record<string, string | undefined>;
  extract?: (text: string) => Promise<unknown>;
}

export function createDeployApi(opts: DeployApiOptions) {
  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/deploy" && !url.pathname.startsWith("/deploy/")) return null;
    // Unconfigured: the endpoint does not exist, for every path and method,
    // before anything else is looked at.
    const configured = env.deployToken();
    if (!configured) return json(404, { error: "not found" });

    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!m || !timingSafeStringEqual(m[1]!, configured)) {
      return json(401, { error: "invalid or missing deploy token" });
    }

    const seg = url.pathname.split("/").filter(Boolean); // deploy v1 tenants :t personas
    if (!(seg.length === 5 && seg[1] === "v1" && seg[2] === "tenants" && seg[4] === "personas")) {
      return json(404, { error: "not found" });
    }
    if (req.method !== "POST") return json(405, { error: "method not allowed" });

    let tenant: string;
    try {
      tenant = decodeURIComponent(seg[3]!);
    } catch {
      return json(404, { error: "not found" });
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) return json(404, { error: "not found" });
    const dryRun = url.searchParams.get("dryRun") === "1";
    const raw = await readJson(req);
    if (raw === null) return json(422, { error: "body must be JSON" });

    try {
      const report = await runSync(tenant, raw, {
        dryRun,
        by: "pipeline",
        env: (opts.env ?? (() => process.env))(),
        extract: opts.extract,
      });
      if (!dryRun) await publishConfigReload(opts.pubsub, tenant);
      return json(200, report);
    } catch (e) {
      if (e instanceof SyncFailure) return json(e.status, { error: e.message });
      // Message only: the payload carries resolved secrets.
      console.error(`[deploy] sync failed tenant=${tenant}:`, (e as Error).message);
      return json(500, { error: "internal" });
    }
  }
  return { fetch };
}
