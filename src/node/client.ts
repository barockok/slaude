/**
 * Typed fetch wrapper for the gateway REST /v1 (spec §3, §6) — the node's only
 * path to the control plane and tool plane.
 *
 *   - `Authorization: Bearer <SLAUDE_NODE_TOKEN>` on every request.
 *   - `X-Slaude-Job` per-job JWT where the endpoint demands it (sessions,
 *     tenants, tools) — passed per call, never stored globally.
 *   - Retries with exponential backoff on network errors and 5xx; NEVER on
 *     4xx (those are contract violations or auth failures — retrying lies).
 *   - ETag cache for the tenant runtime bundle (If-None-Match / 304).
 */
import { JOB_HEADER } from "../gateway/api/auth";
import type { RuntimeBundle } from "../gateway/api/tenants";

export interface NodeClientOpts {
  /** Gateway base URL (SLAUDE_GATEWAY_URL), e.g. http://gateway:8080 */
  baseUrl?: string;
  /** Static bearer (SLAUDE_NODE_TOKEN). */
  token?: string;
  /** Retry attempts for 5xx/network (total tries = attempts). Default 3. */
  attempts?: number;
  /** Base backoff delay in ms (doubles per retry). Default 250. */
  baseDelayMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Session row view served by GET /v1/sessions/:id. */
export interface SessionView {
  id: string;
  model: string;
  working_dir: string;
  permission_mode: string;
  persona_id: string;
  engaged: number;
  claude_started: number;
  status: string;
  title: string | null;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  created_at: number;
  updated_at: number;
}

export interface PendingView {
  status: string;
  payload: unknown;
  resolvedBy: string | null;
}

/** MCP-shaped tool-plane result. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export class NodeApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    message?: string,
  ) {
    super(message ?? `gateway /v1 request failed: ${status} ${body.slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NodeClient {
  #base: string;
  #token: string;
  #attempts: number;
  #baseDelayMs: number;
  #fetch: typeof fetch;
  /** tenantId → cached runtime bundle + its ETag. */
  #runtimeCache = new Map<string, { etag: string; bundle: RuntimeBundle }>();

  constructor(opts: NodeClientOpts = {}) {
    this.#base = (opts.baseUrl ?? process.env.SLAUDE_GATEWAY_URL ?? "http://localhost:8080").replace(/\/+$/, "");
    this.#token = opts.token ?? process.env.SLAUDE_NODE_TOKEN ?? "";
    this.#attempts = Math.max(1, opts.attempts ?? 3);
    this.#baseDelayMs = opts.baseDelayMs ?? 250;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /** Low-level request with bearer + optional job token + retry policy. */
  async request(
    path: string,
    o: { method?: string; body?: unknown; jobToken?: string; headers?: Record<string, string>; retry?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.jobToken ? { [JOB_HEADER]: o.jobToken } : {}),
      ...(o.headers ?? {}),
    };
    const retry = o.retry ?? true;
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.#attempts; attempt++) {
      if (attempt > 0) await sleep(this.#baseDelayMs * 2 ** (attempt - 1));
      try {
        const res = await this.#fetch(`${this.#base}${path}`, {
          method: o.method ?? "GET",
          headers,
          ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        });
        // 5xx: transient server trouble — retry. Everything else returns.
        if (res.status >= 500 && retry && attempt < this.#attempts - 1) {
          lastErr = new NodeApiError(res.status, await res.text().catch(() => ""));
          continue;
        }
        return res;
      } catch (e) {
        // Network-level failure (gateway restarting, DNS, conn refused).
        lastErr = e;
        if (!retry || attempt === this.#attempts - 1) throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async #json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new NodeApiError(res.status, await res.text().catch(() => ""));
    return (await res.json()) as T;
  }

  async getSession(id: string, jobToken: string): Promise<SessionView | null> {
    const res = await this.request(`/v1/sessions/${id}`, { jobToken });
    if (res.status === 404) return null;
    return this.#json<SessionView>(res);
  }

  async patchSession(
    id: string,
    patch: { claude_started?: boolean | 0 | 1; model?: string; permission_mode?: string; status?: string },
    jobToken: string,
  ): Promise<SessionView> {
    const res = await this.request(`/v1/sessions/${id}`, { method: "PATCH", body: patch, jobToken });
    return this.#json<SessionView>(res);
  }

  /**
   * Tenant runtime bundle with node-side ETag cache: sends If-None-Match, a
   * 304 serves the cached copy. `bust()` drops a tenant's cache (reload
   * pub/sub, spec §3 "Direction").
   */
  async getRuntime(tenantId: string, jobToken: string): Promise<RuntimeBundle> {
    const cached = this.#runtimeCache.get(tenantId);
    const res = await this.request(`/v1/tenants/${tenantId}/runtime`, {
      jobToken,
      headers: cached ? { "if-none-match": cached.etag } : {},
    });
    if (res.status === 304 && cached) return cached.bundle;
    const bundle = await this.#json<RuntimeBundle>(res);
    const etag = res.headers.get("etag");
    if (etag) this.#runtimeCache.set(tenantId, { etag, bundle });
    return bundle;
  }

  bustRuntime(tenantId: string): void {
    this.#runtimeCache.delete(tenantId);
  }

  /**
   * One long-poll leg on a pending gate. Returns the settled view, or
   * "timeout" (204 — poll again), or "notfound". No retry wrapper: the
   * long-poll IS the retry loop, and a network error should surface to the
   * caller's loop rather than double-wait.
   */
  async getPending(id: string): Promise<PendingView | "timeout" | "notfound"> {
    const res = await this.request(`/v1/pending/${id}`, { retry: false });
    if (res.status === 204) return "timeout";
    if (res.status === 404) return "notfound";
    return this.#json<PendingView>(res);
  }

  /**
   * Tool-plane call. Returns the MCP-shaped result verbatim on 200. A 404
   * (unknown tool / not mounted on this deployment) is folded into an
   * MCP-shaped isError result so shim handlers can hand it to the model
   * as-is; other non-200s throw.
   */
  async postTool(server: string, tool: string, body: unknown, jobToken: string): Promise<ToolResult> {
    const res = await this.request(`/v1/tools/${server}/${tool}`, { method: "POST", body, jobToken });
    if (res.status === 404) {
      const text = await res.text().catch(() => "");
      return { content: [{ type: "text", text: `tool unavailable: ${text.slice(0, 200)}` }], isError: true };
    }
    return this.#json<ToolResult>(res);
  }

  /**
   * Exchange a job's (possibly aging or freshly-expired) token for a new one
   * with identical claims and a full TTL. The original token authenticates
   * the exchange; the gateway enforces the grace window and job binding.
   */
  async refreshJobToken(jobId: string, currentToken: string): Promise<string> {
    const res = await this.request(`/v1/jobs/${jobId}/token-refresh`, { method: "POST", jobToken: currentToken });
    const body = await this.#json<{ jobToken: string }>(res);
    return body.jobToken;
  }

  async ackJob(jobId: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.request(`/v1/jobs/${jobId}/ack`, { method: "POST", body: detail }).catch(() => {});
  }

  async failJob(jobId: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.request(`/v1/jobs/${jobId}/fail`, { method: "POST", body: detail }).catch(() => {});
  }
}
