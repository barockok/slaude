/**
 * One staging helper for every test that renders deploy/k8s-local (and the e2e
 * overlay on top of it). The overlay reads files up.sh generates and gitignores;
 * each test copies the overlays into a temporary tree and writes fake versions
 * of ALL of them here, so a new generated file is added in one place.
 */
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

/** Every file up.sh generates in deploy/k8s-local, with fake contents. */
export const LOCAL_GENERATED: Record<string, string> = {
  "secrets.env": [
    "SLAUDE_MASTER_KEY=fake",
    "SLAUDE_NODE_LEGACY_TOKEN=fake",
    "SLAUDE_JOB_SECRET=fake",
    "SLAUDE_PG_URL=postgres://fake",
    "SLAUDE_REDIS_URL=redis://fake",
    "SLAUDE_BRAIN_DATABASE_URL=postgres://fake",
    "SLAUDE_NODE_KEY=fake",
    "SLAUDE_VAULT_TOKEN=fake",
    "PERSONA_BETA_MOCKMCP_TOKEN=fake",
  ].join("\n") + "\n",
  "node.env": "SLAUDE_REDIS_URL=redis://fake\n",
  "node-cred-default.env": "SLAUDE_NODE_TOKEN=fake-default\n",
  "node-cred-finance.env": "SLAUDE_NODE_TOKEN=fake-finance\n",
  "provider.env": "ANTHROPIC_API_KEY=fake\n",
  "deploy.env": "SLAUDE_DEPLOY_TOKEN=fake\n",
  "vault-root.env": "VAULT_DEV_ROOT_TOKEN_ID=fake\n",
  "model.env": "",
  "gateway.env": "",
};

/** Copies deploy/k8s-scale, deploy/k8s-local and e2e/k8s under `tmp` and writes
 *  the generated files (overrides replace single files). Returns `tmp`. */
export function stageLocal(tmp: string, overrides: Partial<Record<string, string>> = {}): string {
  cpSync(join(root, "deploy/k8s-scale"), join(tmp, "deploy/k8s-scale"), { recursive: true });
  cpSync(join(root, "deploy/k8s-local"), join(tmp, "deploy/k8s-local"), { recursive: true });
  cpSync(join(root, "e2e/k8s"), join(tmp, "e2e/k8s"), { recursive: true });
  for (const [f, text] of Object.entries({ ...LOCAL_GENERATED, ...overrides })) {
    writeFileSync(join(tmp, "deploy/k8s-local", f), text ?? "");
  }
  return tmp;
}
