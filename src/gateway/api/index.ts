/**
 * Gateway REST /v1 (node-facing, spec §3).
 *
 * Router: a declarative route table over Bun's native Request/Response (node
 * labels spec §4.3). Every route declares its methods, path pattern, auth
 * requirement and a REQUIRED gate decision (`label`, or `none` with a written
 * reason); tests/gateway/api/route-table.test.ts enumerates the table and fails
 * on a route without one. Matching is by segment count and literal segments
 * over the path split on "/" with empty segments dropped, first match wins; a
 * path match with a wrong method is 405, no match is 404.
 *
 * Auth: every /v1 request is authenticated as a node (authenticateNode: a
 * signed node credential or the legacy shared token), on every request.
 * `node+job` routes additionally need the per-job JWT (X-Slaude-Job). A
 * `label` gate then requires the token's signed `label` among the node's
 * labels, before the handler runs.
 *
 *   GET   /v1/node/whoami             the caller's verified identity      (node)
 *   GET   /v1/sessions/:id            session row                         (node+job, label)
 *   PATCH /v1/sessions/:id            update started/model/mode           (same)
 *   GET   /v1/tenants/:id/runtime     runtime bundle (legacy route)       (node+job, label)
 *   GET   /v1/tenants/:id/personas/:p/runtime   runtime bundle, ETag/304  (node+job, label)
 *   GET   /v1/tenants/:id/mcp-credentials       the runAs owner's MCP access tokens (node+job, label)
 *   POST  /v1/tenants/:id/mcp-credentials/refresh   refresh one server for that owner (same)
 *   GET   /v1/tenants/:id/remote-key  runAs user's SSH key for a remote-mode turn (node+job, label)
 *   GET   /v1/pending/:id             30s long-poll, 204 timeout          (node+job, label; session-bound;
 *                                     tokenless only for the legacy identity, see below)
 *   POST  /v1/jobs/:id/ack|fail       telemetry only                      (node)
 *   POST  /v1/jobs/:id/token-refresh  fresh token, same claims            (node+job within grace, label)
 *   POST  /v1/jobs/:id/token-reissue  re-mint a long-queued job's token   (node+job any age, label)
 *   POST  /v1/tools/memory/prefetch|sync  episodic memory, run on the gateway (node+job, label)
 *   POST  /v1/tools/:server/:tool     contract-validated tool call        (node+job, label)
 */
import {
  authenticateNode,
  gateLabel,
  JOB_HEADER,
  requireJobToken,
  type JobClaims,
  type NodeIdentity,
} from "./auth";
import { env } from "../../config/env";
import { handleSession } from "./sessions";
import { handleTenantRuntime } from "./tenants";
import { handleMcpCredentials, handleMcpCredentialRefresh, type CredentialRefresher } from "./mcp-credentials";
import { handleRemoteKey } from "./remote-key";
import { defaultCredentialRefresher } from "../core/credential-refresh";
import { handlePending, type PendingOptions } from "./pending";
import { handleJobEvent, handleTokenRefresh, handleTokenReissue, REFRESH_GRACE_SEC, type JobLookup } from "./jobs";
import { executeToolCall } from "./tools";
import type { ToolPlaneDeps } from "./tools/deps";
import { defaultPendingSource, type PendingSource } from "./pending-source";
import { json, methodNotAllowed, notFound, readBodyCapped, readJson } from "./http";
import { defaultMemoryPlane, handleMemory, MEMORY_BODY_MAX_BYTES, type MemoryPlane } from "./memory";
import { PersonaNotLiveError } from "../../persona/registry";
import { memory as processMemory } from "../../memory";

export interface V1Api {
  /** Handle a request; null when the path is not under /v1 (caller falls through). */
  fetch(req: Request): Promise<Response | null>;
  /** The pending-gate source behind /v1/pending (test + resolver seam). */
  pendingSource: PendingSource;
}

