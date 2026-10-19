import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { classifyAddress, parseHostList } from "../../net/outbound-policy";
import { preflight } from "../preflight";
import type { HelperTransport } from "../transport";
import type { EnvironmentKind, StoredEnv } from "./types";

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (h) => (await dnsLookup(h, { all: true, verbatim: true })).map((a) => a.address);
let resolver: Resolver = systemResolver;
export function __setSshResolverForTests(r: Resolver | null): void {
  resolver = r ?? systemResolver;
}

/**
 * Resolve an ssh host once and check every address against the outbound
 * rules (spec §5): link-local, cloud metadata, unspecified and reserved ranges
 * are always refused; loopback only with SLAUDE_OUTBOUND_DEV_LOOPBACK=1;
 * private ranges only for a host named in SLAUDE_OUTBOUND_INTERNAL_HOSTS or
 * with SLAUDE_ENV_SSH_ALLOW_PRIVATE=1 (a LAN box). Returns the address to
 * connect to, so a second DNS answer cannot move the connection. Errors name
 * the host and the category, never the address.
 */
export async function checkSshHost(host: string): Promise<string> {
  const h = host.toLowerCase().replace(/\.$/, "");
  let addrs: string[];
  if (isIP(h)) addrs = [h];
  else {
    try { addrs = await resolver(h); } catch { addrs = []; }
    if (!addrs.length) throw new Error(`${h} could not be resolved`);
  }
  const allowLoopback = process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK === "1";
  const allowPrivate = process.env.SLAUDE_ENV_SSH_ALLOW_PRIVATE === "1" || parseHostList(process.env.SLAUDE_OUTBOUND_INTERNAL_HOSTS).includes(h);
  for (const a of addrs) {
    const kind = classifyAddress(a);
    if (kind === null) continue;
    if (kind === "loopback" && allowLoopback) continue;
    if (kind === "private" && allowPrivate) continue;
    throw new Error(`${h} resolves to a ${kind} address, which ssh environments may not reach on this deployment`);
  }
  return addrs[0]!;
}

async function sshTransport(env: StoredEnv): Promise<HelperTransport> {
  return {
    kind: "ssh",
    host: await checkSshHost(env.config.host ?? ""),
    port: Number(env.config.port ?? 22),
    username: env.config.user ?? "",
    hostKey: env.config.hostKey ?? "",
  };
}

/** Plain SSH to a box the owner controls. The host key is pinned: given in the
 *  form, or recorded at the first pre-flight and shown to the owner privately. */
export const sshKind: EnvironmentKind = {
  kind: "ssh",
  label: "SSH host",
  trust: "user-machine",
  pinnedKey: "hostKey",
  fields: [
    { id: "host", label: "Host", hint: "Host name or IP address. It is never posted in the thread.", placeholder: "build-box.example.com" },
    { id: "user", label: "User", placeholder: "dev" },
    { id: "port", label: "Port", optional: true, placeholder: "22" },
    {
      id: "hostKey",
      label: "Host key fingerprint",
      optional: true,
      hint: "SHA256:… from `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. Leave empty to pin the key seen on first connect.",
      placeholder: "SHA256:…",
    },
  ],
  parse(input) {
    const host = (input.host ?? "").trim();
    const user = (input.user ?? "").trim();
    const portRaw = (input.port ?? "").trim() || "22";
    const hostKey = (input.hostKey ?? "").trim();
    if (!HOST_RE.test(host) && !isIP(host.replace(/^\[(.*)\]$/, "$1"))) return { ok: false, error: "That doesn't look like a host name or IP address." };
    if (!USER_RE.test(user)) return { ok: false, error: "The user must be a plain account name." };
    const port = Number(portRaw);
    if (!/^\d+$/.test(portRaw) || port < 1 || port > 65535) return { ok: false, error: "The port must be a number from 1 to 65535." };
    if (hostKey && !FP_RE.test(hostKey)) return { ok: false, error: "The host key fingerprint must look like `SHA256:` followed by 43 characters." };
    return { ok: true, config: { host: host.replace(/^\[(.*)\]$/, "$1"), user, port: String(port), ...(hostKey ? { hostKey } : {}) } };
  },
  setupGuide(publicKey) {
    return [
      "*Set up an SSH environment* (only you can see this):",
      "1. On the host, add slaude's key to the account's `~/.ssh/authorized_keys`:",
      "```",
      publicKey.trim(),
      "```",
      "2. Make sure `perl` and `bash` are installed there (the remote tools need them).",
      "3. In the thread, send `/env add` and pick *SSH host*. Give the host's key fingerprint if you have it; otherwise the key seen on first connect is pinned and shown to you.",
      "",
      ":warning: Commands run as that account, with everything it can reach. Use a separate account or a container for repos you don't trust.",
    ].join("\n");
  },
  transport: sshTransport,
  async status(_env, info) {
    if (!info) return "unreachable";
    const r = await preflight({ info, dir: "/" }).catch(() => ({ ok: false as const, error: "" }));
    return r.ok ? "reachable" : "unreachable";
  },
};
