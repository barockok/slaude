/**
 * The rule for a persona's provider base URL (WS-A §4; review M-1): the URL a
 * persona's own credential is sent to. Checked at sync (a stored literal) and
 * again at bundle build (a stored literal, or a value a reference resolved to),
 * so a row written some other way cannot bypass it.
 *
 * - https only; http only for a host listed in SLAUDE_OUTBOUND_INTERNAL_HOSTS
 *   (exact host name, the outbound policy's parser and semantics);
 * - no user name or password, no query string or fragment;
 * - an IP literal is judged by the outbound policy's classifier: a private
 *   address only for a listed internal host; loopback, link-local, metadata,
 *   unspecified and reserved addresses never, listed or not;
 * - `localhost`, `*.localhost` and the well-known metadata names never.
 *
 * Host names are not resolved here: the agent child on a node connects, from
 * that node's network, so a gateway-side lookup would prove nothing. Messages
 * name the category, never the URL.
 */
import { classifyAddress, parseHostList } from "../net/outbound-policy";

const NEVER_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "metadata.goog"]);

export function internalHostsFrom(env: Record<string, string | undefined>): string[] {
  return parseHostList(env.SLAUDE_OUTBOUND_INTERNAL_HOSTS);
}

/** Why `raw` may not be a provider base URL, or null when it may. */
export function baseUrlProblem(raw: string, internalHosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be an https URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "must be an https URL";
  if (url.username || url.password) return "must not carry credentials in the URL; use provider.apiKey or provider.authToken";
  if (url.search || url.hash) return "must not carry a query string or fragment";
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (NEVER_HOSTS.has(host) || host.endsWith(".localhost")) return "must not name a loopback or metadata host";
  const internal = internalHosts.includes(host);
  if (/^[0-9.]+$/.test(host) || host.includes(":")) {
    const kind = classifyAddress(host);
    if (kind === "private") {
      if (!internal) return "names a private address; list its host in SLAUDE_OUTBOUND_INTERNAL_HOSTS to allow it";
    } else if (kind !== null) {
      return `names a ${kind} address`;
    }
  }
  if (url.protocol === "http:" && !internal) {
    return "must be https (http only for a host in SLAUDE_OUTBOUND_INTERNAL_HOSTS)";
  }
  return null;
}
