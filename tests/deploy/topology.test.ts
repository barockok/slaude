/**
 * The HA topology on the BUILT manifests (deploy/k8s-scale, deploy/k8s-local
 * and the e2e overlay on top of it): per-label node Deployments, each with its
 * own credential Secret, queue, autoscaler and disruption budget; the node
 * manifest; the gateway-only configuration (Vault, outbound hosts); and, in the
 * local overlay, the dev Vault, the bridge upstream and the fallback switched
 * off. What `kubectl kustomize` emits is what a cluster gets.
 *
 * Needs kubectl (its built-in kustomize); skipped without it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";
import { parseNodeManifest } from "../../src/node/manifest";
import { labelTurnsQueue } from "../../src/queue/keys";
import { stageLocal } from "./stage-local";

const root = join(import.meta.dir, "../..");
const hasKubectl = Bun.spawnSync(["sh", "-c", "command -v kubectl"]).exitCode === 0;
const parse = (text: string): any[] => parseAllDocuments(text).map((d) => d.toJSON()).filter(Boolean);

function kustomize(dir: string): any[] {
  const r = Bun.spawnSync(["kubectl", "kustomize", "--load-restrictor", "LoadRestrictionsNone", dir]);
  if (r.exitCode !== 0) throw new Error(`kubectl kustomize ${dir} failed: ${r.stderr.toString()}`);
  return parse(r.stdout.toString());
}

const tmp = mkdtempSync(join(tmpdir(), "slaude-topology-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let staged = false;
const stage = () => {
  if (!staged) stageLocal(tmp);
  staged = true;
  return tmp;
};

const find = (docs: any[], kind: string, name: string) => docs.find((d) => d.kind === kind && d.metadata?.name === name);
const LABEL_KEY = "slaude.dev/node-label";
/** Every Deployment whose pod runs a container named `node`, with its label. */
const nodeDeployments = (docs: any[]) =>
  docs
    .filter((d) => d.kind === "Deployment" && d.spec.template.spec.containers.some((c: any) => c.name === "node"))
    .map((d) => ({ dep: d, label: d.spec.template.metadata.labels?.[LABEL_KEY] as string, c: d.spec.template.spec.containers.find((c: any) => c.name === "node") }));
const envOf = (c: any, name: string) => (c.env ?? []).find((e: any) => e.name === name);
const cmData = (docs: any[], name: string) => find(docs, "ConfigMap", name)?.data ?? {};
/** Values a container sees for one name: a literal env, or a ConfigMap it loads whole. */
function valueSeen(docs: any[], c: any, name: string): string | undefined {
  const lit = envOf(c, name);
  if (lit && lit.value !== undefined) return lit.value;
  let out: string | undefined;
  for (const src of c.envFrom ?? []) {
    if (src.configMapRef) {
      const v = cmData(docs, src.configMapRef.name)[name];
      if (v !== undefined) out = v;
    }
  }
  return out;
}
const selects = (selector: Record<string, string>, labels: Record<string, string>) =>
  Object.entries(selector).every(([k, v]) => labels?.[k] === v);

const builds: [string, () => any[]][] = [
  ["deploy/k8s-scale", () => kustomize(join(root, "deploy/k8s-scale"))],
  ["deploy/k8s-local", () => kustomize(join(stage(), "deploy/k8s-local"))],
  ["e2e/k8s", () => kustomize(join(stage(), "e2e/k8s"))],
];

