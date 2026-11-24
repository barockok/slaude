/**
 * The node worker's default way to run boxes: through the box supervisor
 * (boxd), for both sandbox tiers. It fills in what src/node/box-node.ts
 * leaves to a driver: the driver itself, the builder of a session's sandbox
 * spec, the packer for the home and workspace-extras units, and the
 * supervisor's limits.
 *
 * Everything that needs a credential stays here, in the worker's process:
 *
 *   - the provider's real credential is read from the session's runtime
 *     bundle on every model request, inside the provider proxy;
 *   - the egress rules are read from the session's bundle on every
 *     connection.
 *
 * The supervisor is told paths and limits and nothing else.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ChildEnvPatch } from "../agent/child-env";
import { BoxdClient } from "../box/boxd/client";
import type { SandboxTier } from "../box/boxd/protocol";
import { CONFIG_CREDENTIAL_FILES, makeSupervisedDriver, type ProviderRoute, type SupervisedDriver } from "../box/drivers/supervised";
import type { EgressRefusal } from "../box/egress/proxy";
import { PROVIDER_FORM_ENV, type ProviderForm } from "../box/env";
import { BOX_SUPPORTED_PROVIDER_FORMS } from "../box/provider-forms";
import type { BoxEgress } from "../box/policy";
import { buildBoxSpec } from "../box/resolver";
import { env } from "../config/env";
import { paths } from "../config/home";
import { loadInstalledPluginPaths } from "../config/plugins";
import { BootFailure } from "../gateway/core/failure-codes";
import { homePluginDirFor } from "../skills/persona-plugin";
import { BUILTIN_PLUGIN_DIR } from "../soul/builtin";
import type { NodeBoxOpts } from "./box-node";

const DEFAULT_PROVIDER_BASE_URL = "https://api.anthropic.com";
/** The order a session's credential form is chosen in when its bundle carries more than one. */
const FORM_ORDER: readonly ProviderForm[] = ["api-key", "auth-token", "oauth-token"];

type Overlay = Record<string, string | undefined> | ChildEnvPatch | undefined;

/**
 * A session's provider route from its child-env overlay (what an unboxed
 * child would have been given). A strict overlay (a patch) is taken as it
 * is; an additive one may fall back to the node's own provider variables,
 * exactly as an unboxed child inherits them. No credential: a BootFailure.
 */
