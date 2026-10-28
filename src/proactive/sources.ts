import { oauthHttpServers, type ExternalMcp } from "../gateway/core/external-mcp";

export interface WatchedSource {
  server: string;
  readTools: string[];
}

/** The servers a heartbeat round may read, from the `watch` names in the soul.
 *  A name is kept only when the persona configures it as an HTTP server with a
 *  URL, it is not a `privateServices` entry (those mount anonymous in a locked
 *  thread and hold a person's credential), and it declares a non-empty
 *  `readTools` list (the operator's statement of which tools only read).
 *  Each rejection warns once; duplicate names collapse to one. */
export function watchableSources(
  watch: readonly string[],
  mcp: ExternalMcp,
  warn: (msg: string) => void = (m) => console.warn(m),
): WatchedSource[] {
  const http = oauthHttpServers(mcp.servers);
  const priv = new Set(mcp.privateServices);
  const out: WatchedSource[] = [];
  for (const name of new Set(watch)) {
    const cfg: any = mcp.servers[name];
    if (!cfg) {
      warn(`[proactive] watch "${name}": server not configured — skipped`);
    } else if (!(name in http)) {
      warn(`[proactive] watch "${name}": stdio or non-http server cannot be watched — skipped`);
    } else if (priv.has(name)) {
      warn(`[proactive] watch "${name}": private service cannot be watched — skipped`);
    } else if (
      !Array.isArray(cfg.readTools) ||
      !cfg.readTools.length ||
      !cfg.readTools.every((t: unknown) => typeof t === "string")
    ) {
      warn(`[proactive] watch "${name}": no readTools declared — skipped`);
    } else {
      out.push({ server: name, readTools: [...cfg.readTools] });
    }
  }
  return out;
}