for (const [name, build] of builds) {
  describe.skipIf(!hasKubectl)(`built ${name}: labelled node deployments`, () => {
    const docs = hasKubectl ? build() : [];
    const nodes = nodeDeployments(docs);
    const gateway = find(docs, "Deployment", "slaude-gateway");
    const gw = gateway?.spec.template.spec.containers.find((c: any) => c.name === "gateway");

    test("one node Deployment for `default` (slaude-node) and one for `finance`", () => {
      expect(nodes.map((n) => [n.dep.metadata.name, n.label]).sort()).toEqual([
        ["slaude-node", "default"],
        ["slaude-node-finance", "finance"],
      ]);
    });

    test("no Deployment is scaled by both a KEDA ScaledObject and an HPA", () => {
      const keda = docs.filter((d) => d.kind === "ScaledObject").map((d) => d.spec.scaleTargetRef.name);
      const hpa = docs.filter((d) => d.kind === "HorizontalPodAutoscaler").map((d) => d.spec.scaleTargetRef.name);
      expect(keda.filter((n) => hpa.includes(n))).toEqual([]);
    });

    test("no node Deployment's selector matches another one's pods", () => {
      for (const a of nodes) {
        for (const b of nodes) {
          if (a === b) continue;
          expect(selects(a.dep.spec.selector.matchLabels, b.dep.spec.template.metadata.labels)).toBe(false);
        }
      }
    });

    test("each node Deployment takes SLAUDE_NODE_TOKEN from its own Secret, which nothing else reads", () => {
      const secretOf = (n: (typeof nodes)[number]) => envOf(n.c, "SLAUDE_NODE_TOKEN")?.valueFrom?.secretKeyRef?.name;
      const names = nodes.map(secretOf);
      for (const s of names) expect(s).toBeTruthy();
      expect(new Set(names).size).toBe(nodes.length);
      for (const s of names) expect(find(docs, "Secret", s)).toBeDefined();
      // Neither the gateway nor a node's envFrom loads a credential Secret.
      const loaded = [gw, ...nodes.map((n) => n.c)].flatMap((c) => (c.envFrom ?? []).map((e: any) => e.secretRef?.name).filter(Boolean));
      for (const s of names) expect(loaded).not.toContain(s);
      const gwRefs = (gw.env ?? []).map((e: any) => e.valueFrom?.secretKeyRef?.name).filter(Boolean);
      for (const s of names) expect(gwRefs).not.toContain(s);
    });

    test("every node pod refuses to boot holding a gateway-only variable, and loads none", () => {
      for (const n of nodes) {
        expect(valueSeen(docs, n.c, "SLAUDE_NODE_BOOT_CHECK")).toBe("refuse");
        for (const src of n.c.envFrom ?? []) {
          const obj = src.secretRef ? find(docs, "Secret", src.secretRef.name) : find(docs, "ConfigMap", src.configMapRef.name);
          const keys = Object.keys({ ...(obj?.data ?? {}), ...(obj?.stringData ?? {}) });
          expect(keys.filter(isGatewayOnlyEnv)).toEqual([]);
        }
        for (const e of n.c.env ?? []) expect(isGatewayOnlyEnv(e.name)).toBe(false);
      }
    });

    test("every node mounts the node manifest where SLAUDE_NODE_MANIFEST points, and it parses", () => {
      for (const n of nodes) {
        const path = valueSeen(docs, n.c, "SLAUDE_NODE_MANIFEST");
        expect(path).toBe("/etc/slaude/node.json");
        const mount = n.c.volumeMounts.find((m: any) => m.mountPath === "/etc/slaude");
        expect(mount?.readOnly).toBe(true);
        const vol = n.dep.spec.template.spec.volumes.find((v: any) => v.name === mount.name);
        const cm = find(docs, "ConfigMap", vol.configMap.name);
        expect(() => parseNodeManifest(cm.data["node.json"], {}, "test")).not.toThrow();
      }
    });

    test("only the gateway loads the gateway ConfigMap, and the shared one has no Vault or persona variable", () => {
      const gwCm = (gw.envFrom ?? []).map((e: any) => e.configMapRef?.name).filter(Boolean);
      expect(gwCm).toContain("slaude-scale-gateway-config");
      for (const n of nodes) {
        expect((n.c.envFrom ?? []).map((e: any) => e.configMapRef?.name)).not.toContain("slaude-scale-gateway-config");
      }
      expect(Object.keys(cmData(docs, "slaude-scale-config")).filter(isGatewayOnlyEnv)).toEqual([]);
    });

    test("the gateway can reach Vault: auth settings, and a projected token for Vault mounted where the config says", () => {
      const path = valueSeen(docs, gw, "SLAUDE_VAULT_K8S_TOKEN_PATH");
      expect(path).toBe("/var/run/secrets/vault/token");
      const mount = gw.volumeMounts.find((m: any) => path!.startsWith(`${m.mountPath}/`));
      const vol = gateway.spec.template.spec.volumes.find((v: any) => v.name === mount.name);
      const sat = vol.projected.sources.find((s: any) => s.serviceAccountToken).serviceAccountToken;
      expect(sat.audience).toBe("vault");
      expect(sat.expirationSeconds).toBeLessThanOrEqual(3600);
      expect(valueSeen(docs, gw, "SLAUDE_VAULT_ALLOWED_PREFIXES")).toContain("{persona}");
    });
  });
}

describe.skipIf(!hasKubectl)("built deploy/k8s-scale: production base", () => {
  const docs = hasKubectl ? kustomize(join(root, "deploy/k8s-scale")) : [];
  const nodes = nodeDeployments(docs);

  test("one KEDA ScaledObject per label, on that label's wait list, targeting its Deployment", () => {
    const sos = docs.filter((d) => d.kind === "ScaledObject");
    expect(sos.length).toBe(nodes.length);
    for (const n of nodes) {
      const so = sos.find((s) => s.spec.scaleTargetRef.name === n.dep.metadata.name);
      expect(so, n.dep.metadata.name).toBeDefined();
      expect(so.spec.triggers[0].metadata.listName).toBe(`slaude:bull:${labelTurnsQueue(n.label)}:wait`);
      // HA per label: never fewer than two.
      expect(so.spec.minReplicaCount).toBeGreaterThanOrEqual(2);
    }
  });

  test("the optional CPU fallback has one HPA per node Deployment, and is not in the build", () => {
    expect(docs.filter((d) => d.kind === "HorizontalPodAutoscaler")).toEqual([]);
    const fallback = parseAllDocuments(readFileSync(join(root, "deploy/k8s-scale/optional/node-cpu-fallback-hpa.yaml"), "utf8"))
      .map((d) => d.toJSON())
      .filter(Boolean);
    expect(fallback.map((h: any) => h.spec.scaleTargetRef.name).sort()).toEqual(nodes.map((n) => n.dep.metadata.name).sort());
  });

  test("one PodDisruptionBudget per node Deployment, selecting exactly its pods", () => {
    for (const n of nodes) {
      const pdbs = docs.filter((d) => d.kind === "PodDisruptionBudget" && selects(d.spec.selector.matchLabels, n.dep.spec.template.metadata.labels));
      expect(pdbs.length, n.dep.metadata.name).toBe(1);
    }
  });

  test("each label keeps at least two replicas", () => {
    for (const n of nodes) expect(n.dep.spec.replicas).toBeGreaterThanOrEqual(2);
  });

  test("the gateway Secret carries the node key; the node Secrets carry no credential of another label", () => {
    const gw = find(docs, "Secret", "slaude-scale-secrets").stringData;
    expect(gw.SLAUDE_NODE_KEY).toBeDefined();
    const node = find(docs, "Secret", "slaude-scale-node-secrets").stringData;
    expect(node.SLAUDE_NODE_TOKEN).toBeUndefined();
  });

  test("Vault stays off until SLAUDE_VAULT_ADDR is set, and the outbound hosts list is empty", () => {
    const g = cmData(docs, "slaude-scale-gateway-config");
    expect(g.SLAUDE_VAULT_ADDR).toBeUndefined();
    expect(g.SLAUDE_VAULT_AUTH).toBe("kubernetes");
    expect(g.SLAUDE_OUTBOUND_INTERNAL_HOSTS ?? "").toBe("");
  });
});

