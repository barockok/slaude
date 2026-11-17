import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
