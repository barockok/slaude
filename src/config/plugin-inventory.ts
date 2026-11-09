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

export const SERVER_STATES = [
  STATE_OFFERABLE,
  STATE_WRITABLE,
  STATE_NEEDS_HEADERS,
  STATE_INVALID_URL,
  STATE_REFUSED_POLICY,
  STATE_SSE,
] as const;

export type ServerState = (typeof SERVER_STATES)[number];

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
  plugins: ReportedPlugin[];
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