export interface V1Options {
  tools: ToolPlaneDeps;
  pendingSource?: PendingSource;
  pending?: PendingOptions;
  /** MCP credential refresher. Default: single-flight across replicas on Redis
   *  in the gateway role, in-process otherwise. */
  credentialRefresher?: CredentialRefresher;
  /** Episodic memory for node turns. Default: this process's memory provider,
   *  gated through `tools` like the KB tools; null = not served (404). */
  memory?: MemoryPlane | null;
  /** Turn-queue lookup for token-reissue. Absent (mono) = no job is reissuable. */
  jobLookup?: JobLookup;
}

export type RouteAuth = "node" | "node+job";
export type RouteGate = "label" | "none";

export interface RouteCtx {
  req: Request;
  /** Path segments after "v1", as matched (raw, not URI-decoded). */
  seg: string[];
  node: NodeIdentity;
  /** The verified job token; present on node+job routes unless optional and absent. */
  claims?: JobClaims;
  /** Credential expiry (unix seconds) for a signed credential. */
  expiresAt?: number;
}

export interface RouteDef {
  /** Stable name, used in logs and tests. */
  name: string;
  methods: readonly string[];
  /** Segments after "v1"; ":x" matches any one segment, "a|b" either literal. */
  pattern: readonly string[];
  auth: RouteAuth;
  gate: RouteGate;
  /** Required when gate is "none": why this route needs no label gate. */
  reason?: string;
  /** node+job only: expiry forgiven by this many seconds (token-refresh). */
  jobGraceSec?: number;
  /** node+job only: a missing job token is passed to the handler as no claims. */
  jobOptional?: boolean;
  handle(ctx: RouteCtx): Promise<Response>;
}

const tenantScoped = (claims: JobClaims, tenant: string): Response | null =>
  claims.tenant !== tenant ? json(403, { error: "job token is not scoped to this tenant" }) : null;

/** The route table. Order matters only between patterns that overlap: only
 *  "tools.memory" and "tools" do, and the narrower one comes first. */
