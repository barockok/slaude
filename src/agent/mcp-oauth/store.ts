/**
 * Writer for claude-code's native MCP OAuth credential store
 * (`<CLAUDE_CONFIG_DIR>/.credentials.json` → `mcpOAuth[key]`).
 *
 * The CLI owns refresh/reconnect off this entry (clientId + refreshToken). slaude
 * only writes the initial grant here; everything after is the CLI's. The key/format
 * are reverse-engineered from cli.js (`a2A` + the file store `V_1`) and pinned by a
 * golden test — if the CLI changes its format, that canary fails loudly.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/** Subset of an MCP HTTP server config that participates in the store key. */
export interface OAuthServerConfig {
  type: string; // "http"
  url: string;
  headers?: Record<string, string>;
}

export interface OAuthTokens {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  /** Seconds; defaults to 3600 when undefined (matches the CLI). */
  expiresIn?: number;
}

/** Replica of the CLI's `a2A`: `${name}|sha256(JSON.stringify({type,url,headers||{}})).hex[0:16]`.
 *  NOTE: plain JSON.stringify with FIXED field order — do NOT sort keys. */
export function oauthKey(serverName: string, cfg: OAuthServerConfig): string {
  const body = JSON.stringify({ type: cfg.type, url: cfg.url, headers: cfg.headers || {} });
  const hash = createHash("sha256").update(body).digest("hex").substring(0, 16);
  return `${serverName}|${hash}`;
}

/** Read-modify-write the credential file: set mcpOAuth[key], preserve every other
 *  key, write atomically (temp + rename) at 0600. `now` is injectable for tests. */
export function writeEntry(
  configDir: string,
  serverName: string,
  cfg: OAuthServerConfig,
  tokens: OAuthTokens,
  now: () => number = Date.now,
): void {
  const path = join(configDir, ".credentials.json");
  let current: Record<string, any> = {};
  if (existsSync(path)) {
    try { current = JSON.parse(readFileSync(path, "utf8")) || {}; } catch { current = {}; }
  }
  const key = oauthKey(serverName, cfg);
  const expiresAt = now() + (tokens.expiresIn ?? 3600) * 1000;
  const next = {
    ...current,
    mcpOAuth: {
      ...(current.mcpOAuth || {}),
      [key]: {
        serverName,
        serverUrl: cfg.url,
        clientId: tokens.clientId,
        clientSecret: tokens.clientSecret,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt,
      },
    },
  };
  // Atomic write so a concurrent CLI refresh-write can't observe a torn file.
  const tmp = join(configDir, `.credentials.json.tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
