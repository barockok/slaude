/**
 * deploy/k8s-scale-box as BUILT (box plan, Phase 6): every node label's
 * ScaledObject carries the memory and CPU triggers on the supervisor
 * container beside its wait-list trigger, the grace period covers the drain
 * window plus the flush of the warm boxes, the base is untouched, and the
 * fallback HPA for clusters without KEDA uses ContainerResource metrics.
 *
 * Needs kubectl (its built-in kustomize); the rendered half is skipped without it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { drainGraceSec } from "../../src/box/capacity";

const root = join(import.meta.dir, "../..");
const hasKubectl = Bun.spawnSync(["sh", "-c", "command -v kubectl"]).exitCode === 0;
const parse = (text: string): any[] => parseAllDocuments(text).map((d) => d.toJSON()).filter(Boolean);
function kustomize(dir: string): any[] {
  const r = Bun.spawnSync(["kubectl", "kustomize", "--load-restrictor", "LoadRestrictionsNone", join(root, dir)]);
  if (r.exitCode !== 0) throw new Error(`kubectl kustomize ${dir} failed: ${r.stderr.toString()}`);
  return parse(r.stdout.toString());
}
const d = describe.skipIf(!hasKubectl);

d("deploy/k8s-scale-box, rendered", () => {
  const docs = hasKubectl ? kustomize("deploy/k8s-scale-box") : [];
  const base = hasKubectl ? kustomize("deploy/k8s-scale") : [];
  const nodeDeployments = (set: any[]) => set.filter((x) => x.kind === "Deployment" && x.metadata.name.startsWith("slaude-node"));
  const scaled = (set: any[]) => set.filter((x) => x.kind === "ScaledObject");

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
      // The default of 8 boxes, and the worked example's 10, both drain inside it.
      expect(drainGraceSec({ drainSec, warmBoxes: 8 })).toBeLessThan(grace);
      expect(drainGraceSec({ drainSec, warmBoxes: 10 })).toBeLessThan(grace);
    }
    // The gateway is not a node: its grace period is not touched.
    const gw = docs.find((x) => x.kind === "Deployment" && x.metadata.name === "slaude-gateway");
    const baseGw = base.find((x) => x.kind === "Deployment" && x.metadata.name === "slaude-gateway");
    expect(gw.spec.template.spec.terminationGracePeriodSeconds).toBe(baseGw.spec.template.spec.terminationGracePeriodSeconds);
  });

  test("the base is untouched: no box trigger, the old grace period", () => {
    for (const s of scaled(base)) expect(s.spec.triggers.map((t: any) => t.type)).toEqual(["redis"]);
    for (const dep of nodeDeployments(base)) expect(dep.spec.template.spec.terminationGracePeriodSeconds).toBe(150);
  });

  test("the overlay changes nothing else: the same objects, and no privileged container yet", () => {
    const key = (x: any) => `${x.kind}/${x.metadata?.name}`;
    expect(docs.map(key).sort()).toEqual(base.map(key).sort());
    for (const dep of nodeDeployments(docs)) {
      expect(dep.spec.template.spec.containers.map((c: any) => c.name)).toEqual(["node"]);
      for (const c of dep.spec.template.spec.containers) expect(c.securityContext?.privileged ?? false).toBe(false);
    }
    // No HPA is rendered: the fallback is opt-in, never beside KEDA.
    expect(docs.filter((x) => x.kind === "HorizontalPodAutoscaler")).toEqual([]);
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
    const resources = (parse(k)[0].resources as string[]) ?? [];
    expect(resources).toEqual(["../k8s-scale"]);
    expect(k).toContain("DO NOT APPLY YET");
  });
});
