/**
 * The egress rules of a box, as a pure matcher (box spec, "Egress policy").
 *
 *   - refuse by default: a host that no `allow` entry names is refused;
 *   - an entry is a host name with an optional leading `*.` and an optional
 *     `:port`. Without a port it covers 80 and 443 only; with `:*` any port;
 *   - `*.example.com` covers every name below example.com, never example.com
 *     itself (the box file lists the bare name beside it when both are meant);
 *   - `deny` wins over `allow`, whatever the order;
 *   - names compare without case and without a trailing dot. An IP literal is
 *     a host like any other: it is allowed only when an entry spells it.
 *
 * Nothing here resolves a name or opens a socket. The proxy asks this first,
 * then resolves once and checks the address it will connect to.
 */
import type { BoxEgress } from "../policy";

export interface EgressRule {
  /** Lower case, no trailing dot, no `*.`. */
  host: string;
  /** True for a `*.` entry: every name strictly below `host`. */
  wildcard: boolean;
  /** A port, or null for the default pair (80, 443), or "*" for any. */
  port: number | "*" | null;
}

export type EgressVerdict =
  | { allow: true }
  | { allow: false; reason: "not-allowlisted" | "denied" | "invalid-host" };

const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const DEFAULT_PORTS: readonly number[] = [80, 443];

/** A host as the matcher compares it: lower case, brackets and one trailing dot removed. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Parse one allow or deny entry. Null when it is not one: the caller ignores it (the schema refused it at sync). */
export function parseEgressRule(entry: string): EgressRule | null {
  let text = entry.trim().toLowerCase();
  if (!text) return null;
  let port: EgressRule["port"] = null;
  // An IPv6 literal is written in brackets when it carries a port.
  const v6 = /^\[([0-9a-f:.]+)\](?::(\*|\d{1,5}))?$/.exec(text);
  if (v6) {
    if (v6[2] !== undefined) port = v6[2] === "*" ? "*" : Number(v6[2]);
    if (typeof port === "number" && (port < 1 || port > 65535)) return null;
    return { host: v6[1]!, wildcard: false, port };
  }
  const colon = text.lastIndexOf(":");
  if (colon > 0 && text.indexOf(":") === colon) {
    const p = text.slice(colon + 1);
    if (p === "*") port = "*";
    else if (/^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535) port = Number(p);
    else return null;
    text = text.slice(0, colon);
  }
  const wildcard = text.startsWith("*.");
  if (wildcard) text = text.slice(2);
  const host = normalizeHost(text);
  // A bare IPv6 literal (several colons, no brackets) is a host with no port.
  if (host.includes(":")) return /^[0-9a-f:.]+$/.test(host) && !wildcard ? { host, wildcard: false, port } : null;
  if (!HOST_RE.test(host)) return null;
  return { host, wildcard, port };
}

function ruleMatches(rule: EgressRule, host: string, port: number): boolean {
  const hostOk = rule.wildcard ? host.length > rule.host.length + 1 && host.endsWith(`.${rule.host}`) : host === rule.host;
  if (!hostOk) return false;
  if (rule.port === "*") return true;
  if (rule.port === null) return DEFAULT_PORTS.includes(port);
  return rule.port === port;
}

/** Whether a box with these rules may open a connection to `host:port`. */
export function egressVerdict(rules: BoxEgress, hostRaw: string, port: number): EgressVerdict {
  const host = normalizeHost(hostRaw);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { allow: false, reason: "invalid-host" };
  if (host.includes(":") ? !/^[0-9a-f:.]+$/.test(host) : !HOST_RE.test(host)) return { allow: false, reason: "invalid-host" };
  const parsed = (list: readonly string[]) => list.map(parseEgressRule).filter((r): r is EgressRule => r !== null);
  if (parsed(rules.deny).some((r) => ruleMatches(r, host, port))) return { allow: false, reason: "denied" };
  if (parsed(rules.allow).some((r) => ruleMatches(r, host, port))) return { allow: true };
  return { allow: false, reason: "not-allowlisted" };
}

/**
 * The one sentence a refused client is sent. Tools drop the body of a failed
 * CONNECT (measured in the phase 0 spike), so the same fact is also in the
 * boxed session's system prompt: this text is for the tools that do show it
 * (plain HTTP through the proxy) and for the node's log.
 */
export function egressRefusalText(host: string): string {
  return `egress refused: ${normalizeHost(host) || "this host"} is not on this box's allowlist. The allowlist is part of the box definition and is changed by the people who deploy this agent, not from inside a session.`;
}
