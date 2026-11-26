/**
 * The local cluster's box switch (SLAUDE_LOCAL_BOX, box plan Phase 9): off by
 * default; on, up.sh lays deploy/k8s-local/box over the overlay it would have
 * applied anyway, through a generated wrapper (lib.sh, box_overlay).
 *
 * Renders with `kubectl kustomize` from a staged copy (the overlay reads files
 * up.sh generates). Nothing here touches a cluster, and no cluster was ever
 * brought up with the switch on.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { boxdRefusedEnv } from "../../src/box/boxd/env-check";
import { checkSizing } from "../../src/box/capacity";
import { DEFAULT_BOX_RESOURCES, defaultMemoryReserveMb } from "../../src/box/policy";
import { stageLocal } from "./stage-local";

const root = join(import.meta.dir, "../..");
const hasKubectl = Bun.spawnSync(["sh", "-c", "command -v kubectl"]).exitCode === 0;
const parse = (text: string): any[] => parseAllDocuments(text).map((d) => d.toJSON()).filter(Boolean);
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "slaude-local-box-")));
/** Wrapper overlays box_overlay made (temp directories, the caller's to remove). */
const wrappers: string[] = [];
afterAll(() => {
  for (const d of [tmp, ...wrappers]) rmSync(d, { recursive: true, force: true });
});
stageLocal(tmp);
const here = join(tmp, "deploy/k8s-local");

/** Run lib.sh's box_overlay the way up.sh does; `die` prints and fails. */
function boxOverlay(overlay: string, tier: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(
    ["bash", "-c", `die() { printf 'ERROR: %s\\n' "$*" >&2; return 1; }; . "$1/lib.sh"; box_overlay "$1" "$2" "$3"`, "bash", here, overlay, tier],
    { stdout: "pipe", stderr: "pipe" },
  );
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
}
/** Render an overlay with the switch on. */
function withBox(overlay: string, tier: string): any[] {
  const w = boxOverlay(overlay, tier);
  if (w.code !== 0) throw new Error(w.err);
  wrappers.push(w.out);
  return kustomize(w.out);
}
function kustomize(dir: string): any[] {
  const r = Bun.spawnSync(["kubectl", "kustomize", "--load-restrictor", "LoadRestrictionsNone", dir]);
  if (r.exitCode !== 0) throw new Error(`kubectl kustomize ${dir} failed: ${r.stderr.toString()}`);
  return parse(r.stdout.toString());
}
const nodePods = (docs: any[]) => docs.filter((d) => d.kind === "Deployment" && d.spec.template.spec.containers.some((c: any) => c.name === "node"));
const containerOf = (dep: any, name: string) => dep.spec.template.spec.containers.find((c: any) => c.name === name);
const envValue = (c: any, name: string): string | undefined => (c.env ?? []).find((e: any) => e.name === name)?.value;
const mb = (q: string) => Number(/^(\d+)/.exec(q)![1]) * (q.endsWith("Gi") ? 1024 : 1);

describe("box_overlay (lib.sh)", () => {
  test("off prints the overlay unchanged and writes nothing", () => {
    const r = boxOverlay(here, "off");
    expect(r).toEqual({ code: 0, out: here, err: "" });
  });

  test("an unknown tier is refused by name", () => {
    const r = boxOverlay(here, "none");
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("SLAUDE_LOCAL_BOX must be off, gvisor or bwrap");
  });

  test("a directory with no kustomization is refused", () => {
    const r = boxOverlay(join(here, "probe"), "gvisor");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no kustomization.yaml");
  });

  test("gvisor writes a wrapper outside the overlay, naming it and the component by relative path", () => {
    const r = boxOverlay(here, "gvisor");
    expect(r.code).toBe(0);
    wrappers.push(r.out);
    // Never inside the overlay or the repository: kustomize refuses a kustomization inside what it builds on.
    expect(realpathSync(r.out).startsWith(tmp)).toBe(false);
    expect(realpathSync(r.out).startsWith(realpathSync(root))).toBe(false);
    const k = parse(readFileSync(join(r.out, "kustomization.yaml"), "utf8"))[0];
    expect(k.resources.length).toBe(1);
    expect(k.components.length).toBe(1);
    for (const rel of [...k.resources, ...k.components]) expect(isAbsolute(rel)).toBe(false);
    expect(realpathSync(resolve(realpathSync(r.out), k.resources[0]))).toBe(here);
    expect(realpathSync(resolve(realpathSync(r.out), k.components[0]))).toBe(join(here, "box"));
  });

  test("the e2e overlay is wrapped the same way, and bwrap picks the bwrap component", () => {
    const r = boxOverlay(join(tmp, "e2e/k8s"), "bwrap");
    expect(r.code).toBe(0);
    wrappers.push(r.out);
    const k = parse(readFileSync(join(r.out, "kustomization.yaml"), "utf8"))[0];
    expect(realpathSync(resolve(realpathSync(r.out), k.resources[0]))).toBe(join(tmp, "e2e/k8s"));
    expect(realpathSync(resolve(realpathSync(r.out), k.components[0]))).toBe(join(here, "box-bwrap"));
  });

  test("each call makes a wrapper of its own", () => {
    const a = boxOverlay(here, "gvisor").out;
    const b = boxOverlay(here, "gvisor").out;
    wrappers.push(a, b);
    expect(a).not.toBe(b);
  });
});

