import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

// YAML-only assertions: rendering the base needs generated secrets.env/provider.env, which
// must not be created in the repo tree. The files are the overlay's own, so parsing them is enough.
const dir = import.meta.dir;
const parse = (text: string): any[] => parseAllDocuments(text).map((d) => d.toJSON());
const load = (file: string): any[] => parse(readFileSync(join(dir, file), "utf8"));

const mock = load("mock-llm.yaml");
const fake = load("fake-slack.yaml");
const kustomization = load("kustomization.yaml")[0];

describe("e2e overlay", () => {
  for (const [name, docs] of [["mock-llm", mock], ["fake-slack", fake]] as const) {
    const dep = docs.find((d) => d.kind === "Deployment");
    const svc = docs.find((d) => d.kind === "Service");

    test(`${name} runs as exactly one replica`, () => {
      expect(dep.metadata.name).toBe(name);
      expect(dep.spec.replicas).toBe(1);
    });

    test(`${name} never pulls its image`, () => {
      for (const c of dep.spec.template.spec.containers) expect(c.imagePullPolicy).toBe("Never");
      expect(dep.spec.template.spec.containers[0].image).toBe(`slaude-${name}:dev`);
    });

    test(`${name} Service exposes 8080 and selects the pods`, () => {
      expect(svc.metadata.name).toBe(name);
      expect(svc.spec.ports.map((p: any) => p.port)).toContain(8080);
      expect(svc.spec.selector).toEqual(dep.spec.template.metadata.labels);
    });
  }

  test("fake-slack builds response_url from its in-cluster Service", () => {
    const env = fake.find((d) => d.kind === "Deployment").spec.template.spec.containers[0].env;
    expect(env.find((e: any) => e.name === "FAKE_SLACK_PUBLIC_URL").value).toBe("http://fake-slack:8080");
  });

  test("the ConfigMap patch points the gateway tier at the fake's /api/", () => {
    const patch = kustomization.patches.map((p: any) => parse(p.patch)[0]).find((d: any) => d.kind === "ConfigMap");
    expect(patch.metadata.name).toBe("slaude-scale-config");
    expect(patch.data.SLAUDE_SLACK_API_URL).toBe("http://fake-slack:8080/api/");
    expect(patch.data.SLAUDE_SLACK_API_URL.endsWith("/api/")).toBe(true);
  });

  test("the ConfigMap patch sets a SLACK_BOT_TOKEN placeholder that is not token-shaped", () => {
    const patch = kustomization.patches.map((p: any) => parse(p.patch)[0]).find((d: any) => d.kind === "ConfigMap");
    const v = patch.data.SLACK_BOT_TOKEN;
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
    expect(v).not.toMatch(/^xox/i);
    expect(v).toContain("placeholder");
  });

  test("dev-postgres is Ready only once the real server listens on TCP, not the init-phase socket server", () => {
    const patch = kustomization.patches.map((p: any) => parse(p.patch)[0]).find((d: any) => d.kind === "Deployment" && d.metadata.name === "dev-postgres");
    const c = patch.spec.template.spec.containers.find((x: any) => x.name === "postgres");
    expect(c.readinessProbe.exec.command).toEqual(["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "slaude"]);
  });

  test("the gateway's soul cache is the shared-volume directory nodes read, not the base's pod-local one", () => {
    const base = (file: string) => parse(readFileSync(join(dir, "../../deploy/k8s-scale", file), "utf8"));
    const container = (file: string, name: string) =>
      base(file).find((d) => d.kind === "Deployment").spec.template.spec.containers.find((c: any) => c.name === name);
    const envOf = (c: any, n: string) => c.env?.find((e: any) => e.name === n)?.value;
    const gw = container("40-gateway.yaml", "gateway");
    const node = container("50-node.yaml", "node");
    const home = envOf(gw, "SLAUDE_HOME");
    // The base still keeps the gateway's cache pod-local, which is what this patch overrides.
    const local = envOf(gw, "SLAUDE_SOUL_CACHE_DIR");
    expect(local).toBeTruthy();
    expect(local.startsWith(`${home}/`)).toBe(false);
    // Nodes share $SLAUDE_HOME with the gateway and use the default cache directory under it.
    expect(envOf(node, "SLAUDE_HOME")).toBe(home);
    expect(envOf(node, "SLAUDE_SOUL_CACHE_DIR")).toBeUndefined();
    // $SLAUDE_HOME is the shared claim's mount in both tiers.
    for (const c of [gw, node]) expect(c.volumeMounts.find((m: any) => m.name === "slaude-home").mountPath).toBe(home);

    const patch = kustomization.patches
      .map((p: any) => parse(p.patch)[0])
      .find((d: any) => d.kind === "Deployment" && d.metadata.name === "slaude-gateway");
    const patched = patch.spec.template.spec.containers.find((c: any) => c.name === "gateway");
    expect(envOf(patched, "SLAUDE_SOUL_CACHE_DIR")).toBe(`${home}/cache`);
    // Env only: the patch adds no volume, mount, image or other env.
    expect(Object.keys(patched).sort()).toEqual(["env", "name"]);
    expect(patched.env).toHaveLength(1);
  });

  test("the overlay builds on deploy/k8s-local and includes both services", () => {
    expect(kustomization.resources).toEqual(["../../deploy/k8s-local", "mock-llm.yaml", "fake-slack.yaml"]);
  });

  test("e2e/up.sh scrubs every credential name deploy/k8s-local/up.sh reads", () => {
    const base = readFileSync(join(dir, "../../deploy/k8s-local/up.sh"), "utf8");
    const e2e = readFileSync(join(dir, "../up.sh"), "utf8");
    const keys = base.match(/^PROVIDER_KEYS=\(([^)]*)\)/m)?.[1]?.trim().split(/\s+/) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    const scrub = e2e.match(/^SCRUB=\(([^)]*)\)/m)?.[1]?.trim().split(/\s+/) ?? [];
    for (const k of [...keys, "SLAUDE_LOCAL_ENV_FILE"]) expect(scrub).toContain(k);
    expect(e2e).toContain('unset_args+=(-u "$name")');
    expect(e2e).toMatch(/env "\$\{unset_args\[@\]\}"/);
  });
});
