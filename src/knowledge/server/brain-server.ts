// The separate brain process. Boots the local gbrain engine and serves the
// dumb-engine MCP surface (brain_op / brain_admin_op) over Streamable HTTP,
// guarded by an OAuth resource-server JWT check (Keycloak first).
//
// slaude (SLAUDE_BRAIN_MODE=remote) is the only client; it proxies already-scoped
// calls here. This process owns the brain home / PGLite DB (one writer).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { brainServerConfig, type BrainServerConfig } from "../brain-config";
import {
  PROTECTED_RESOURCE_PATH,
  guardConfigError,
  protectedResourceMetadata,
  verifyBearer,
  type GuardConfig,
} from "./oauth-guard";
import { registerBrainTools, type BrainServerDeps } from "./tools";

const MCP_PATH = "/mcp";

export interface StartedBrainServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export interface StartBrainOpts {
  /** Boot the gbrain engine + ensure sources before serving (real entrypoint). */
  boot?: boolean;
}

function guardConfig(cfg: BrainServerConfig): GuardConfig {
  return {
    issuer: cfg.issuer,
    audience: cfg.audience,
    publicUrl: cfg.publicUrl,
    authDisabled: cfg.authDisabled,
  };
}

/** Handle one MCP request statelessly: fresh server+transport per request. */
async function handleMcp(req: Request, deps: BrainServerDeps): Promise<Response> {
  const server = new McpServer({ name: "slaude-brain", version: "0.2.0" });
  registerBrainTools(server, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  // Close after the response is fully constructed (stateless — nothing to retain).
  void server.close();
  return res;
}

export async function startBrainServer(
  cfg: BrainServerConfig,
  deps?: BrainServerDeps,
  opts: StartBrainOpts = {},
): Promise<StartedBrainServer> {
  // Default deps wire the real local engine primitives. Imported lazily so test
  // callers that pass deps never pull the gbrain engine into the bundle.
  let resolvedDeps = deps;
  if (!resolvedDeps) {
    const brain = await import("../brain");
    resolvedDeps = {
      runScoped: brain.runScopedOp,
      runAdmin: brain.runAdminOp,
    };
  }

  if (opts.boot) {
    const brain = await import("../brain");
    await brain.getBrain();
    await brain.ensureSources();
  }

  const guard = guardConfig(cfg);
  // Refuse to start in an insecure configuration (auth on, but issuer/audience
  // unset would make every well-formed token pass).
  const cfgErr = guardConfigError(guard);
  if (cfgErr) throw new Error(`[brain-server] insecure OAuth config: ${cfgErr}`);

  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === PROTECTED_RESOURCE_PATH) {
        return Response.json(protectedResourceMetadata(guard));
      }

      if (url.pathname === MCP_PATH) {
        const auth = await verifyBearer(req.headers.get("authorization"), guard);
        if (!auth.ok) {
          return new Response("unauthorized", {
            status: auth.status,
            headers: auth.wwwAuth ? { "www-authenticate": auth.wwwAuth } : undefined,
          });
        }
        return handleMcp(req, resolvedDeps!);
      }

      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port;
  const base = cfg.publicUrl?.replace(/\/+$/, "") ?? `http://${cfg.host}:${port}`;
  return {
    url: `${base}${MCP_PATH}`,
    port,
    stop: async () => {
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  const cfg = brainServerConfig();
  startBrainServer(cfg, undefined, { boot: true })
    .then((s) => {
      console.log(`[brain-server] listening on ${cfg.host}:${s.port} (mcp ${MCP_PATH})`);
      if (cfg.authDisabled) console.warn("[brain-server] OAuth DISABLED (SLAUDE_BRAIN_AUTH_DISABLED=1)");
      else console.log(`[brain-server] OAuth issuer=${cfg.issuer ?? "(unset!)"} audience=${cfg.audience ?? "(unset!)"}`);
    })
    .catch((e) => {
      console.error("[brain-server] failed to start:", e);
      process.exit(1);
    });
}
