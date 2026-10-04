/**
 * Guard for the gateway-only list (src/config/gateway-only-env.ts). Every
 * secret-looking variable name the gateway-side code reads must either be on
 * that list (so the node boot check flags it and the agent child never sees it)
 * or on the allowlist below, with the reason it may reach a node. A new secret
 * added to the gateway without a decision fails here.
 *
 * Scanned: src/gateway, src/db, src/knowledge, src/config, src/agent, src/node,
 * src/remote, src/soul, src/memory. Matched: names in
 * `process.env.X`, `process.env["X"]`, `opt("X")`, `req("X")`, `env.X`, and any
 * quoted all-caps literal, whose name contains SECRET, TOKEN, KEY, PASSWORD or _URL.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";

const ROOT = join(import.meta.dir, "../..");
const DIRS = ["src/gateway", "src/db", "src/knowledge", "src/config", "src/agent", "src/node", "src/remote", "src/soul", "src/memory"];
const SECRETISH = /SECRET|TOKEN|KEY|PASSWORD|_URL/;

/** Names that look secret but are not gateway-only, and why. */
const ALLOW: Record<string, string> = {
  // A node holds these legitimately.
  SLAUDE_NODE_TOKEN: "the node's own /v1 credential",
  SLAUDE_REDIS_URL: "nodes run the queues",
  SLAUDE_GATEWAY_URL: "nodes call the gateway; not a secret",
  SLAUDE_NODE_ALLOW_GATEWAY_SECRETS: "the boot check's escape switch; not a secret",
  // Agent provider credentials: the node's provider env fallback, and the child needs them.
  ANTHROPIC_API_KEY: "provider env fallback on nodes",
  ANTHROPIC_AUTH_TOKEN: "provider env fallback on nodes",
  ANTHROPIC_BASE_URL: "provider env fallback on nodes",
  CLAUDE_CODE_OAUTH_TOKEN: "provider env fallback on nodes",
  // Third-party embedding provider keys the brain (gateway) uses. Generic names an
  // operator may also give agent tools on purpose, so they are not scrubbed or
  // flagged; set them on the gateway only for embeddings.
  OPENAI_API_KEY: "generic provider key, operator's choice",
  VOYAGE_API_KEY: "generic provider key, operator's choice",
  GOOGLE_GENERATIVE_AI_API_KEY: "generic provider key, operator's choice",
  OPENROUTER_API_KEY: "generic provider key, operator's choice",
  MINIMAX_API_KEY: "generic provider key, operator's choice",
  TOGETHER_API_KEY: "generic provider key, operator's choice",
  ZEROENTROPY_API_KEY: "generic provider key, operator's choice",
  // Public addresses, not secrets.
  EMBEDDING_URL: "endpoint address",
  LITELLM_BASE_URL: "endpoint address",
  SLACK_OAUTH_REDIRECT_URL: "public callback address",
  SLAUDE_BRAIN_PUBLIC_URL: "public address",
  SLAUDE_BRAIN_URL: "endpoint address",
  SLAUDE_OAUTH_PUBLIC_URL: "public address",
  SLAUDE_OAUTH_REDIRECT_URL: "public callback address",
  SLAUDE_PANEL_PUBLIC_URL: "public address",
  SLAUDE_SLACK_API_URL: "endpoint address (tests point it at a fake)",
  SLAUDE_REDIS_TEST_URL: "test-only",
  // Other.
  SLAUDE_ENCRYPTION_KEY: "the connect broker's key, used by the agent process itself; stripped from the agent child (child-env.ts)",
  SLAUDE_SOUL_PARSE_MAX_TOKENS: "a size limit, not a secret",
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[["'`]([A-Z][A-Z0-9_]+)["'`]\]/g,
  /\b(?:opt|req)\(\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g,
  /\benv\.([A-Z][A-Z0-9_]+)\b/g,
  /["'`]([A-Z][A-Z0-9_]{3,})["'`]/g,
];

function secretishNames(): Map<string, string> {
  const found = new Map<string, string>();
  for (const d of DIRS) {
    for (const f of files(join(ROOT, d))) {
      const text = readFileSync(f, "utf8");
      for (const re of PATTERNS) {
        for (const m of text.matchAll(re)) {
          const name = m[1]!;
          if (SECRETISH.test(name) && !found.has(name)) found.set(name, f.slice(ROOT.length + 1));
        }
      }
    }
  }
  return found;
}

describe("gateway-only list coverage", () => {
  const names = secretishNames();

  test("the scan finds the names it must (sanity)", () => {
    for (const n of ["SLAUDE_MASTER_KEY", "SLAUDE_PANEL_SECRET", "SLAUDE_BRAIN_TOKEN", "SLAUDE_REDIS_URL"]) {
      expect(names.has(n)).toBe(true);
    }
  });

  test("every secret-looking name read by gateway code is gateway-only or allowlisted with a reason", () => {
    const undecided = [...names].filter(([n]) => !isGatewayOnlyEnv(n) && !(n in ALLOW)).map(([n, f]) => `${n} (${f})`);
    expect(undecided).toEqual([]);
  });

  test("no allowlisted name is also gateway-only", () => {
    expect(Object.keys(ALLOW).filter(isGatewayOnlyEnv)).toEqual([]);
  });
});