for (const [tier, overlay] of [
  ["gvisor", "deploy/k8s-local"],
  ["bwrap", "deploy/k8s-local"],
  ["gvisor", "e2e/k8s"],
] as const) {
  describe.skipIf(!hasKubectl)(`SLAUDE_LOCAL_BOX=${tier} over ${overlay}, rendered`, () => {
    const base = hasKubectl ? kustomize(join(tmp, overlay)) : [];
    const docs = hasKubectl ? withBox(join(tmp, overlay), tier) : [];

    test("the same objects as without the switch", () => {
      const key = (x: any) => `${x.kind}/${x.metadata?.name}`;
      expect(docs.map(key).sort()).toEqual(base.map(key).sort());
    });

    test("every node pod gains boxd on the local image, privileged, with nothing in its environment but the three box settings", () => {
      expect(nodePods(docs).length).toBe(2);
      for (const dep of nodePods(docs)) {
        expect(dep.spec.template.spec.containers.map((c: any) => c.name)).toEqual(["node", "boxd"]);
        const boxd = containerOf(dep, "boxd");
        const node = containerOf(dep, "node");
        expect(boxd.image).toBe("slaude:local");
        expect(boxd.image).toBe(node.image);
        expect(boxd.imagePullPolicy).toBe("Never");
        expect(boxd.securityContext).toEqual({ privileged: true });
        expect(node.securityContext?.privileged ?? false).toBe(false);
        expect(boxd.envFrom).toBeUndefined();
        expect(boxd.env.map((e: any) => e.name).sort()).toEqual(["SLAUDE_BOXD_SOCKET", "SLAUDE_BOX_DIR", "SLAUDE_BOX_TIER"]);
        expect(boxdRefusedEnv(Object.fromEntries(boxd.env.map((e: any) => [e.name, e.value])))).toEqual([]);
        expect(boxd.command.slice(0, 5)).toEqual(["tini", "--", "bun", "--no-env-file", "src/box/boxd/main.ts"]);
        expect(node.command).toEqual(["bun", "--no-env-file", "src/node/main.ts"]);
      }
    });

    test(`both containers of every node pod name tier ${tier}`, () => {
      for (const dep of nodePods(docs)) {
        expect(envValue(containerOf(dep, "node"), "SLAUDE_BOX_TIER")).toBe(tier);
        expect(envValue(containerOf(dep, "boxd"), "SLAUDE_BOX_TIER")).toBe(tier);
      }
    });

    test("the node container keeps the local overlay's size, and the laptop numbers pass the node's sizing check", () => {
      for (const dep of nodePods(docs)) {
        const before = containerOf(base.find((x) => x.kind === "Deployment" && x.metadata.name === dep.metadata.name), "node");
        const node = containerOf(dep, "node");
        const boxd = containerOf(dep, "boxd");
        expect(node.resources).toEqual(before.resources);
        const r = checkSizing({
          maxBoxes: Number(envValue(node, "SLAUDE_NODE_MAX_BOXES")),
          memoryBudgetMb: null,
          memoryLimitMb: mb(boxd.resources.limits.memory),
          overheadMb: 150,
          smallestReserveMb: defaultMemoryReserveMb(DEFAULT_BOX_RESOURCES.memoryMb),
          diskMb: mb(dep.spec.template.spec.volumes.find((v: any) => v.name === "box-data").emptyDir.sizeLimit),
          imageBudgetMb: Number(envValue(node, "SLAUDE_BOX_IMAGE_BUDGET_MB")),
          parkBudgetMb: Number(envValue(node, "SLAUDE_BOX_PARK_BUDGET_MB")),
          turnConcurrency: 1,
        });
        expect(r.errors, dep.metadata.name).toEqual([]);
      }
    });

    test("the gateways read boxes; without the switch nothing mentions them", () => {
      const gw = docs.find((x) => x.kind === "Deployment" && x.metadata.name === "slaude-gateway");
      expect(envValue(containerOf(gw, "gateway"), "SLAUDE_BOX")).toBe("on");
      for (const x of base) {
        for (const c of x.spec?.template?.spec?.containers ?? []) {
          expect((c.env ?? []).filter((e: any) => String(e.name).startsWith("SLAUDE_BOX")), `${x.metadata.name}/${c.name}`).toEqual([]);
          expect(c.securityContext?.privileged ?? false, `${x.metadata.name}/${c.name}`).toBe(false);
          expect(c.name).not.toBe("boxd");
        }
      }
    });
  });
}

