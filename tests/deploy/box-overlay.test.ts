/**
 * deploy/k8s-scale-box as BUILT (box plan, Phases 6 and 9): every node
 * Deployment gains the supervisor container (`boxd`), privileged and holding
 * nothing; the two box volumes; the tier and capacity variables, with numbers
 * the node's own boot check accepts; the resource split; and, as before, the
 * memory and CPU triggers on `boxd` beside each label's wait-list trigger and
 * a grace period that covers the drain. The base is untouched, the overlay
 * composes with deploy/k8s-scale-s3, and the fallback HPA for clusters without
 * KEDA uses ContainerResource metrics.
 *
 * This is a test of what `kubectl kustomize` emits. Nothing here was applied
 * to a cluster.
 *
 * Needs kubectl (its built-in kustomize); the rendered half is skipped without it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { boxdRefusedEnv } from "../../src/box/boxd/env-check";
import { checkSizing, drainGraceSec } from "../../src/box/capacity";
import { DEFAULT_BOX_RESOURCES, defaultMemoryReserveMb } from "../../src/box/policy";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";

const root = join(import.meta.dir, "../..");
const hasKubectl = Bun.spawnSync(["sh", "-c", "command -v kubectl"]).exitCode === 0;
const parse = (text: string): any[] => parseAllDocuments(text).map((d) => d.toJSON()).filter(Boolean);
function kustomize(dir: string): any[] {
  const r = Bun.spawnSync(["kubectl", "kustomize", "--load-restrictor", "LoadRestrictionsNone", join(root, dir)]);
  if (r.exitCode !== 0) throw new Error(`kubectl kustomize ${dir} failed: ${r.stderr.toString()}`);
  return parse(r.stdout.toString());
}
const d = describe.skipIf(!hasKubectl);

const nodeDeployments = (set: any[]) => set.filter((x) => x.kind === "Deployment" && x.metadata.name.startsWith("slaude-node"));
const scaled = (set: any[]) => set.filter((x) => x.kind === "ScaledObject");
const containerOf = (dep: any, name: string) => dep.spec.template.spec.containers.find((c: any) => c.name === name);
const envValue = (c: any, name: string): string | undefined => (c.env ?? []).find((e: any) => e.name === name)?.value;
/** `16Gi`, `768Mi` to MB. */
function mb(q: string): number {
  const m = /^(\d+)(Mi|Gi)$/.exec(q);
  if (!m) throw new Error(`not a Mi or Gi quantity: ${q}`);
  return Number(m[1]) * (m[2] === "Gi" ? 1024 : 1);
}
/** `500m`, `2` to millicores. */
const millis = (q: string): number => (String(q).endsWith("m") ? Number(String(q).slice(0, -1)) : Number(q) * 1000);

const BOXD_COMMAND = ["tini", "--", "bun", "--no-env-file", "src/box/boxd/main.ts", "--mount-root", "/data", "--mount-root", "/config-home", "--ro-root", "/app"];

const overlays: [string, string][] = [
  ["deploy/k8s-scale-box", "deploy/k8s-scale"],
  ["deploy/k8s-scale-box/with-s3", "deploy/k8s-scale-s3"],
];

