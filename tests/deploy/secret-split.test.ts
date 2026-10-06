/**
 * The gateway/node Secret split (node labels and routing spec §4.0), checked on
 * the BUILT manifests: what `kubectl kustomize` emits is what a cluster gets,
 * so patches and generators are included. A node pod must reference no
 * gateway-only variable through envFrom, env or a key reference; it must not
 * mount a ServiceAccount token; the gateway runs under its own ServiceAccount.
 *
 * deploy/k8s-local's Secrets come from env files up.sh generates (gitignored),
 * so the overlay is built from a temporary copy with fake files. Needs kubectl
 * (its built-in kustomize); skipped without it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";
import { stageLocal } from "./stage-local";

const root = join(import.meta.dir, "../..");
const hasKubectl = Bun.spawnSync(["sh", "-c", "command -v kubectl"]).exitCode === 0;

const parse = (text: string): any[] => parseAllDocuments(text).map((d) => d.toJSON()).filter(Boolean);

function kustomize(dir: string): any[] {
  const r = Bun.spawnSync(["kubectl", "kustomize", "--load-restrictor", "LoadRestrictionsNone", dir]);
  if (r.exitCode !== 0) throw new Error(`kubectl kustomize ${dir} failed: ${r.stderr.toString()}`);
  return parse(r.stdout.toString());
}

const tmp = mkdtempSync(join(tmpdir(), "slaude-secret-split-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let staged = false;
function stage(): string {
  if (!staged) stageLocal(tmp);
  staged = true;
  return tmp;
}
const buildLocal = () => kustomize(join(stage(), "deploy/k8s-local"));
const buildE2e = () => kustomize(join(stage(), "e2e/k8s"));

const find = (docs: any[], kind: string, name: string) => docs.find((d) => d.kind === kind && d.metadata?.name === name);
const container = (dep: any, name: string) => dep.spec.template.spec.containers.find((c: any) => c.name === name);

/** Every variable name (or mounted Secret key) a pod's containers can see,
 *  resolved through the built Secrets and ConfigMaps: envFrom, env, key
 *  references, init containers included, and Secrets mounted as volumes. */
function visiblePod(docs: any[], podSpec: any): { name: string; via: string }[] {
  const out: { name: string; via: string }[] = [];
  for (const c of [...(podSpec.initContainers ?? []), ...(podSpec.containers ?? [])]) out.push(...visibleEnv(docs, c));
  const keysOf = (name: string) => {
    const obj = find(docs, "Secret", name);
    expect(obj, `Secret ${name} mounted as a volume is not in the build`).toBeDefined();
    return Object.keys({ ...(obj.data ?? {}), ...(obj.stringData ?? {}) });
  };
  for (const v of podSpec.volumes ?? []) {
    if (v.secret) for (const k of keysOf(v.secret.secretName)) out.push({ name: k, via: `volume/${v.name}` });
    for (const src of v.projected?.sources ?? []) {
      if (src.secret) for (const k of keysOf(src.secret.name)) out.push({ name: k, via: `projected/${v.name}` });
    }
  }
  return out;
}

/** Every variable name a container can see, resolved through the built Secrets and ConfigMaps. */
function visibleEnv(docs: any[], c: any): { name: string; via: string }[] {
  const out: { name: string; via: string }[] = [];
  for (const src of c.envFrom ?? []) {
    const ref = src.secretRef ?? src.configMapRef;
    const kind = src.secretRef ? "Secret" : "ConfigMap";
    const obj = find(docs, kind, ref.name);
    expect(obj, `${kind} ${ref.name} referenced by envFrom is not in the build`).toBeDefined();
    for (const k of Object.keys({ ...(obj.data ?? {}), ...(obj.stringData ?? {}) })) {
      out.push({ name: (src.prefix ?? "") + k, via: `${kind}/${ref.name}` });
    }
  }
  for (const e of c.env ?? []) {
    out.push({ name: e.name, via: "env" });
    const key = e.valueFrom?.secretKeyRef?.key ?? e.valueFrom?.configMapKeyRef?.key;
    if (key) out.push({ name: key, via: `keyRef:${e.name}` });
  }
  return out;
}

const builds: [string, () => any[]][] = [
  ["deploy/k8s-scale", () => kustomize(join(root, "deploy/k8s-scale"))],
  ["deploy/k8s-local", buildLocal],
  ["e2e/k8s", buildE2e],
];

