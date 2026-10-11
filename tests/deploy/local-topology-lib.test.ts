/**
 * The helpers deploy/k8s-local/lib.sh gives up.sh, personas.sh, vault.sh and
 * the verify scripts for the full topology: minting node credentials with the
 * repo's own CLI, building the persona payload, and the Vault secret each
 * persona gets. Nothing here touches a cluster.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const lib = join(root, "deploy/k8s-local/lib.sh");
const set = join(root, "deploy/k8s-local/personas/local-set.json");
const KEY = "k".repeat(64);
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-topo-lib-"));
  writeFileSync(join(dir, "secrets.env"), `SLAUDE_MASTER_KEY=x\nSLAUDE_NODE_KEY=${KEY}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(body: string, env: Record<string, string> = {}, stdin?: string) {
  const r = Bun.spawnSync(["bash", "-c", `source "${lib}"; die() { echo "DIE: $*" >&2; return 1; }; ${body}`], {
    env: { PATH: process.env.PATH!, HOME: dir, ...env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("mint_node_credential mints with the repo's CLI: a token the same key verifies, for the label asked", () => {
  const r = run(`mint_node_credential "${root}" "${dir}/secrets.env" finance local-finance 30d`);
  expect(r.code).toBe(0);
  const tok = r.out;
  expect(tok).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  // No newline: the value goes into a Secret and becomes a bearer.
  expect(tok.endsWith("\n")).toBe(false);
  const inspect = Bun.spawnSync(["bun", "src/cli/node-token.ts", "inspect", "-"], {
    cwd: root,
    env: { PATH: process.env.PATH!, SLAUDE_HOME: dir, SLAUDE_NODE_KEY: KEY },
    stdin: new TextEncoder().encode(tok),
  });
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout.toString()).toContain("labels=finance");
  expect(inspect.stdout.toString()).toContain("id=local-finance");
  // The key is never printed.
  expect(r.out + r.err).not.toContain(KEY);
});

test("mint_node_credential fails, printing nothing on stdout, without a key", () => {
  writeFileSync(join(dir, "secrets.env"), "SLAUDE_MASTER_KEY=x\n");
  const r = run(`mint_node_credential "${root}" "${dir}/secrets.env" default local-default 30d`);
  expect(r.code).not.toBe(0);
  expect(r.out).toBe("");
});

test("node_credential_days_left reads a valid credential's remaining days, and refuses one under another key", () => {
  const tok = run(`mint_node_credential "${root}" "${dir}/secrets.env" default local-default 30d`).out;
  const ok = run(`node_credential_days_left "${root}" "${dir}/secrets.env" "$TOK"`, { TOK: tok });
  expect(ok.code).toBe(0);
  expect(Number(ok.out.trim())).toBeGreaterThanOrEqual(29);
  writeFileSync(join(dir, "secrets.env"), `SLAUDE_NODE_KEY=${"z".repeat(64)}\n`);
  const bad = run(`node_credential_days_left "${root}" "${dir}/secrets.env" "$TOK"`, { TOK: tok });
  expect(bad.code).not.toBe(0);
  expect(bad.out).toBe("");
});

const payload = (args: string, env: Record<string, string> = {}) => {
  const r = run(`persona_payload "${set}" ${args}`, env);
  return { ...r, json: r.code === 0 ? JSON.parse(r.out) : null };
};

test("persona_payload: the set as synced, knowledge bases left out", () => {
  const { json } = payload("");
  expect(json.personas.map((p: any) => [p.name, p.runsOn ?? "default"])).toEqual([
    ["default", "default"],
    ["alpha", "default"],
    ["beta", "finance"],
  ]);
  expect(json.knowledgeBases).toBeUndefined();
  expect(json._comment).toBeUndefined();
  const beta = json.personas.find((p: any) => p.name === "beta");
  expect(beta.kbSources).toEqual(["kb-local-finance"]);
  expect(beta.mcp.mcpServers.mockmcp.url).toBe("http://mock-mcp:9000/mcp");
  // The placeholder stays a placeholder: the gateway resolves it at sync.
  expect(beta.mcp.mcpServers.mockmcp.headers.Authorization).toBe("Bearer ${PERSONA_BETA_MOCKMCP_TOKEN}");
});

test("persona_payload: relabel, an extra persona, a soul override", () => {
  const { json } = payload(`--relabel beta=default --add verifier=UTESTUSER7 --soul "verifier=Soul V" --soul "default=Soul D"`);
  expect(json.personas.find((p: any) => p.name === "beta").runsOn).toBe("default");
  expect(json.personas.find((p: any) => p.name === "verifier")).toEqual({ name: "verifier", slackUserId: "UTESTUSER7", soul: "Soul V" });
  expect(json.personas.find((p: any) => p.name === "default").soul).toBe("Soul D");
});

test("persona_payload refuses a relabel of an unknown persona or to a malformed label", () => {
  expect(payload("--relabel nobody=finance").code).not.toBe(0);
  expect(payload("--relabel beta=Not_A_Label").code).not.toBe(0);
});

test("persona_payload: Slack users and the manager from the environment", () => {
  const { json } = payload("", {
    SLAUDE_LOCAL_ALPHA_SLACK_USER: "UREALALPHA",
    SLAUDE_LOCAL_BETA_SLACK_USER: "UREALBETA",
    SLAUDE_LOCAL_MANAGER: "UMANAGER1",
  });
  expect(json.personas.find((p: any) => p.name === "alpha").slackUserId).toBe("UREALALPHA");
  expect(json.personas.find((p: any) => p.name === "beta").slackUserId).toBe("UREALBETA");
  expect(json.manager).toBe("UMANAGER1");
  // The soul names the manager, so the extraction cache entry is grounded in it.
  for (const p of json.personas) expect(p.soul).toContain("<@UMANAGER1>");
});

test("persona_payload refuses a manager that is not a Slack user id", () => {
  expect(payload("", { SLAUDE_LOCAL_MANAGER: "not an id" }).code).not.toBe(0);
});

test("vault_secret_json mirrors provider.env's credential fields; a placeholder without any", () => {
  writeFileSync(join(dir, "provider.env"), "ANTHROPIC_API_KEY=key-a\nANTHROPIC_BASE_URL=https://llm.example.com\nOTHER=x\n");
  const r = run(`vault_secret_json "${dir}/provider.env" alpha`);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual({ api_key: "key-a", base_url: "https://llm.example.com" });
  writeFileSync(join(dir, "provider.env"), "");
  expect(JSON.parse(run(`vault_secret_json "${dir}/provider.env" alpha`).out)).toEqual({ api_key: "local-placeholder-alpha" });
  writeFileSync(join(dir, "provider.env"), "CLAUDE_CODE_OAUTH_TOKEN=oat\n");
  expect(JSON.parse(run(`vault_secret_json "${dir}/provider.env" beta`).out)).toEqual({ oauth_token: "oat" });
});