export function v1Routes(opts: V1Options, pendingSource: PendingSource): RouteDef[] {
  const credentialRefresher = (): CredentialRefresher => opts.credentialRefresher ?? defaultCredentialRefresher();
  const memoryPlane = opts.memory === undefined ? defaultMemoryPlane(opts.tools, () => processMemory) : (opts.memory ?? undefined);
  let warnedTokenlessPending = false;
  return [
    {
      name: "node.whoami",
      methods: ["GET"],
      pattern: ["node", "whoami"],
      auth: "node",
      gate: "none",
      reason: "returns only the caller's own verified identity; no persona data",
      handle: async ({ node, expiresAt }) =>
        json(200, {
          id: node.id,
          labels: [...node.labels].sort(),
          legacy: node.legacy,
          expiresInSec: expiresAt === undefined ? null : Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
        }),
    },
    {
      name: "sessions",
      methods: ["GET", "PATCH"],
      pattern: ["sessions", ":id"],
      auth: "node+job",
      gate: "label",
      handle: async ({ req, seg, claims }) => handleSession(req, seg[1]!, claims!),
    },
    {
      // Legacy route, kept so gateway and nodes can roll independently in
      // either order. The persona comes from the token's own claim rather than
      // a hardcoded "default": a node that predates the persona route still
      // gets the bundle its job is actually scoped to.
      name: "tenants.runtime",
      methods: ["GET"],
      pattern: ["tenants", ":tenant", "runtime"],
      auth: "node+job",
      gate: "label",
      handle: async ({ req, seg, claims }) =>
        tenantScoped(claims!, seg[1]!) ?? handleTenantRuntime(req, seg[1]!, claims!.persona || "default"),
    },
    {
      // The owner is the token's signed runAs claim and nothing else: there is
      // no owner in the path to tamper with. Deliberately not part of the
      // runtime bundle, which is keyed on (tenant, persona) and ETag-cached.
      name: "tenants.mcp-credentials",
      methods: ["GET"],
      pattern: ["tenants", ":tenant", "mcp-credentials"],
      auth: "node+job",
      gate: "label",
      handle: async ({ req, seg, claims }) =>
        tenantScoped(claims!, seg[1]!) ?? handleMcpCredentials(req, claims!, credentialRefresher()),
    },
    {
      // The runAs user's SSH key, only for a token whose signed claims carry a
      // remote target (remote spec §4.5).
      name: "tenants.remote-key",
      methods: ["GET"],
      pattern: ["tenants", ":tenant", "remote-key"],
      auth: "node+job",
      gate: "label",
      handle: async ({ req, seg, claims }) => tenantScoped(claims!, seg[1]!) ?? handleRemoteKey(req, claims!),
    },
    {
      // Refresh one server for the token's own runAs owner. The gateway is the
      // only refresher: nodes hold access tokens only.
      name: "tenants.mcp-credentials.refresh",
      methods: ["POST"],
      pattern: ["tenants", ":tenant", "mcp-credentials", "refresh"],
      auth: "node+job",
      gate: "label",
      handle: async ({ req, seg, claims }) =>
        tenantScoped(claims!, seg[1]!) ?? handleMcpCredentialRefresh(req, claims!, credentialRefresher()),
    },
    {
      // The bundle is per persona, so the token must be scoped to BOTH
      // dimensions, not just the tenant.
      name: "tenants.personas.runtime",
      methods: ["GET"],
      pattern: ["tenants", ":tenant", "personas", ":persona", "runtime"],
      auth: "node+job",
      gate: "label",
      handle: async ({ req, seg, claims }) => {
        const scoped = tenantScoped(claims!, seg[1]!);
        if (scoped) return scoped;
        if (claims!.persona !== seg[3]!) return json(403, { error: "job token is not scoped to this persona" });
        return handleTenantRuntime(req, seg[1]!, seg[3]!);
      },
    },
    {
      // Bound to the caller's session (spec §4.4). Old nodes send no job token
      // here, so a tokenless call is accepted only from the legacy identity,
      // and only while SLAUDE_NODE_ALLOW_TOKENLESS_PENDING is on.
      name: "pending",
      methods: ["GET"],
      pattern: ["pending", ":id"],
      auth: "node+job",
      gate: "label",
      jobOptional: true,
      handle: async ({ seg, node, claims }) => {
        if (claims) return handlePending(seg[1]!, pendingSource, opts.pending, claims.session);
        if (!node.legacy || !env.allowTokenlessPending()) {
          return json(401, { error: "invalid job token: missing" });
        }
        if (!warnedTokenlessPending) {
          warnedTokenlessPending = true;
          console.warn(
            "[v1] a legacy node polled /v1/pending without a job token; this is deprecated and will be refused (SLAUDE_NODE_ALLOW_TOKENLESS_PENDING)",
          );
        }
        return handlePending(seg[1]!, pendingSource, opts.pending);
      },
    },
    {
      name: "jobs.event",
      methods: ["POST"],
      pattern: ["jobs", ":id", "ack|fail"],
      auth: "node",
      gate: "none",
      reason: "telemetry only: returns nothing about any persona; the logged body is bounded",
      handle: async ({ req, seg, node }) => handleJobEvent(req, seg[1]!, seg[2] as "ack" | "fail", node.id),
    },
    {
      // Auth is the ORIGINAL job token, expiry forgiven within the grace.
      name: "jobs.token-refresh",
      methods: ["POST"],
      pattern: ["jobs", ":id", "token-refresh"],
      auth: "node+job",
      gate: "label",
      jobGraceSec: REFRESH_GRACE_SEC,
      handle: async ({ req, seg }) => handleTokenRefresh(req, seg[1]!),
    },
    {
      // The job's own token at any age; bounded by the job's age instead.
      name: "jobs.token-reissue",
      methods: ["POST"],
      pattern: ["jobs", ":id", "token-reissue"],
      auth: "node+job",
      gate: "label",
      jobGraceSec: Number.MAX_SAFE_INTEGER,
      handle: async ({ req, seg, claims }) => handleTokenReissue(req, seg[1]!, claims!, opts.jobLookup),
    },
    {
      // Must precede "tools", whose pattern also matches this path. Label-gated
      // like every tool call: memory is persona data. Session, persona and
      // scope come from the token, never the body.
      name: "tools.memory",
      methods: ["POST"],
      pattern: ["tools", "memory", "prefetch|sync"],
      auth: "node+job",
      gate: "label",
      handle: async ({ req, seg, claims }) => {
        const text = await readBodyCapped(req, MEMORY_BODY_MAX_BYTES);
        if (text === null) return json(413, { error: "body too large" });
        let body: unknown = {};
        try {
          if (text.trim()) body = JSON.parse(text);
        } catch {
          return json(400, { error: "malformed JSON body" });
        }
        return handleMemory(seg[2]!, body, claims!, memoryPlane);
      },
    },
    {
      name: "tools",
      methods: ["POST"],
      pattern: ["tools", ":server", ":tool"],
      auth: "node+job",
      gate: "label",
      handle: async ({ req, seg, claims }) => {
        const body = await readJson(req);
        if (body === null) return json(400, { error: "malformed JSON body" });
        return executeToolCall(seg[1]!, seg[2]!, body, claims!, opts.tools);
      },
    },
  ];
}