for (const [label, build] of builds) {
  describe.skipIf(!hasKubectl)(`built ${label}`, () => {
    const docs = hasKubectl ? build() : [];
    const node = find(docs, "Deployment", "slaude-node");
    // Every node deployment, one per label (slaude-node is label `default`).
    const nodes: any[] = docs.filter(
      (d) => d.kind === "Deployment" && d.spec.template.spec.containers.some((c: any) => c.name === "node"),
    );
    const gateway = find(docs, "Deployment", "slaude-gateway");

    test("every node deployment is found, slaude-node among them", () => {
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      expect(nodes).toContain(node);
    });

    test("no node pod can see a gateway-only variable", () => {
      for (const n of nodes) {
        const leaked = visiblePod(docs, n.spec.template.spec).filter((v) => isGatewayOnlyEnv(v.name));
        expect(leaked, n.metadata.name).toEqual([]);
      }
    });

    test("every node loads the node Secret and not the gateway's", () => {
      for (const n of nodes) {
        const refs = (container(n, "node").envFrom ?? []).map((s: any) => s.secretRef?.name).filter(Boolean);
        expect(refs as string[], n.metadata.name).toContain("slaude-scale-node-secrets");
        expect(refs as string[], n.metadata.name).not.toContain("slaude-scale-secrets");
      }
    });

    test("node pods mount no ServiceAccount token", () => {
      for (const n of nodes) expect(n.spec.template.spec.automountServiceAccountToken as boolean, n.metadata.name).toBe(false);
    });

    test("the gateway runs under its own ServiceAccount", () => {
      const sa = gateway.spec.template.spec.serviceAccountName;
      expect(sa).toBe("slaude-gateway");
      expect(find(docs, "ServiceAccount", sa)).toBeDefined();
      for (const n of nodes) expect(n.spec.template.spec.serviceAccountName ?? "default").not.toBe(sa);
    });

    test("the gateway still has what it shares with nodes", () => {
      const names = visibleEnv(docs, container(gateway, "gateway")).map((v) => v.name);
      for (const n of ["SLAUDE_MASTER_KEY", "SLAUDE_JOB_SECRET", "SLAUDE_PG_URL", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_REDIS_URL"]) {
        expect(names).toContain(n);
      }
    });

    test("the gateway reads the legacy node token under its own name, never the node's credential", () => {
      // SLAUDE_NODE_TOKEN is a node's own credential; a signed one fed to the
      // gateway must never become the value the gateway accepts.
      const seen = visibleEnv(docs, container(gateway, "gateway"));
      expect(seen.filter((v) => v.name === "SLAUDE_NODE_TOKEN")).toEqual([]);
      const legacy = seen.find((v) => v.name === "SLAUDE_NODE_LEGACY_TOKEN");
      expect(legacy?.via).toBe("Secret/slaude-scale-secrets");
    });

    test("the optional NetworkPolicy is not part of the default build", () => {
      expect(docs.filter((d) => d.kind === "NetworkPolicy")).toEqual([]);
    });
  });
}

describe("the optional node NetworkPolicy", () => {
  const [np] = parse(readFileSync(join(root, "deploy/k8s-scale/optional/node-egress-networkpolicy.yaml"), "utf8"));

  test("selects every node deployment's pods (and only those) and restricts their egress", () => {
    expect(np.kind).toBe("NetworkPolicy");
    expect(np.spec.podSelector.matchLabels).toEqual({ "app.kubernetes.io/name": "slaude", "slaude.dev/tier": "node" });
    expect(np.spec.policyTypes).toEqual(["Egress"]);
  });

  test.skipIf(!hasKubectl)("its selector matches the pods of every node deployment in the base, and no gateway pod", () => {
    const docs = kustomize(join(root, "deploy/k8s-scale"));
    const sel = np.spec.podSelector.matchLabels as Record<string, string>;
    const matches = (labels: Record<string, string>) => Object.entries(sel).every(([k, v]) => labels[k] === v);
    for (const d of docs.filter((x) => x.kind === "Deployment")) {
      const isNode = d.spec.template.spec.containers.some((c: any) => c.name === "node");
      expect(matches(d.spec.template.metadata.labels), d.metadata.name).toBe(isNode);
    }
  });

  test("allows no Postgres or Vault port", () => {
    const ports = np.spec.egress.flatMap((r: any) => (r.ports ?? [{ port: "ANY" }]).map((p: any) => p.port));
    expect(ports).not.toContain("ANY");
    expect(ports).not.toContain(5432);
    expect(ports).not.toContain(8200);
  });
});
