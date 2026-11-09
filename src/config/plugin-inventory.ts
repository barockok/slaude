/**
 * The plugin inventory wire format: what a node reports to the gateway at start
 * (PUT /v1/node/plugins) and what the gateway stores. Shared by node and gateway;
 * no runtime dependency on either side.
 *
 * A report carries no header or env value and no URL userinfo, query or fragment
 * (a report is shown to operators and stored unencrypted).
 */

/** An HTTP server that passed every guard. */
export const STATE_OFFERABLE = "offerable";
/** Not an image-owned plugin, or its files are writable by the node's process. */
export const STATE_WRITABLE = "not offered: plugin files are writable by the agent";
/** The bridge would have no values to send for its headers. */
export const STATE_NEEDS_HEADERS = "not offered: needs static headers";
/** Unparsable URL, not https, or still holding a placeholder. */
export const STATE_INVALID_URL = "not offered: invalid url";
/** The gateway's outbound policy refused it (set at the gateway). */
export const STATE_REFUSED_POLICY = "not offered: refused by the outbound policy";
/** SSE servers are listed but never bridged. */
export const STATE_SSE = "not offered: sse transport is not bridged";
/** Bridging the stripped URL would reach a different endpoint than configured. */
export const STATE_URL_SECRETS = "not offered: url carries query or credentials";
/** The host did not resolve at the gateway. Not sticky: re-evaluated at every refresh. */
export const STATE_DNS_PENDING = "not offered: host did not resolve";
/** The shared legacy token names no one machine, so its report cannot be trusted to be one. */
export const STATE_LEGACY = "not offered: node uses the shared legacy token";

export const SERVER_STATES = [
  STATE_OFFERABLE,
  STATE_WRITABLE,
  STATE_NEEDS_HEADERS,
  STATE_INVALID_URL,
  STATE_REFUSED_POLICY,
  STATE_SSE,
  STATE_URL_SECRETS,
  STATE_DNS_PENDING,
  STATE_LEGACY,
] as const;

export type ServerState = (typeof SERVER_STATES)[number];

/** The only states a node may send. The rest are decided at the gateway: a node
 *  claiming one (say, "host did not resolve", which a refresh can promote) would
 *  be choosing a verdict that belongs to the gateway. */
export const NODE_SERVER_STATES = [
  STATE_OFFERABLE,
  STATE_WRITABLE,
  STATE_NEEDS_HEADERS,
  STATE_INVALID_URL,
  STATE_SSE,
  STATE_URL_SECRETS,
] as const;

export interface ReportedStdioServer {
  name: string;
  /** Whether the node manifest declares a server of this name. */
  declared: boolean;
}

export interface ReportedHttpServer {
  name: string;
  /** Scheme, host and path only; "" when the configured URL does not parse. */
  url: string;
  state: ServerState;
}

export interface ReportedPlugin {
  name: string;
  marketplace: string;
  commit: string | null;
  skills: number;
  commands: number;
  agents: number;
  hooks: number;
  stdio: ReportedStdioServer[];
  http: ReportedHttpServer[];
}

export interface PluginReport {
  /** This process's id (the id it heartbeats under). The gateway keeps one
   *  report per credential and process, and takes only the first. */
  instance: string;
  plugins: ReportedPlugin[];
}

/** States a node gives only after the sealed check passed, or the gateway's
 *  later refusal of such a server. Only these may create a URL conflict: an
 *  agent-writable plugin must not be able to veto a sealed server. */
export function isSealedState(s: ServerState): boolean {
  return s === STATE_OFFERABLE || s === STATE_REFUSED_POLICY || s === STATE_DNS_PENDING;
}

/** Whether the URL has userinfo or a query. Stripping those for the report
 *  yields a different endpoint from the configured one, so it is never offered. */
export function urlCarriesSecrets(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.username !== "" || u.password !== "" || u.search !== "";
  } catch {
    return false;
  }
}

/** Userinfo, query and fragment removed; "" when it does not parse. */
export function sanitizeServerUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}
