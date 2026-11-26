import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const repo = join(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(join(repo, f), "utf8");
const MANIFESTS = ["deploy/k8s-scale/50-node.yaml", "docker-compose.scale.yaml", "docker-compose.yaml", "Dockerfile"];
/** `bun run worker` in shell, or as an exec-form array. */
const VIA_RUN = /\bbun\b["',\s]+run\b["',\s]+worker\b/;

describe("how a node is started", () => {
  // `bun run worker` leaves a parent bun process (PID 1 in a container) holding
  // the node token, never made non-dumpable: a same-uid tool reads /proc/1/environ.
  for (const f of MANIFESTS) {
    test(`${f} does not start a node through bun run`, () => {
      expect(read(f)).not.toMatch(VIA_RUN);
    });
  }

  test("the ban recognises both forms", () => {
    expect('command: ["bun", "run", "worker"]').toMatch(VIA_RUN);
    expect("bun run worker").toMatch(VIA_RUN);
    expect('command: ["bun", "--no-env-file", "src/node/main.ts"]').not.toMatch(VIA_RUN);
  });

  for (const f of ["deploy/k8s-scale/50-node.yaml", "docker-compose.scale.yaml", "docker-compose.yaml"]) {
    test(`${f} executes the node entry directly`, () => {
      expect(read(f)).toContain('["bun", "--no-env-file", "src/node/main.ts"]');
    });
  }

  // The box overlay adds a second container to every node pod. The node container must keep its entry, and the
  // supervisor has an entry rule of its own: under an init, with no dotenv file (box plan, Phase 9).
  const hasKubectl = Bun.spawnSync(["sh", "-c", "command -v kubectl"]).exitCode === 0;
  for (const dir of ["deploy/k8s-scale-box", "deploy/k8s-scale-box/with-s3"]) {
    test.skipIf(!hasKubectl)(`${dir}, rendered: the node entry is executed directly and boxd starts under tini with --no-env-file`, () => {
      const r = Bun.spawnSync(["kubectl", "kustomize", join(repo, dir)]);
      expect(r.exitCode).toBe(0);
      const out = r.stdout.toString();
      expect(out).not.toMatch(VIA_RUN);
      const pods = parseAllDocuments(out)
        .map((d) => d.toJSON())
        .filter((d) => d?.kind === "Deployment" && d.spec.template.spec.containers.some((c: any) => c.name === "node"));
      expect(pods.length).toBeGreaterThanOrEqual(2);
      for (const d of pods) {
        const byName = Object.fromEntries(d.spec.template.spec.containers.map((c: any) => [c.name, c]));
        expect(byName.node.command).toEqual(["bun", "--no-env-file", "src/node/main.ts"]);
        expect(byName.node.args).toBeUndefined();
        expect(byName.boxd.command.slice(0, 5)).toEqual(["tini", "--", "bun", "--no-env-file", "src/box/boxd/main.ts"]);
        // Nothing after the entry but the roots it may hand to a box.
        const rest = byName.boxd.command.slice(5) as string[];
        expect(rest.length % 2).toBe(0);
        for (let i = 0; i < rest.length; i += 2) {
          expect(["--mount-root", "--ro-root"]).toContain(rest[i]!);
          expect(rest[i + 1]).toMatch(/^\/[a-z-]+$/);
        }
      }
    });
  }

  test("a manifest that names the supervisor's entry starts it under tini, never through bun run", () => {
    const component = read("deploy/k8s-scale-box/component/kustomization.yaml");
    expect(component).toMatch(/^\s*command:.*boxd\/main\.ts/m);
    for (const f of ["deploy/k8s-scale-box/component/kustomization.yaml", "docker-compose.scale.yaml"]) {
      const text = read(f);
      expect(text).not.toMatch(/\bbun\b["',\s]+run\b["',\s]+[^"'\s]*boxd/);
      for (const line of text.split("\n").filter((l) => /^\s*command:.*boxd\/main\.ts/.test(l))) {
        expect(line).toContain('["tini", "--", "bun", "--no-env-file", "src/box/boxd/main.ts"');
      }
    }
  });

  test("hardening is the node entry's first import, and imports no configuration", () => {
    const main = read("src/node/main.ts");
    expect(main.match(/^import\s.*$/m)?.[0]).toContain('"./first-import"');
    for (const f of ["src/node/first-import.ts", "src/node/harden.ts"]) {
      const imports = [...read(f).matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
      expect(imports.filter((i) => i !== "bun:ffi" && i !== "./harden")).toEqual([]);
    }
  });

  test("the real entry ignores a planted $SLAUDE_HOME/.env, even with no SLAUDE_ROLE set", async () => {
    // Proves the entry mark lands before config/env.ts is evaluated.
    const home = mkdtempSync(join(tmpdir(), "node-entry-"));
    try {
      writeFileSync(join(home, ".env"), "SLAUDE_NODE_TOKEN=planted-by-a-turn\nSLAUDE_GATEWAY_URL=https://attacker.example.com\n");
      const proc = Bun.spawn(["bun", "--no-env-file", join(repo, "src/node/main.ts")], {
        cwd: home,
        env: { PATH: process.env.PATH ?? "", HOME: home, SLAUDE_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const text = out + err;
      expect(code).not.toBe(0);
      expect(text).toContain("ignoring $SLAUDE_HOME/.env");
      // Had the file been read, the token would be set and the node would go on.
      expect(text).toContain("SLAUDE_NODE_TOKEN is not set");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
