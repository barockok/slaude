/**
 * The local overlay's resource numbers against sizing.env, the one place the
 * node size and the provisional Docker VM floor are written down.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const dir = new URL("../../deploy/k8s-local/", import.meta.url).pathname;

const sizing = Object.fromEntries(
  readFileSync(`${dir}sizing.env`, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=\d+$/.test(l))
    .map((l) => l.split("=") as [string, string])
    .map(([k, v]) => [k, Number(v)]),
) as Record<string, number>;

const kustomization = parse(readFileSync(`${dir}kustomization.yaml`, "utf8")) as any;
const patches = (kustomization.patches as { patch: string }[]).map((p) => parse(p.patch));
const container = (deploy: string) =>
  patches.find((d) => d.kind === "Deployment" && d.metadata.name === deploy).spec.template.spec.containers[0];

const milli = (q: string) => (q.endsWith("m") ? Number(q.slice(0, -1)) : Number(q) * 1000);
const mb = (q: string) => (q.endsWith("Gi") ? Number(q.slice(0, -2)) * 1024 : Number(q.slice(0, -2)));

// replicas at the pinned HPA (the verify scripts pin max to min)
const PINNED = { "slaude-gateway": 2, "slaude-node": 2, "dev-postgres": 1, "dev-redis": 1 } as const;

test("summed limits at the pinned replica counts fit the node, minus its system reserve", () => {
  let cpu = 0;
  let mem = 0;
  for (const [name, n] of Object.entries(PINNED)) {
    const lim = container(name).resources.limits;
    expect(lim.cpu, `${name} must set a CPU limit`).toBeDefined();
    expect(lim.memory, `${name} must set a memory limit`).toBeDefined();
    cpu += n * milli(String(lim.cpu));
    mem += n * mb(lim.memory);
  }
  expect(cpu).toBeLessThanOrEqual(sizing.LOCAL_NODE_CPUS * 1000 - sizing.LOCAL_SYSTEM_RESERVE_MILLICPU);
  expect(mem).toBeLessThanOrEqual(sizing.LOCAL_NODE_MEMORY_MB - sizing.LOCAL_SYSTEM_RESERVE_MEMORY_MB);
});

test("requests never exceed limits, and the HPA maximum still fits in requests", () => {
  let cpu = 0;
  let mem = 0;
  const atMax = { ...PINNED, "slaude-node": 3 } as Record<string, number>;
  for (const [name, n] of Object.entries(atMax)) {
    const { requests, limits } = container(name).resources;
    expect(milli(String(requests.cpu))).toBeLessThanOrEqual(milli(String(limits.cpu)));
    expect(mb(requests.memory)).toBeLessThanOrEqual(mb(limits.memory));
    cpu += n * milli(String(requests.cpu));
    mem += n * mb(requests.memory);
  }
  expect(cpu).toBeLessThanOrEqual(sizing.LOCAL_NODE_CPUS * 1000);
  expect(mem).toBeLessThanOrEqual(sizing.LOCAL_NODE_MEMORY_MB);
});

test("up.sh defaults to the node size in sizing.env, and the VM floor holds the node", () => {
  const up = readFileSync(`${dir}up.sh`, "utf8");
  expect(up).toContain('. "$HERE/sizing.env"');
  expect(up).toContain('CPUS="${SLAUDE_LOCAL_CPUS:-$LOCAL_NODE_CPUS}"');
  expect(up).toContain('MEMORY="${SLAUDE_LOCAL_MEMORY:-$LOCAL_NODE_MEMORY_MB}"');
  expect(sizing.LOCAL_VM_FLOOR_CPUS).toBeGreaterThanOrEqual(sizing.LOCAL_NODE_CPUS);
  expect(sizing.LOCAL_VM_FLOOR_MEMORY_MB).toBeGreaterThan(sizing.LOCAL_NODE_MEMORY_MB);
});

test("gateway and node probes are loosened locally and gain a startupProbe; the base is untouched", () => {
  for (const [name, path] of [
    ["slaude-gateway", "http"],
    ["slaude-node", "health"],
  ] as const) {
    const c = container(name);
    expect(c.livenessProbe).toEqual({ timeoutSeconds: 5, failureThreshold: 5 });
    expect(c.readinessProbe).toEqual({ timeoutSeconds: 5, failureThreshold: 5 });
    expect(c.startupProbe.httpGet).toEqual({ path: "/healthz", port: path });
  }
  for (const f of ["40-gateway.yaml", "50-node.yaml"]) {
    const base = readFileSync(`${dir}../k8s-scale/${f}`, "utf8");
    expect(base).not.toContain("timeoutSeconds");
    expect(base).not.toContain("startupProbe");
  }
});

test("both dev datastores carry a readiness probe, and Postgres probes over TCP", () => {
  const docs = readFileSync(`${dir}../k8s-scale/90-dev-datastores.yaml`, "utf8")
    .split(/^---$/m)
    .map((d) => parse(d))
    .filter((d) => d?.kind === "Deployment");
  const probe = (n: string) => docs.find((d) => d.metadata.name === n).spec.template.spec.containers[0].readinessProbe;
  expect(probe("dev-postgres").exec.command).toEqual(["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "slaude"]);
  expect(probe("dev-redis").exec.command).toEqual(["redis-cli", "ping"]);
});

const haveKubectl = Bun.spawnSync(["kubectl", "version", "--client"]).exitCode === 0;

// The generated env files are gitignored; stand-ins are written only when missing and removed after.
function render(model: string): string {
  const files = ["secrets.env", "provider.env", "deploy.env", "model.env"];
  const made: string[] = [];
  for (const f of files) {
    if (f === "model.env" || !existsSync(dir + f)) {
      if (f !== "model.env") made.push(f);
      writeFileSync(dir + f, f === "model.env" ? model : `PLACEHOLDER_${f.replace(".env", "").toUpperCase()}=x\n`);
    }
  }
  try {
    const r = Bun.spawnSync(["kubectl", "kustomize", "--load-restrictor", "LoadRestrictionsNone", dir]);
    expect(r.stderr.toString()).toBe("");
    return r.stdout.toString();
  } finally {
    for (const f of made) rmSync(dir + f, { force: true });
  }
}

test.skipIf(!haveKubectl)("model.env merges into the base ConfigMap: empty keeps the default, a value overrides it", () => {
  const hadModelEnv = existsSync(dir + "model.env");
  const saved = hadModelEnv ? readFileSync(dir + "model.env", "utf8") : "";
  try {
    expect(render("")).toMatch(/SLAUDE_MODEL: claude-sonnet-4-6/);
    const out = render("SLAUDE_MODEL=provider/some-model\n");
    expect(out).toMatch(/SLAUDE_MODEL: provider\/some-model/);
    // merged, not replaced: the rest of the base ConfigMap and the overlay's patch survive
    expect(out).toMatch(/SLAUDE_NODE_CONCURRENCY: "2"/);
  } finally {
    if (hadModelEnv) writeFileSync(dir + "model.env", saved);
    else rmSync(dir + "model.env", { force: true });
  }
});