export function providerRouteOf(overlay: Overlay, nodeEnv: Record<string, string | undefined> = process.env): ProviderRoute {
  const strict = overlay instanceof ChildEnvPatch;
  const set: Record<string, string | undefined> = strict ? overlay.set : (overlay ?? {});
  const read = (name: string): string | undefined => {
    const v = set[name] ?? (strict ? undefined : nodeEnv[name]);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  for (const form of FORM_ORDER) {
    const credential = read(PROVIDER_FORM_ENV[form]);
    if (!credential) continue;
    if (!BOX_SUPPORTED_PROVIDER_FORMS.has(form)) throw new BootFailure("BOX_UNAVAILABLE", `a box cannot serve the provider credential form ${form}`);
    return { baseUrl: read("ANTHROPIC_BASE_URL") ?? DEFAULT_PROVIDER_BASE_URL, form, credential };
  }
  throw new BootFailure("PROVIDER_CREDENTIALS_UNAVAILABLE", "the session has no provider credential for its box's provider proxy");
}

/** Host names a box never reaches: the gateway, Redis and the object store endpoint of this node. Names only. */
export function nodeServiceHosts(e: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  for (const raw of [e.SLAUDE_GATEWAY_URL, e.SLAUDE_REDIS_URL, e.SLAUDE_S3_ENDPOINT]) {
    if (!raw) continue;
    try {
      const host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
      if (host) out.add(host);
    } catch {
      /* not a URL: nothing to refuse by name */
    }
  }
  return [...out];
}

/** The directories of the CLI binaries the SDK may spawn (one per platform package that is installed). */
export function cliDirs(): string[] {
  let scope: string;
  try {
    scope = dirname(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk/package.json")));
  } catch {
    return [];
  }
  let names: string[] = [];
  try {
    names = readdirSync(scope);
  } catch {
    names = [];
  }
  return names.filter((n) => /^claude-agent-sdk-[a-z0-9-]+$/.test(n) && existsSync(join(scope, n, "claude"))).map((n) => join(scope, n));
}

export interface SupervisedBoxDeps {
  tier: SandboxTier;
  /** What the caller already set (capacity, a test's image store, ...). The driver, spec builder, packer and limits are added. */
  base?: NodeBoxOpts;
  tenantFor: (sessionId: string) => string | undefined;
  personaFor: (sessionId: string) => string | undefined;
  workingDirOf: (sessionId: string) => Promise<string | undefined>;
  /** The session's CLAUDE_CONFIG_DIR, created if needed. */
  configDirOf: (sessionId: string, persona: string) => string;
  /** The session's scratch directory, created if needed; undefined when it cannot be made. */
  scratchDirOf: (sessionId: string) => string | undefined;
  /** The session's egress rules, from its bundle. */
  egressOf: (sessionId: string) => Promise<BoxEgress>;
  /** The session's child-env overlay as an unboxed child would get it (the provider credential is read from it, per request). */
  childEnvOf: (sessionId: string) => Promise<Overlay>;
  /** Sessions of a tenant, for closing connections a reload no longer allows. */
  sessionsOf: (tenantId: string) => string[];
  socketPath?: string;
  boxDir?: string;
  log?: (line: string) => void;
}

export interface SupervisedBoxes {
  opts: NodeBoxOpts;
  driver: SupervisedDriver;
  /** Where the supervisor keeps pack indexes: a place both it and the worker reach. */
  packIndexDir: string;
  /** Whether the supervisor answers now (readiness). */
  alive(): Promise<boolean>;
  /** A tenant's configuration was reloaded: end the connections its sessions' new rules refuse. */
  reloaded(tenantId: string): Promise<void>;
  close(): void;
}

export function makeSupervisedBoxes(deps: SupervisedBoxDeps): SupervisedBoxes {
  const log = deps.log ?? ((l: string) => console.log(l));
  const boxDir = deps.boxDir ?? env.box.dir();
  const client = new BoxdClient({ socketPath: deps.socketPath ?? env.box.boxdSocket() });
  const clis = cliDirs();
  /** One line per host and reason, per session, per minute: a tool that retries must not fill the log. */
  const lastLogged = new Map<string, number>();
  const onEgressRefuse = (sessionId: string, e: { host: string; port: number; reason: EgressRefusal }): void => {
    const key = `${sessionId}\u0000${e.host}\u0000${e.reason}`;
    const now = Date.now();
    if (now - (lastLogged.get(key) ?? 0) < 60_000) return;
    lastLogged.set(key, now);
    if (lastLogged.size > 5_000) lastLogged.clear();
    log(`[box] egress refused session=${sessionId} host=${e.host || "?"} port=${e.port} reason=${e.reason}`);
  };

  const driver = makeSupervisedDriver(deps.tier, {
    client,
    boxDir,
    egressRules: (sessionId) => deps.egressOf(sessionId),
    provider: async (sessionId) => providerRouteOf(await deps.childEnvOf(sessionId)),
    refuseHosts: nodeServiceHosts(),
    allowedCommands: () => clis.map((d) => join(d, "claude")),
    onEgressRefuse,
    log,
  });

  const probe = async () => client.request("probe", {}, { timeoutMs: 20_000 });
  const mb = (bytes: number | null): number | null => (bytes === null ? null : Math.floor(bytes / (1024 * 1024)));

  const opts: NodeBoxOpts = {
    ...deps.base,
    tier: deps.tier,
    driver,
    async specFor(sessionId, box, ctx) {
      const cwd = await deps.workingDirOf(sessionId);
      if (!cwd) throw new BootFailure("BOX_UNAVAILABLE", "the session has no working directory to give its box");
      const persona = deps.personaFor(sessionId) ?? "default";
      const pluginDirs = [homePluginDirFor(persona) ?? paths.home, BUILTIN_PLUGIN_DIR, ...loadInstalledPluginPaths().map((p) => p.path)];
      const pluginRoot = process.env.SLAUDE_PLUGIN_ROOT?.trim();
      if (pluginRoot) pluginDirs.push(pluginRoot);
      const scratchDir = deps.scratchDirOf(sessionId);
      const configDir = deps.configDirOf(sessionId, persona);
      // A credential file this node seeded while the session ran unboxed: it is the node's copy of tokens the
      // gateway holds, and it must not be in a directory that is about to be given to a box.
      for (const name of CONFIG_CREDENTIAL_FILES) {
        if (!existsSync(join(configDir, name))) continue;
        rmSync(join(configDir, name), { force: true });
        log(`[box] session=${sessionId}: removed ${name} from its config directory before giving it to a box`);
      }
      const spec = buildBoxSpec({
        sessionId,
        tenantId: deps.tenantFor(sessionId) ?? "default",
        persona,
        box,
        homeDir: ctx.homeDir,
        cwd,
        configDir,
        ...(scratchDir ? { scratchDir } : {}),
        pluginDirs,
        slaudeHome: paths.home,
        cliDir: clis[0] ?? "",
      });
      // Every installed CLI package: the SDK picks the one for this machine's libc.
      for (const d of clis.slice(1)) spec.mounts.push({ source: d, target: d, mode: "ro" });
      return spec;
    },
    packer: deps.base?.packer ?? client.packer(join(boxDir, "pack-spool")),
    limits:
      deps.base?.limits ??
      (async () => {
        const p = await probe();
        return { memoryLimitMb: mb(p.memoryLimitBytes), diskMb: mb(p.diskBytes) };
      }),
    memoryUsedMb: deps.base?.memoryUsedMb ?? (async () => mb((await probe()).memoryUsedBytes)),
  };

  return {
    opts,
    driver,
    packIndexDir: join(boxDir, "pack-index"),
    alive: () => client.alive(),
    async reloaded(tenantId) {
      for (const sid of deps.sessionsOf(tenantId)) {
        try {
          const n = await driver.closeDisallowed(sid);
          if (n > 0) log(`[box] session=${sid}: ${n} open connection(s) ended, the box's new egress rules refuse their host`);
        } catch {
          /* a session that just ended */
        }
      }
    },
    close: () => client.close(),
  };
}
