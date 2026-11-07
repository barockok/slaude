/**
 * Fetch wrapper shared by the console and the portal.
 *
 * - JSON in and out; cookies ride same-origin (identity is an HttpOnly session
 *   cookie, never a header or a URL parameter).
 * - Every non-GET carries the app's anti-CSRF header (`x-panel-csrf: 1` or
 *   `x-portal-csrf: 1`); the server refuses mutating requests without it, and a
 *   cross-site page cannot set a custom header without a preflight.
 * - A 401 gets exactly one refresh attempt (POST <base>/auth/refresh) and one
 *   retry; a second 401 sends the browser to <base>/auth/login with a returnTo.
 * - Failures throw ApiError with the status and the server's `{ error }` text.
 */

export type AppName = "panel" | "portal";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Do not try a refresh or redirect on 401; just throw. */
  noAuthRedirect?: boolean;
}

export interface ApiClient {
  base: string;
  loginUrl(returnTo?: string): string;
  request<T>(path: string, opts?: RequestOptions): Promise<T>;
  get<T>(path: string, opts?: Omit<RequestOptions, "method" | "body">): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
  signOut(): Promise<void>;
}

/** Paths are relative to the mount, e.g. "/api/agents" or "/auth/me". */
export function createApi(app: AppName): ApiClient {
  const base = `/${app}`;
  const csrf = { [`x-${app}-csrf`]: "1" };

  const loginUrl = (returnTo = location.pathname + location.search) =>
    `${base}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  function toLogin(): never {
    location.assign(loginUrl());
    throw new ApiError(401, "Your session has expired. Signing you in again.");
  }

  function send(path: string, opts: RequestOptions): Promise<Response> {
    const method = (opts.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET" && method !== "HEAD") Object.assign(headers, csrf);
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return fetch(base + path, {
      method,
      headers,
      credentials: "same-origin",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  }

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    let res = await send(path, opts);
    if (res.status === 401 && !opts.noAuthRedirect) {
      const refreshed = await fetch(`${base}/auth/refresh`, {
        method: "POST",
        headers: { ...csrf },
        credentials: "same-origin",
      }).catch(() => null);
      if (!refreshed?.ok) toLogin();
      res = await send(path, opts);
      if (res.status === 401) toLogin();
    }
    const text = res.status === 204 ? "" : await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const msg =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Request failed (${res.status})`;
      throw new ApiError(res.status, msg, body);
    }
    return body as T;
  }

  return {
    base,
    loginUrl,
    request,
    get: (path, opts) => request(path, { ...opts, method: "GET" }),
    post: (path, body) => request(path, { method: "POST", body }),
    put: (path, body) => request(path, { method: "PUT", body }),
    patch: (path, body) => request(path, { method: "PATCH", body }),
    del: (path, body) => request(path, { method: "DELETE", body }),
    async signOut() {
      await fetch(`${base}/auth/logout`, { method: "POST", headers: { ...csrf }, credentials: "same-origin" }).catch(() => null);
      location.assign(`${base}/auth/login`);
    },
  };
}