for (const [overlay, under] of overlays) {
  d(`${overlay}, rendered`, () => {
    const docs = hasKubectl ? kustomize(overlay) : [];
    const base = hasKubectl ? kustomize(under) : [];

    test("every node label has a ScaledObject, and each keeps its own wait-list trigger first", () => {
      const names = scaled(docs).map((s) => s.metadata.name).sort();
      expect(names).toEqual(nodeDeployments(docs).map((x) => x.metadata.name).sort());
      expect(names.length).toBeGreaterThanOrEqual(2);
      for (const s of scaled(docs)) {
        expect(s.spec.triggers[0].type).toBe("redis");
        expect(s.spec.triggers[0].metadata.listName).toMatch(/^slaude:bull:turns(\.label\.[a-z0-9-]+)?:wait$/);
      }
    });

    test("each ScaledObject gains memory and CPU triggers on the boxd container, at 75 and 70 percent of requests", () => {
      for (const s of scaled(docs)) {
        const byType = Object.fromEntries(s.spec.triggers.map((t: any) => [t.type, t]));
        expect(Object.keys(byType).sort()).toEqual(["cpu", "memory", "redis"]);
        expect(byType.memory).toEqual({ type: "memory", metricType: "Utilization", metadata: { value: "75", containerName: "boxd" } });
        expect(byType.cpu).toEqual({ type: "cpu", metricType: "Utilization", metadata: { value: "70", containerName: "boxd" } });
        // Scale-down waits as long as before.
        expect(s.spec.cooldownPeriod).toBe(300);
      }
    });

    test("the grace period is 300 s on every node Deployment and exceeds the drain window plus the flush of its warm boxes", () => {
      const config = docs.find((x) => x.kind === "ConfigMap" && x.metadata.name === "slaude-scale-config");
      const drainSec = Number(config.data.SLAUDE_NODE_DRAIN_SEC);
      expect(drainSec).toBe(120);
      for (const dep of nodeDeployments(docs)) {
        const grace = dep.spec.template.spec.terminationGracePeriodSeconds;
        expect(grace).toBe(300);
        expect(grace).toBeGreaterThan(drainSec);
        const maxBoxes = Number(envValue(containerOf(dep, "node"), "SLAUDE_NODE_MAX_BOXES"));
        // The manifest's own box count, and the code default of 8, both drain inside it.
        expect(drainGraceSec({ drainSec, warmBoxes: maxBoxes })).toBeLessThan(grace);
        expect(drainGraceSec({ drainSec, warmBoxes: 8 })).toBeLessThan(grace);
      }
      // The gateway is not a node: its grace period is not touched.
      const gw = docs.find((x) => x.kind === "Deployment" && x.metadata.name === "slaude-gateway");
      const baseGw = base.find((x) => x.kind === "Deployment" && x.metadata.name === "slaude-gateway");
      expect(gw.spec.template.spec.terminationGracePeriodSeconds).toBe(baseGw.spec.template.spec.terminationGracePeriodSeconds);
    });

    test("what it is laid over is untouched: no box trigger, the old grace period, one container, no box switch", () => {
      for (const s of scaled(base)) expect(s.spec.triggers.map((t: any) => t.type)).toEqual(["redis"]);
      for (const dep of nodeDeployments(base)) {
        expect(dep.spec.template.spec.terminationGracePeriodSeconds).toBe(150);
        expect(dep.spec.template.spec.containers.map((c: any) => c.name)).toEqual(["node"]);
        expect(envValue(containerOf(dep, "node"), "SLAUDE_BOX_TIER")).toBeUndefined();
      }
      const baseGw = base.find((x) => x.kind === "Deployment" && x.metadata.name === "slaude-gateway");
      expect(envValue(containerOf(baseGw, "gateway"), "SLAUDE_BOX")).toBeUndefined();
    });

    test("the overlay adds and removes no object, and renders no HPA", () => {
      const key = (x: any) => `${x.kind}/${x.metadata?.name}`;
      expect(docs.map(key).sort()).toEqual(base.map(key).sort());
      // The fallback is opt-in, never beside KEDA.
      expect(docs.filter((x) => x.kind === "HorizontalPodAutoscaler")).toEqual([]);
    });

    test("every node Deployment has exactly the containers node and boxd, and the node container is the base's but for its box settings", () => {
      expect(nodeDeployments(docs).length).toBeGreaterThanOrEqual(2);
      for (const dep of nodeDeployments(docs)) {
        expect(dep.spec.template.spec.containers.map((c: any) => c.name) as string[]).toEqual(["node", "boxd"]);
        expect(dep.spec.template.spec.initContainers ?? []).toEqual([]);
        const node = containerOf(dep, "node");
        const before = containerOf(base.find((x) => x.kind === "Deployment" && x.metadata.name === dep.metadata.name), "node");
        // Still the node entry, executed directly (tests/deploy/node-entry.test.ts says why).
        expect(node.command).toEqual(["bun", "--no-env-file", "src/node/main.ts"]);
        expect(node.envFrom).toEqual(before.envFrom);
        expect(node.securityContext?.privileged ?? false).toBe(false);
        // Every variable the base set is still there with its value or its reference.
        for (const e of before.env) expect(node.env).toContainEqual(e);
        const added = node.env.filter((e: any) => !before.env.some((b: any) => b.name === e.name)).map((e: any) => e.name);
        expect(added.sort()).toEqual(["SLAUDE_BOXD_SOCKET", "SLAUDE_BOX_DIR", "SLAUDE_BOX_IMAGE_BUDGET_MB", "SLAUDE_BOX_PARK_BUDGET_MB", "SLAUDE_BOX_TIER", "SLAUDE_NODE_MAX_BOXES"]);
        for (const m of before.volumeMounts) expect(node.volumeMounts).toContainEqual(m);
      }
    });

    test("privileged is set on boxd and on no other container of the build", () => {
      const privileged: string[] = [];
      for (const x of docs) {
        const spec = x.spec?.template?.spec;
        if (!spec) continue;
        for (const c of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
          if (c.securityContext?.privileged) privileged.push(`${x.kind}/${x.metadata.name}/${c.name}`);
          expect(c.securityContext?.allowPrivilegeEscalation && c.name !== "boxd", `${x.metadata.name}/${c.name}`).toBeFalsy();
        }
        expect(spec.hostPID ?? false).toBe(false);
        expect(spec.hostNetwork ?? false).toBe(false);
        expect(spec.hostIPC ?? false).toBe(false);
      }
      expect(privileged.sort()).toEqual(nodeDeployments(docs).map((x) => `Deployment/${x.metadata.name}/boxd`).sort());
    });

    test("boxd holds nothing: no envFrom, no key reference, no Secret or ConfigMap volume, no variable it would refuse to start with", () => {
      for (const dep of nodeDeployments(docs)) {
        const boxd = containerOf(dep, "boxd");
        expect(boxd.envFrom, dep.metadata.name).toBeUndefined();
        for (const e of boxd.env) {
          expect(e.valueFrom, `${dep.metadata.name} ${e.name}`).toBeUndefined();
          expect(typeof e.value).toBe("string");
          expect(isGatewayOnlyEnv(e.name)).toBe(false);
        }
        // The supervisor's own boot refusal, asked of the manifest.
        expect(boxdRefusedEnv(Object.fromEntries(boxd.env.map((e: any) => [e.name, e.value])))).toEqual([]);
        expect(boxd.env.map((e: any) => e.name).sort()).toEqual(["SLAUDE_BOXD_SOCKET", "SLAUDE_BOX_DIR", "SLAUDE_BOX_TIER"]);
        const volumes = dep.spec.template.spec.volumes as any[];
        for (const m of boxd.volumeMounts) {
          const v = volumes.find((x) => x.name === m.name);
          expect(v, `${dep.metadata.name} mounts ${m.name}`).toBeDefined();
          expect(v.secret, m.name).toBeUndefined();
          expect(v.projected, m.name).toBeUndefined();
          expect(v.configMap, m.name).toBeUndefined();
          expect(v.hostPath, m.name).toBeUndefined();
        }
        // The node manifest (a ConfigMap) is the node container's, not the supervisor's.
        expect(boxd.volumeMounts.map((m: any) => m.mountPath).sort()).toEqual(["/config-home", "/data", "/run/slaude-box", "/var/lib/slaude-box"]);
        // No Secret is mounted as a volume anywhere in a node pod, and no ServiceAccount token.
        for (const v of volumes) expect(v.secret, v.name).toBeUndefined();
        expect(dep.spec.template.spec.automountServiceAccountToken).toBe(false);
      }
    });

    test("boxd is the same image, started under tini with no dotenv file, on the roots the node worker hands out", () => {
      for (const dep of nodeDeployments(docs)) {
        const boxd = containerOf(dep, "boxd");
        const node = containerOf(dep, "node");
        expect(boxd.image).toBe(node.image);
        expect(boxd.command).toEqual(BOXD_COMMAND);
        expect(boxd.args).toBeUndefined();
        // The mount roots are where the node keeps workspaces and session config directories.
        expect(envValue(node, "SLAUDE_HOME")).toBe("/data");
        expect(envValue(node, "SLAUDE_NODE_CONFIG_ROOT")).toBe("/config-home");
        // Both containers see the same volume at each path the supervisor is told about.
        for (const path of ["/data", "/config-home", "/run/slaude-box", "/var/lib/slaude-box"]) {
          const a = node.volumeMounts.find((m: any) => m.mountPath === path);
          const b = boxd.volumeMounts.find((m: any) => m.mountPath === path);
          expect(a?.name, `${dep.metadata.name} ${path}`).toBeDefined();
          expect(b?.name).toBe(a.name);
          expect(a.readOnly ?? false).toBe(false);
          expect(b.readOnly ?? false).toBe(false);
        }
      }
    });

    test("the node and the supervisor agree on the tier, the socket and the box directory, and both are on the box volumes", () => {
      for (const dep of nodeDeployments(docs)) {
        const boxd = containerOf(dep, "boxd");
        const node = containerOf(dep, "node");
        expect(envValue(node, "SLAUDE_BOX_TIER")).toBe("gvisor");
        for (const name of ["SLAUDE_BOX_TIER", "SLAUDE_BOXD_SOCKET", "SLAUDE_BOX_DIR"]) expect(envValue(boxd, name)).toBe(envValue(node, name)!);
        expect(envValue(node, "SLAUDE_BOXD_SOCKET")).toBe("/run/slaude-box/boxd.sock");
        expect(envValue(node, "SLAUDE_BOX_DIR")).toBe("/var/lib/slaude-box");
        const volumes = dep.spec.template.spec.volumes as any[];
        expect(volumes.find((v) => v.name === "box-run").emptyDir).toEqual({ medium: "Memory", sizeLimit: "16Mi" });
        expect(volumes.find((v) => v.name === "box-data").emptyDir.sizeLimit).toMatch(/^\d+Gi$/);
        expect(volumes.find((v) => v.name === "box-data").emptyDir.medium).toBeUndefined();
      }
    });

    test("the manifest's numbers pass the node's own sizing check: boxd's memory limit and the box volume hold SLAUDE_NODE_MAX_BOXES", () => {
      const config = docs.find((x) => x.kind === "ConfigMap" && x.metadata.name === "slaude-scale-config");
      for (const dep of nodeDeployments(docs)) {
        const boxd = containerOf(dep, "boxd");
        const node = containerOf(dep, "node");
        const maxBoxes = Number(envValue(node, "SLAUDE_NODE_MAX_BOXES"));
        expect(maxBoxes).toBeGreaterThanOrEqual(1);
        const input = {
          maxBoxes,
          // Not set in the manifest: derived from the limit, as on a real pod.
          memoryBudgetMb: null,
          memoryLimitMb: mb(boxd.resources.limits.memory),
          overheadMb: 150,
          smallestReserveMb: defaultMemoryReserveMb(DEFAULT_BOX_RESOURCES.memoryMb),
          diskMb: mb(dep.spec.template.spec.volumes.find((v: any) => v.name === "box-data").emptyDir.sizeLimit),
          imageBudgetMb: Number(envValue(node, "SLAUDE_BOX_IMAGE_BUDGET_MB")),
          parkBudgetMb: Number(envValue(node, "SLAUDE_BOX_PARK_BUDGET_MB")),
          turnConcurrency: Number(config.data.SLAUDE_NODE_CONCURRENCY ?? 8),
        };
        expect(envValue(node, "SLAUDE_BOX_MEMORY_BUDGET_MB")).toBeUndefined();
        expect(envValue(node, "SLAUDE_BOX_SANDBOX_OVERHEAD_MB")).toBeUndefined();
        const r = checkSizing(input);
        expect(r.errors, dep.metadata.name).toEqual([]);
        expect(r.warnings, dep.metadata.name).toEqual([]);
        // The check is not vacuous: one more box than the limit holds is refused.
        const most = Math.floor((input.memoryLimitMb * 0.85) / (input.smallestReserveMb + input.overheadMb));
        expect(checkSizing({ ...input, maxBoxes: most + 1, diskMb: null }).ok).toBe(false);
      }
    });

    test("the resource split: boxd holds the boxes and sets the requests the triggers are percentages of; node is the smaller", () => {
      for (const dep of nodeDeployments(docs)) {
        const boxd = containerOf(dep, "boxd").resources;
        const node = containerOf(dep, "node").resources;
        for (const r of [boxd, node]) for (const k of ["requests", "limits"]) for (const res of ["cpu", "memory"]) expect(r[k][res], `${dep.metadata.name} ${k}.${res}`).toBeDefined();
        expect(mb(boxd.requests.memory)).toBeLessThanOrEqual(mb(boxd.limits.memory));
        expect(millis(boxd.requests.cpu)).toBeLessThanOrEqual(millis(boxd.limits.cpu));
        expect(mb(node.limits.memory)).toBeLessThan(mb(boxd.requests.memory));
        // Smaller than the base's node, which held every agent process itself.
        const before = containerOf(base.find((x) => x.kind === "Deployment" && x.metadata.name === dep.metadata.name), "node").resources;
        expect(mb(node.limits.memory)).toBeLessThan(mb(before.limits.memory));
        // A box's ceiling fits in the supervisor: one default box can reach its memory limit.
        expect(mb(boxd.limits.memory)).toBeGreaterThan(DEFAULT_BOX_RESOURCES.memoryMb);
      }
    });

    test("the gateway reads boxes, and gains nothing else", () => {
      const gw = docs.find((x) => x.kind === "Deployment" && x.metadata.name === "slaude-gateway");
      const baseGw = base.find((x) => x.kind === "Deployment" && x.metadata.name === "slaude-gateway");
      const c = containerOf(gw, "gateway");
      expect(envValue(c, "SLAUDE_BOX")).toBe("on");
      expect(gw.spec.template.spec.containers.map((x: any) => x.name)).toEqual(baseGw.spec.template.spec.containers.map((x: any) => x.name));
      expect(c.env.filter((e: any) => e.name !== "SLAUDE_BOX")).toEqual(containerOf(baseGw, "gateway").env ?? []);
      expect(c.securityContext?.privileged ?? false).toBe(false);
    });
  });
}

