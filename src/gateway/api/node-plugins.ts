/**
 * PUT /v1/node/plugins: one node's plugin report (design:
 * docs/superpowers/specs/2026-11-09-plugin-inventory.md). Node-authenticated;
 * the node id and labels come from the verified credential, never the body.
 *
 * Validated entry by entry: an invalid plugin or server is dropped and logged,
 * and the rest of the report still counts. Each HTTP server's URL is sanitized
 * again and its state checked here, against the gateway's own outbound policy:
 * a node does not get to decide that a private address is offerable.
 */
import { z } from "zod";
import type { NodeIdentity } from "./auth";
import { json, readBodyCapped } from "./http";
import { checkOutbound, OutboundBlockedError, type OutboundPolicyOptions } from "../../net/outbound-policy";
import { listNodePlugins, upsertNodePlugins, type NodePluginsRow } from "../../db/node-plugins";
import { noteReported } from "../core/plugin-inventory";
import {
  SERVER_STATES,
  STATE_INVALID_URL,
  STATE_OFFERABLE,
  STATE_REFUSED_POLICY,
  sanitizeServerUrl,
  type PluginReport,
  type ReportedHttpServer,
  type ReportedPlugin,
} from "../../config/plugin-inventory";

export const PLUGIN_REPORT_MAX_BYTES = 256 * 1024;
const MAX_PLUGINS = 200;
const MAX_SERVERS = 100;

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const serverName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const count = z.number().int().min(0).max(100_000);
const Stdio = z.object({ name: serverName, declared: z.boolean() });
const Http = z.object({ name: serverName, url: z.string().max(2048), state: z.enum(SERVER_STATES) });
const Plugin = z.object({
  name,
  marketplace: z.string().regex(/^[A-Za-z0-9._-]{0,128}$/),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  skills: count,
  commands: count,
  agents: count,
  hooks: count,
  stdio: z.array(z.unknown()).max(MAX_SERVERS),
  http: z.array(z.unknown()).max(MAX_SERVERS),
});

function validEntries<T>(raw: readonly unknown[], schema: z.ZodType<T>): { ok: T[]; dropped: number } {
  const ok: T[] = [];
  let dropped = 0;
  for (const e of raw) {
    const p = schema.safeParse(e);
    if (p.success) ok.push(p.data);
    else dropped++;
  }
  return { ok, dropped };
}

export interface NodePluginsDeps {
  store?: (row: NodePluginsRow) => Promise<void>;
  /** After a stored report (default: recompute this replica's view). */
  onReported?: () => void;
  /** Outbound policy options (tests inject a resolver). */
  policy?: OutboundPolicyOptions;
  now?: () => number;
}

/** A server's final state: sanitized again, then the guards only the gateway can run. */
export async function guardHttpServer(s: ReportedHttpServer, policy: OutboundPolicyOptions): Promise<ReportedHttpServer> {
  const url = sanitizeServerUrl(s.url);
  if (s.state !== STATE_OFFERABLE) return { ...s, url };
  if (!url || !url.startsWith("https://")) return { ...s, url, state: STATE_INVALID_URL };
  try {
    await checkOutbound(url, policy);
  } catch (e) {
    if (e instanceof OutboundBlockedError) return { ...s, url, state: STATE_REFUSED_POLICY };
    throw e;
  }
  return { ...s, url };
}

export async function handleNodePlugins(req: Request, node: NodeIdentity, deps: NodePluginsDeps = {}): Promise<Response> {
  const text = await readBodyCapped(req, PLUGIN_REPORT_MAX_BYTES);
  if (text === null) return json(413, { error: "plugin report too large" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { error: "malformed JSON body" });
  }
  const rawPlugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(rawPlugins)) return json(400, { error: "plugins must be a list" });
  const policy = deps.policy ?? {};

  const plugins: ReportedPlugin[] = [];
  let dropped = 0;
  for (const raw of rawPlugins.slice(0, MAX_PLUGINS)) {
    const p = Plugin.safeParse(raw);
    if (!p.success) {
      dropped++;
      continue;
    }
    const stdio = validEntries(p.data.stdio, Stdio);
    const http = validEntries(p.data.http, Http);
    dropped += stdio.dropped + http.dropped;
    plugins.push({
      ...p.data,
      stdio: stdio.ok,
      http: await Promise.all(http.ok.map((s) => guardHttpServer(s as ReportedHttpServer, policy))),
    });
  }
  if (rawPlugins.length > MAX_PLUGINS) dropped += rawPlugins.length - MAX_PLUGINS;
  if (dropped > 0) console.warn(`[plugins] node=${node.id} dropped ${dropped} invalid report entr${dropped === 1 ? "y" : "ies"}`);

  const report: PluginReport = { plugins };
  await (deps.store ?? upsertNodePlugins)({
    nodeId: node.id,
    labels: [...node.labels].sort(),
    reportedAt: (deps.now ?? Date.now)(),
    report,
  });
  (deps.onReported ?? noteReported)();
  return json(200, { ok: true, accepted: plugins.length, dropped });
}

export { listNodePlugins };
