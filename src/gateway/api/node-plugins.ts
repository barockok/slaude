/**
 * PUT /v1/node/plugins: one node's plugin report (design:
 * docs/superpowers/specs/2026-11-09-plugin-inventory.md). Node-authenticated;
 * the node id and labels come from the verified credential, never the body.
 *
 * Validated entry by entry: an invalid plugin or server is dropped and logged,
 * and the rest of the report still counts. Each HTTP server's URL is sanitized
 * again and its state checked here, against the gateway's own outbound policy:
 * a node does not get to decide that a private address is offerable.
 *
 * One report per credential and process: the first stands (409 after it), so a
 * stolen credential cannot rewrite the report of a process already running. A
 * report under a process id nobody heartbeats is stored and never offered. The
 * shared legacy token is not one machine, so every server in its report is stored
 * as not offered, whatever state it claimed. A node may send only the states a
 * node can know; a state the gateway decides is treated as an invalid entry.
 */
import { z } from "zod";
import type { NodeIdentity } from "./auth";
import { json, readBodyCapped } from "./http";
import type { OutboundPolicyOptions } from "../../net/outbound-policy";
import { insertNodePlugins, type NodePluginsRow } from "../../db/node-plugins";
import { guardHttpServer, noteReported } from "../core/plugin-inventory";
import {
  NODE_SERVER_STATES,
  STATE_LEGACY,
  sanitizeServerUrl,
  type PluginReport,
  type ReportedHttpServer,
  type ReportedPlugin,
} from "../../config/plugin-inventory";

export const PLUGIN_REPORT_MAX_BYTES = 256 * 1024;
const MAX_PLUGINS = 200;
const MAX_SERVERS = 100;

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const instance = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const serverName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const count = z.number().int().min(0).max(100_000);
const Stdio = z.object({ name: serverName, declared: z.boolean() });
// Node-originating states only: a state the gateway decides is an invalid entry.
const Http = z.object({ name: serverName, url: z.string().max(2048), state: z.enum(NODE_SERVER_STATES) });
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
  store?: (row: NodePluginsRow) => Promise<"stored" | "duplicate" | "cap">;
  /** After a stored report (default: recompute this replica's view). */
  onReported?: () => void;
  /** Outbound policy options (tests inject a resolver). */
  policy?: OutboundPolicyOptions;
  now?: () => number;
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
  const process_ = instance.safeParse((parsed as { instance?: unknown }).instance);
  if (!process_.success) return json(400, { error: "instance must be this process's id" });
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
      http: await Promise.all(
        http.ok.map((s) =>
          node.legacy
            ? { ...(s as ReportedHttpServer), url: sanitizeServerUrl(s.url), state: STATE_LEGACY }
            : guardHttpServer(s as ReportedHttpServer, policy),
        ),
      ),
    });
  }
  if (rawPlugins.length > MAX_PLUGINS) dropped += rawPlugins.length - MAX_PLUGINS;
  if (dropped > 0) console.warn(`[plugins] node=${node.id} dropped ${dropped} invalid report entr${dropped === 1 ? "y" : "ies"}`);

  const report: PluginReport = { instance: process_.data, plugins };
  const now = (deps.now ?? Date.now)();
  const stored = await (deps.store ?? insertNodePlugins)({
    nodeId: node.id,
    instance: process_.data,
    labels: [...node.labels].sort(),
    reportedAt: now,
    lastSeenAt: now,
    credentialIat: node.iat ?? 0,
    report,
  });
  if (stored === "duplicate") return json(409, { error: "this process has already reported" });
  if (stored === "cap") return json(429, { error: "this credential holds too many plugin reports" });
  (deps.onReported ?? noteReported)();
  return json(200, { ok: true, accepted: plugins.length, dropped });
}