d("deploy/k8s-scale-box/with-s3: the two overlays compose", () => {
  const docs = hasKubectl ? kustomize("deploy/k8s-scale-box/with-s3") : [];

  test("no PersistentVolumeClaim, and /data is one pod-local volume shared by node and boxd", () => {
    expect(docs.filter((x) => x.kind === "PersistentVolumeClaim")).toEqual([]);
    for (const dep of nodeDeployments(docs)) {
      const home = dep.spec.template.spec.volumes.filter((v: any) => v.name === "slaude-home");
      expect(home).toEqual([{ name: "slaude-home", emptyDir: { sizeLimit: "20Gi" } }]);
      // No volume lost or doubled by the two overlays patching the same list.
      const names = dep.spec.template.spec.volumes.map((v: any) => v.name).sort();
      expect(names).toEqual(["box-data", "box-run", "config-home", "node-manifest", "slaude-home"]);
    }
  });

  test("the node container has the bucket credentials and boxd has none", () => {
    for (const dep of nodeDeployments(docs)) {
      const refs = (containerOf(dep, "node").envFrom ?? []).map((s: any) => s.secretRef?.name).filter(Boolean);
      expect(refs).toContain("slaude-scale-s3");
      expect(containerOf(dep, "boxd").envFrom).toBeUndefined();
    }
    const config = docs.find((x) => x.kind === "ConfigMap" && x.metadata.name === "slaude-scale-config");
    expect(config.data.SLAUDE_STORAGE).toBe("s3");
  });

  test("listing both overlays as resources is refused by kustomize, which is why the component exists", () => {
    const k = readFileSync(join(root, "deploy/k8s-scale-box/with-s3/kustomization.yaml"), "utf8");
    const parsed = parse(k)[0];
    expect(parsed.resources).toEqual(["../../k8s-scale-s3"]);
    expect(parsed.components).toEqual(["../component"]);
  });
});