/** Does `seg` (after "v1") match the pattern? */
export function matchRoute(route: Pick<RouteDef, "pattern">, seg: readonly string[]): boolean {
  if (route.pattern.length !== seg.length) return false;
  for (let i = 0; i < seg.length; i++) {
    const p = route.pattern[i]!;
    if (p.startsWith(":")) continue;
    // "a|b" is a literal with alternatives.
    if (!p.split("|").includes(seg[i]!)) return false;
  }
  return true;
}

/** Body `code` of the 409 a retired persona's job gets on any /v1 route. */
export const PERSONA_NOT_LIVE_CODE = "PERSONA_NOT_LIVE";

export function createV1Api(opts: V1Options): V1Api {
  const pendingSource = opts.pendingSource ?? defaultPendingSource();
  const routes = v1Routes(opts, pendingSource);

  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/v1" && !url.pathname.startsWith("/v1/")) return null;

    const auth = await authenticateNode(req);
    if (!auth.ok) return auth.response;

    const seg = url.pathname.split("/").filter(Boolean).slice(1); // after "v1"

    try {
      const route = routes.find((r) => matchRoute(r, seg));
      if (!route) return notFound();
      if (!route.methods.includes(req.method)) return methodNotAllowed();

      let claims: JobClaims | undefined;
      if (route.auth === "node+job") {
        const tokenPresent = !!req.headers.get(JOB_HEADER);
        if (tokenPresent || !route.jobOptional) {
          const job = requireJobToken(req, route.jobGraceSec ? { graceSec: route.jobGraceSec } : {});
          if ("response" in job) return job.response;
          claims = job.claims;
        }
        if (claims && route.gate === "label") {
          const denied = gateLabel(auth.node, claims, route.name);
          if (denied) return denied;
        }
      }
      return await route.handle({ req, seg, node: auth.node, claims, expiresAt: auth.expiresAt });
    } catch (e) {
      // A retired persona's job: a definitive refusal, not a server fault. A
      // 4xx is never retried by a node, and one line (no stack) is enough.
      if (e instanceof PersonaNotLiveError) {
        console.warn(`[v1] ${req.method} ${url.pathname} refused: persona '${e.persona}' is not live`);
        return json(409, { error: "persona is not live", code: PERSONA_NOT_LIVE_CODE });
      }
      // Log the real error server-side; never reflect internals (messages can
      // carry paths, SQL, or provider detail) to the caller.
      console.error(`[v1] ${req.method} ${url.pathname} failed:`, e);
      return json(500, { error: "internal" });
    }
  }

  return { fetch, pendingSource };
}
