/**
 * The brain-database init SQL exists twice: as a file docker-compose mounts, and
 * inlined in the dev datastores ConfigMap, because plain `kubectl apply` cannot
 * read a file from outside the manifest. Copies like that drift, and a drifted
 * copy means compose and Kubernetes create different databases.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);

test("the dev datastores ConfigMap inlines the same brain-database SQL as the compose init file", () => {
  const file = readFileSync(new URL("deploy/postgres-init/10-brain-database.sql", root), "utf8");
  const docs = readFileSync(new URL("deploy/k8s-scale/90-dev-datastores.yaml", root), "utf8")
    .split(/^---$/m)
    .map((d) => parse(d))
    .filter(Boolean);
  const cm = docs.find((d: any) => d.kind === "ConfigMap" && d.metadata?.name === "dev-postgres-init") as any;

  expect(cm).toBeDefined();
  expect(cm.data["10-brain-database.sql"].trim()).toBe(file.trim());
});

test("the gateway config and compose both point the brain at Postgres", () => {
  const cfg = parse(readFileSync(new URL("deploy/k8s-scale/20-config.yaml", root), "utf8")) as any;
  expect(cfg.data.SLAUDE_BRAIN_ENGINE).toBe("postgres");

  const compose = parse(readFileSync(new URL("docker-compose.scale.yaml", root), "utf8")) as any;
  expect(compose.services.gateway.environment.SLAUDE_BRAIN_ENGINE).toBe("postgres");
  expect(compose.services.gateway.environment.SLAUDE_BRAIN_DATABASE_URL).toContain("/slaude_brain");
  expect(compose.services.postgres.image).toContain("pgvector");
});