describe("the box overlay's files", () => {
  const k = readFileSync(join(root, "deploy/k8s-scale-box/kustomization.yaml"), "utf8");
  const component = readFileSync(join(root, "deploy/k8s-scale-box/component/kustomization.yaml"), "utf8");

  test("it is the base plus one component", () => {
    const parsed = parse(k)[0];
    expect(parsed.resources).toEqual(["../k8s-scale"]);
    expect(parsed.components).toEqual(["component"]);
    expect(parse(component)[0].kind).toBe("Component");
  });

  test("its header no longer says it is incomplete, and says what was never proven", () => {
    expect(k).not.toContain("DO NOT APPLY YET");
    expect(k).not.toContain("INCOMPLETE ON PURPOSE");
    expect(k).toContain("NOT PROVEN ON A CLUSTER");
    expect(k).toContain("never been applied to a");
    expect(k).toContain("not measurements");
  });

  test("the Deployment patch matches by name, so it composes with an overlay that patched by index", () => {
    const patches = parse(component)[0].patches as { target: { kind: string; name: string }; patch: string }[];
    const dep = patches.find((p) => p.target.kind === "Deployment" && p.target.name.startsWith("slaude-node"))!;
    expect(dep.patch).not.toMatch(/^\s*- op:/m);
    for (const name of ["slaude-node", "slaude-node-finance", "slaude-node-team-a"]) expect(new RegExp(`^${dep.target.name}$`).test(name), name).toBe(true);
    for (const name of ["slaude-gateway", "slaude-nodes", "slaude-node-"]) expect(new RegExp(`^${dep.target.name}$`).test(name), name).toBe(false);
  });
});

