/**
 * The node's plugin report (design: docs/superpowers/specs/2026-11-09-plugin-inventory.md).
 *
 * Built and sent ONCE per process, before the worker claims any job: no agent
 * turn has run yet, so nothing an agent wrote this run can be in the report.
 *
 * Trust: a report names URLs the gateway will offer in the portal with no
 * approval step. A file an agent turn can write must never be able to name such
 * a URL, so an HTTP server is offerable only from a plugin listed under the
 * image-owned SLAUDE_PLUGIN_ROOT whose files pass the sealed check. A node
 * process running as root fails the check by design: it could write anything.
 *
 * No secrets: header and env values are never read into the report; URLs lose
 * userinfo, query and fragment.
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { listInstalledPlugins, pluginRoot, type InstalledPlugin } from "../config/plugins";
import {
  STATE_INVALID_URL,
  STATE_NEEDS_HEADERS,
  STATE_OFFERABLE,
  STATE_SSE,
  STATE_WRITABLE,
  sanitizeServerUrl,
  type PluginReport,
  type ReportedHttpServer,
  type ReportedPlugin,
  type ReportedStdioServer,
} from "../config/plugin-inventory";
import type { NodeManifest } from "./manifest";

export interface SealedOptions {
  /** The process uid. Default: process.getuid(). */
  uid?: number;
  /** Stop walking ancestors at this directory, not checking it (test seam).
   *  Default: every ancestor up to the filesystem root is checked. */
  boundary?: string;
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/** Writable path, or any writable ancestor up to the boundary: an ancestor the
 *  process can write lets it rename the checked path and put another there. */
function writableChain(path: string, boundary: string | null): boolean {
  let p = path;
  for (;;) {
    if (p === boundary) return false;
    if (writable(p)) return true;
    if (p === "/") return false;
    const up = dirname(p);
    if (up === p) return false;
    p = up;
  }
}

/**
 * The sealed check. True only when the plugin directory, its `.mcp.json` and
 * the installed_plugins.json listing it all resolve (symlinks followed) inside
 * the plugin root and none of them, nor any ancestor, is writable by this
 * process. `access(2)` is the kernel's own answer, so group bits, ACLs and a
 * read-only mount are all counted as they really apply.
 */
export function isPluginSealed(plugin: Pick<InstalledPlugin, "path" | "listedIn" | "imageOwned">, root: string | null, opts: SealedOptions = {}): boolean {
  if (!plugin.imageOwned || !root) return false;
  const uid = opts.uid ?? process.getuid?.();
  if (uid === 0) return false;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  let boundary: string | null = null;
  try {
    if (opts.boundary) boundary = realpathSync(opts.boundary);
  } catch {
    return false;
  }
  for (const target of [plugin.path, join(plugin.path, ".mcp.json"), plugin.listedIn]) {
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return false;
    }
    if (!within(real, realRoot)) return false;
    if (writableChain(real, boundary)) return false;
  }
  return true;
}

function countMd(dir: string, depth = 0): number {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory() && depth < 4) n += countMd(join(dir, e.name), depth + 1);
    else if (e.isFile() && e.name.endsWith(".md")) n += 1;
  }
  return n;
}

function countSkills(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md"))).length;
  } catch {
    return 0;
  }
}

function countHooks(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { hooks?: Record<string, unknown[]> };
    return Object.values(parsed.hooks ?? {}).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0);
  } catch {
    return 0;
  }
}

function readServers(pluginPath: string): Record<string, Record<string, unknown>> {
  const file = join(pluginPath, ".mcp.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown } | null;
    const servers = parsed?.mcpServers ?? parsed;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
    return servers as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

function hasHeaders(raw: Record<string, unknown>): boolean {
  const h = raw.headers;
  return !!h && typeof h === "object" && Object.keys(h as object).length > 0;
}

/** One HTTP entry's state, by the guards in order. The URL is sanitized first,
 *  so a placeholder in a query never leaves the node. */
function httpEntry(name: string, raw: Record<string, unknown>, sealed: boolean): ReportedHttpServer {
  const rawUrl = String(raw.url ?? "");
  const url = sanitizeServerUrl(rawUrl);
  if (raw.type === "sse") return { name, url, state: STATE_SSE };
  if (!url || rawUrl.includes("${") || !url.startsWith("https://")) return { name, url, state: STATE_INVALID_URL };
  if (hasHeaders(raw)) return { name, url, state: STATE_NEEDS_HEADERS };
  if (!sealed) return { name, url, state: STATE_WRITABLE };
  return { name, url, state: STATE_OFFERABLE };
}

function reportPlugin(p: InstalledPlugin, root: string | null, manifest: Pick<NodeManifest, "servers">, sealedOpts: SealedOptions): ReportedPlugin {
  const stdio: ReportedStdioServer[] = [];
  const http: ReportedHttpServer[] = [];
  const servers = readServers(p.path);
  const sealed = Object.keys(servers).length > 0 && isPluginSealed(p, root, sealedOpts);
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    if ((raw.type === "http" || raw.type === "sse") && typeof raw.url === "string") http.push(httpEntry(name, raw, sealed));
    else if (typeof raw.command === "string") stdio.push({ name, declared: Object.hasOwn(manifest.servers, name) });
  }
  return {
    name: p.name,
    marketplace: p.marketplace,
    commit: p.commit,
    skills: countSkills(join(p.path, "skills")),
    commands: countMd(join(p.path, "commands")),
    agents: countMd(join(p.path, "agents")),
    hooks: countHooks(join(p.path, "hooks", "hooks.json")),
    stdio: stdio.sort((a, b) => a.name.localeCompare(b.name)),
    http: http.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The report for this machine's plugins, against its node manifest. */
export function buildPluginReport(opts: { manifest: Pick<NodeManifest, "servers">; sealed?: SealedOptions }): PluginReport {
  const root = pluginRoot();
  return {
    plugins: listInstalledPlugins()
      .map((p) => reportPlugin(p, root, opts.manifest, opts.sealed ?? {}))
      .sort((a, b) => a.name.localeCompare(b.name) || a.marketplace.localeCompare(b.marketplace)),
  };
}

export interface ReportDeps {
  client: { putPlugins(report: PluginReport): Promise<"ok" | "unsupported" | "too-large"> };
  manifest: Pick<NodeManifest, "servers">;
  log?: (m: string) => void;
  warn?: (m: string) => void;
}

/** Build and send the report once. Never throws: a failed report must not stop a node. */
export async function reportNodePlugins(deps: ReportDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    const report = buildPluginReport({ manifest: deps.manifest });
    const servers = report.plugins.reduce((n, p) => n + p.http.filter((h) => h.state === STATE_OFFERABLE).length, 0);
    if (process.getuid?.() === 0 && report.plugins.some((p) => p.http.length > 0)) {
      warn("[node] running as root: every plugin file counts as writable, so no HTTP plugin server is offered");
    }
    const result = await deps.client.putPlugins(report);
    if (result === "unsupported") {
      warn("[node] the gateway does not take plugin reports (it predates them); continuing without one");
      return;
    }
    if (result === "too-large") {
      warn("[node] the gateway refused the plugin report as too large; continuing without one");
      return;
    }
    log(`[node] reported ${report.plugins.length} plugin(s) to the gateway, ${servers} HTTP server(s) offerable`);
  } catch (e) {
    warn(`[node] plugin report not sent: ${e instanceof Error ? e.name : typeof e}`);
  }
}
