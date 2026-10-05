#!/usr/bin/env bun
// Sync the local persona set through the gateway's own /deploy endpoint. Runs
// INSIDE a gateway pod (personas.sh and verify-ha.sh copy it there), so the
// soul-extraction cache it seeds is that pod's own (pod-local) cache, signed
// with that pod's master key, and the sync it posts lands on the same pod. No
// model is called.
//
//   bun personas.ts [--revision <r>] [--token-var <NAME>] [--no-seed]   < payload.json
//
// stdin: { "personas": [{ name, soul, slackUserId?, runsOn?, kbSources?, mcp? }],
//          "manager"?: "U..." }
//
// Each persona gets a `provider` block of Vault references to its own secret
// (vault://secret/slaude/personas/<name>#<field>), one field per provider
// variable this gateway pod has (the same provider.env vault.sh seeds from);
// with none, an api_key reference (vault.sh seeds a placeholder). `model` is
// the cluster default, so the sync does not warn about it.
//
// The bearer is read from the pod's own environment by NAME (default
// SLAUDE_DEPLOY_TOKEN), never from stdin or a command line. Output, one JSON
// line: { status, error?, warnings, souls: { <name>: <sha256 prefix> } }. The
// soul prefixes are what a node logs at session boot (soul=<12 hex>).
import { createHash } from "node:crypto";
import { writeSoulCacheEntry } from "/app/src/soul/extract.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const revision = flag("--revision") ?? `local-${Date.now()}`;
const tokenVar = flag("--token-var") ?? "SLAUDE_DEPLOY_TOKEN";
const seed = !args.includes("--no-seed");
if (!/^[A-Z][A-Z0-9_]*$/.test(tokenVar)) {
  console.error("--token-var needs a variable name");
  process.exit(2);
}

type In = { name: string; soul: string; slackUserId?: string; runsOn?: string; kbSources?: string[]; mcp?: unknown };
const input = JSON.parse(await Bun.stdin.text()) as { personas: In[]; manager?: string };

// The provider fields this pod's own provider.env has, mirrored as Vault refs.
const FIELDS: Array<[string, string, string]> = [
  ["ANTHROPIC_API_KEY", "apiKey", "api_key"],
  ["ANTHROPIC_AUTH_TOKEN", "authToken", "auth_token"],
  ["CLAUDE_CODE_OAUTH_TOKEN", "oauthToken", "oauth_token"],
];
function provider(name: string): Record<string, string> {
  const ref = (field: string) => `vault://secret/slaude/personas/${name}#${field}`;
  const out: Record<string, string> = {};
  for (const [envName, key, field] of FIELDS) if (process.env[envName]) out[key] = ref(field);
  if (Object.keys(out).length === 0) out.apiKey = ref("api_key");
  if (process.env.ANTHROPIC_BASE_URL) out.baseUrl = ref("base_url");
  return out;
}

const souls: Record<string, string> = {};
const personas = input.personas.map((p) => {
  souls[p.name] = createHash("sha256").update(p.soul).digest("hex").slice(0, 12);
  return {
    ...p,
    provider: provider(p.name),
    ...(process.env.SLAUDE_MODEL ? { model: process.env.SLAUDE_MODEL } : {}),
  };
});

if (seed) {
  for (const p of personas) {
    const manager = input.manager && p.soul.includes(input.manager) ? { userId: input.manager } : {};
    if (!writeSoulCacheEntry(p.soul, { approvers: [], manager } as never)) {
      console.log(JSON.stringify({ status: 0, error: `soul cache entry for '${p.name}' not written (master key unusable)` }));
      process.exit(1);
    }
  }
}

const token = process.env[tokenVar];
if (!token) {
  console.log(JSON.stringify({ status: "unset", warnings: [], souls }));
  process.exit(0);
}
const kb = personas.some((p) => p.kbSources !== undefined);
const body = {
  // 3 when any persona sets kbSources (WS-C), else 2 (provider, runsOn).
  version: kb ? 3 : 2,
  revision,
  committedAt: new Date().toISOString(),
  personas,
};
const res = await fetch("http://localhost:8080/deploy/v1/tenants/default/personas", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
let report: any = {};
try {
  report = await res.json();
} catch {
  /* not JSON */
}
console.log(
  JSON.stringify({
    status: res.status,
    ...(report?.error ? { error: String(report.error).slice(0, 300) } : {}),
    warnings: Array.isArray(report?.warnings) ? report.warnings : [],
    souls,
  }),
);
process.exit(0);