describe("the fallback HPA for clusters without KEDA", () => {
  const text = readFileSync(join(root, "deploy/k8s-scale-box/optional/node-box-fallback-hpa.yaml"), "utf8");
  const hpas = parse(text);
  const baseHpas = parse(readFileSync(join(root, "deploy/k8s-scale/optional/node-cpu-fallback-hpa.yaml"), "utf8"));

  test("one per node label, with the base file's targets, bounds and slow scale-down", () => {
    expect(hpas.map((h) => h.spec.scaleTargetRef.name).sort()).toEqual(baseHpas.map((h) => h.spec.scaleTargetRef.name).sort());
    for (const h of hpas) {
      const b = baseHpas.find((x) => x.spec.scaleTargetRef.name === h.spec.scaleTargetRef.name)!;
      expect(h.kind).toBe("HorizontalPodAutoscaler");
      expect([h.spec.minReplicas, h.spec.maxReplicas]).toEqual([b.spec.minReplicas, b.spec.maxReplicas]);
      expect(h.spec.behavior.scaleDown.stabilizationWindowSeconds).toBe(600);
    }
  });

  test("ContainerResource metrics for boxd memory and CPU, not the pod's", () => {
    for (const h of hpas) {
      expect(h.spec.metrics).toEqual([
        { type: "ContainerResource", containerResource: { name: "memory", container: "boxd", target: { type: "Utilization", averageUtilization: 75 } } },
        { type: "ContainerResource", containerResource: { name: "cpu", container: "boxd", target: { type: "Utilization", averageUtilization: 70 } } },
      ]);
    }
  });

  test("its header says why memory is now the better signal, and it is not part of the kustomization", () => {
    expect(text).toContain("a warm sandbox holds");
    expect(text).toContain("it is the better signal of the two");
    const k = readFileSync(join(root, "deploy/k8s-scale-box/kustomization.yaml"), "utf8");
    expect((parse(k)[0].resources as string[]) ?? []).toEqual(["../k8s-scale"]);
  });
});