describe.skipIf(!hasKubectl)("built deploy/k8s-local: the full local topology", () => {
  const docs = hasKubectl ? kustomize(join(stage(), "deploy/k8s-local")) : [];
  const gateway = find(docs, "Deployment", "slaude-gateway");
  const gw = gateway?.spec.template.spec.containers.find((c: any) => c.name === "gateway");
  const nodes = nodeDeployments(docs);

  test("a dev Vault runs in the cluster, its root token in a Secret only Vault loads", () => {
    const vault = find(docs, "Deployment", "vault");
    expect(vault).toBeDefined();
    const c = vault.spec.template.spec.containers[0];
    expect(c.args).toEqual(["server", "-dev"]);
    expect(envOf(c, "VAULT_DEV_ROOT_TOKEN_ID").valueFrom.secretKeyRef.name).toBe("slaude-local-vault");
    expect(find(docs, "Service", "vault").spec.ports[0].port).toBe(8200);
    for (const d of docs.filter((x) => x.kind === "Deployment" && x.metadata.name !== "vault")) {
      expect(JSON.stringify(d.spec.template)).not.toContain("slaude-local-vault");
    }
  });

  test("the gateway uses the dev Vault through the token path, with the token in its own Secret", () => {
    expect(valueSeen(docs, gw, "SLAUDE_VAULT_ADDR")).toBe("http://vault:8200");
    expect(valueSeen(docs, gw, "SLAUDE_VAULT_AUTH")).toBe("token");
    expect(valueSeen(docs, gw, "SLAUDE_VAULT_ALLOW_INSECURE")).toBe("1");
    const secret = find(docs, "Secret", "slaude-scale-secrets");
    expect(Object.keys(secret.data)).toContain("SLAUDE_VAULT_TOKEN");
    expect(Object.keys(secret.data)).toContain("SLAUDE_NODE_KEY");
  });

  test("the outbound policy admits the in-cluster bridge upstream and Vault", () => {
    const hosts = (valueSeen(docs, gw, "SLAUDE_OUTBOUND_INTERNAL_HOSTS") ?? "").split(",");
    expect(hosts).toContain("mock-mcp");
    expect(hosts).toContain("vault");
  });

  test("the bridge upstream (mock MCP) is part of the build", () => {
    expect(find(docs, "Deployment", "mock-mcp")).toBeDefined();
    expect(find(docs, "ConfigMap", "mock-mcp-src").data["server.ts"]).toContain("tools/list");
  });

  test("nodes run with the provider env fallback off and hold no provider key", () => {
    for (const n of nodes) {
      expect(valueSeen(docs, n.c, "SLAUDE_PROVIDER_ENV_FALLBACK")).toBe("0");
      for (const src of n.c.envFrom ?? []) {
        if (!src.secretRef) continue;
        const keys = Object.keys(find(docs, "Secret", src.secretRef.name).data ?? {});
        expect(keys.filter((k) => k.startsWith("ANTHROPIC_") || k === "CLAUDE_CODE_OAUTH_TOKEN")).toEqual([]);
      }
    }
  });

  test("the finance label runs one replica locally; default keeps two", () => {
    expect(find(docs, "Deployment", "slaude-node-finance").spec.replicas).toBe(1);
    expect(find(docs, "Deployment", "slaude-node").spec.replicas).toBe(2);
  });

  test("no KEDA object, and no autoscaler on the finance label", () => {
    expect(docs.filter((d) => d.kind === "ScaledObject")).toEqual([]);
    const hpas = docs.filter((d) => d.kind === "HorizontalPodAutoscaler");
    expect(hpas.map((h) => h.spec.scaleTargetRef.name)).toEqual(["slaude-node"]);
  });
});