describe("sizing and up.sh", () => {
  const sizing = Object.fromEntries(
    readFileSync(join(root, "deploy/k8s-local/sizing.env"), "utf8")
      .split("\n")
      .map((l) => /^([A-Z_]+)=(\d+)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m![1], Number(m![2])]),
  ) as Record<string, number>;
  const up = readFileSync(join(root, "deploy/k8s-local/up.sh"), "utf8");

  test.skipIf(!hasKubectl)("sizing.env's box extras cover the supervisors' summed limits at the pinned replica counts", () => {
    const docs = withBox(here, "gvisor");
    let memory = 0;
    let millicpu = 0;
    for (const dep of nodePods(docs)) {
      const lim = containerOf(dep, "boxd").resources.limits;
      memory += dep.spec.replicas * mb(lim.memory);
      millicpu += dep.spec.replicas * (String(lim.cpu).endsWith("m") ? Number(String(lim.cpu).slice(0, -1)) : Number(lim.cpu) * 1000);
    }
    expect(memory).toBeGreaterThan(0);
    expect(sizing.LOCAL_BOX_EXTRA_MEMORY_MB).toBeGreaterThanOrEqual(memory);
    expect(sizing.LOCAL_BOX_EXTRA_CPUS! * 1000).toBeGreaterThanOrEqual(millicpu);
  });

  test("the switch defaults to off, is validated before anything runs, and only then grows the node", () => {
    expect(up).toContain('BOX="${SLAUDE_LOCAL_BOX:-off}"');
    expect(up.indexOf('BOX="${SLAUDE_LOCAL_BOX:-off}"')).toBeLessThan(up.indexOf("minikube -p"));
    expect(up).toContain('[[ -n "${SLAUDE_LOCAL_CPUS:-}" ]] || CPUS=$((LOCAL_NODE_CPUS + LOCAL_BOX_EXTRA_CPUS))');
    expect(up).toContain('[[ -n "${SLAUDE_LOCAL_MEMORY:-}" ]] || MEMORY=$((LOCAL_NODE_MEMORY_MB + LOCAL_BOX_EXTRA_MEMORY_MB))');
    // Both sit inside the one block the switch guards.
    const block = up.slice(up.indexOf('if [[ "$BOX" != off ]]; then'), up.indexOf("IMAGE="));
    expect(block).toContain("LOCAL_BOX_EXTRA_CPUS");
    expect(block).toContain("LOCAL_BOX_EXTRA_MEMORY_MB");
    expect(up).toContain('OVERLAY="$(box_overlay "$HERE" "${SLAUDE_LOCAL_OVERLAY:-$HERE}" "$BOX")"');
    expect(up).toContain("NOT RUN");
  });

  test("a bad value stops up.sh before any tool is called", () => {
    const r = Bun.spawnSync(["bash", join(root, "deploy/k8s-local/up.sh")], {
      env: { PATH: "/usr/bin:/bin", SLAUDE_LOCAL_BOX: "runsc", HOME: tmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("SLAUDE_LOCAL_BOX must be off, gvisor or bwrap");
    expect(r.stdout.toString()).toBe("");
  });

  test("up.sh removes the wrapper it had generated, and the component files say they were not run", () => {
    expect(up).toContain('if [[ "$BOX" != off ]]; then rm -rf "$OVERLAY"; fi');
    expect(readFileSync(join(root, "deploy/k8s-local/box/kustomization.yaml"), "utf8")).toContain("NOT RUN");
    expect(readFileSync(join(root, "deploy/k8s-local/box-bwrap/kustomization.yaml"), "utf8")).toContain("NOT RUN");
  });
});
