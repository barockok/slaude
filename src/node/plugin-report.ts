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
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { listInstalledPlugins, pluginRoot, type InstalledPlugin } from "../config/plugins";
import {
  STATE_INVALID_URL,
  STATE_NEEDS_HEADERS,
  STATE_OFFERABLE,
  STATE_SSE,
  STATE_URL_SECRETS,
  STATE_WRITABLE,
  sanitizeServerUrl,
  urlCarriesSecrets,
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
  /** A path's owner uid (test seam: tests cannot create root-owned files).
   *  Default: the real owner, from stat. */
  ownerOf?: (path: string) => number;
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

const GROUP_OTHER_WRITE = 0o022;
const STICKY = 0o1000;

/**
 * One path of a sealed chain: owned by root, and writable by nobody but root.
 *
 * `access(2)` alone is not enough: a process can chmod a tree it owns read-only
 * and pass, then chmod it back. Ownership by root is what the process cannot
 * forge. The one exception to the mode rule is a root-owned sticky directory
 * ABOVE the plugin root (such as /tmp): sticky means a non-owner cannot rename
 * or remove the root-owned entry below it.
 */
function pathSealed(path: string, realRoot: string, ownerOf: SealedOptions["ownerOf"]): boolean {
  let st;
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  if ((ownerOf ? ownerOf(path) : st.uid) !== 0) return false;
  if ((st.mode & GROUP_OTHER_WRITE) !== 0) {
    return st.isDirectory() && (st.mode & STICKY) !== 0 && !within(path, realRoot);
  }
  return !writable(path);
}

/** The path and every ancestor: an ancestor the process can write lets it
 *  rename the checked path and put another there. */
function chainSealed(path: string, realRoot: string, boundary: string | null, ownerOf: SealedOptions["ownerOf"]): boolean {
  let p = path;
  for (;;) {
    if (p === boundary) return true;
    if (!pathSealed(p, realRoot, ownerOf)) return false;
    const up = dirname(p);
    if (up === p) return true;
    p = up;
  }
}

/**
 * The sealed check. Answers the realpath of the plugin's `.mcp.json` only when
 * the plugin directory, that file and the installed_plugins.json listing it all
 * resolve (symlinks followed) inside the plugin root, and each of them and every
 * ancestor is owned by root and not writable by this process, its group or
 * others; null otherwise. A process running as root fails: it could write
 * anything. The caller reads THIS path, so what was checked is what gets read.
 */
export function sealedMcpFile(plugin: Pick<InstalledPlugin, "path" | "listedIn" | "imageOwned">, root: string | null, opts: SealedOptions = {}): string | null {
  if (!plugin.imageOwned || !root) return null;
  const uid = opts.uid ?? process.getuid?.();
  if (uid === 0) return null;
  let realRoot: string;
  let boundary: string | null = null;
  try {
    realRoot = realpathSync(root);
    if (opts.boundary) boundary = realpathSync(opts.boundary);
  } catch {
    return null;
  }
  let mcpFile: string | null = null;
  const mcpPath = join(plugin.path, ".mcp.json");
  for (const target of [plugin.path, mcpPath, plugin.listedIn]) {
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return null;
    }
    if (!within(real, realRoot)) return null;
    if (!chainSealed(real, realRoot, boundary, opts.ownerOf)) return null;
    if (target === mcpPath) mcpFile = real;
  }
  return mcpFile;
}

export function isPluginSealed(plugin: Pick<InstalledPlugin, "path" | "listedIn" | "imageOwned">, root: string | null, opts: SealedOptions = {}): boolean {
  return sealedMcpFile(plugin, root, opts) !== null;
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

function readServers(file: string): Record<string, Record<string, unknown>> {
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
  if (urlCarriesSecrets(rawUrl)) return { name, url, state: STATE_URL_SECRETS };
  if (hasHeaders(raw)) return { name, url, state: STATE_NEEDS_HEADERS };
  if (!sealed) return { name, url, state: STATE_WRITABLE };
  return { name, url, state: STATE_OFFERABLE };
}

function reportPlugin(p: InstalledPlugin, root: string | null, manifest: Pick<NodeManifest, "servers">, sealedOpts: SealedOptions): ReportedPlugin {
  const stdio: ReportedStdioServer[] = [];
  const http: ReportedHttpServer[] = [];
  const sealedFile = sealedMcpFile(p, root, sealedOpts);
  const servers = readServers(sealedFile ?? join(p.path, ".mcp.json"));
  const sealed = sealedFile !== null;
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
export function buildPluginReport(opts: { instance: string; manifest: Pick<NodeManifest, "servers">; sealed?: SealedOptions }): PluginReport {
  const root = pluginRoot();
  return {
    instance: opts.instance,
    plugins: listInstalledPlugins()
      .map((p) => reportPlugin(p, root, opts.manifest, opts.sealed ?? {}))
      .sort((a, b) => a.name.localeCompare(b.name) || a.marketplace.localeCompare(b.marketplace)),
  };
}

export interface ReportDeps {
  client: { putPlugins(report: PluginReport): Promise<"ok" | "unsupported" | "too-large" | "duplicate" | "too-many"> };
  /** This process's id, the one its worker heartbeats under. */
  instance: string;
  manifest: Pick<NodeManifest, "servers">;
  log?: (m: string) => void;
  warn?: (m: string) => void;
}

/** Build and send the report once. Never throws: a failed report must not stop a node. */
export async function reportNodePlugins(deps: ReportDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    const report = buildPluginReport({ instance: deps.instance, manifest: deps.manifest });
    const servers = report.plugins.reduce((n, p) => n + p.http.filter((h) => h.state === STATE_OFFERABLE).length, 0);
    if (process.getuid?.() === 0 && report.plugins.some((p) => p.http.length > 0)) {
      warn("[node] running as root: every plugin file counts as writable, so no HTTP plugin server is offered");
    }
    const result = await deps.client.putPlugins(report);
    if (result === "unsupported") {
      warn("[node] the gateway does not take plugin reports (it predates them); continuing without one");
      return;
    }
    if (result === "duplicate") {
      // A retry whose first attempt landed, or someone else used this process id.
      warn("[node] the gateway already holds a plugin report for this process; it keeps the first");
      return;
    }
    if (result === "too-many") {
      warn("[node] the gateway holds too many plugin reports for this credential; continuing without one");
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
