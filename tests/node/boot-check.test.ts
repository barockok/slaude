import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforceNodeBootCheck } from "../../src/node/boot-check";
import { m, metrics } from "../../src/metrics";

const GAUGE = "slaude_node_gateway_secrets_present";
const gaugeLine = () => metrics.render().split("\n").find((l) => l.startsWith(GAUGE));

function capture() {
  const lines: string[] = [];
  return { lines, log: (msg: string) => lines.push(msg) };
}

describe("enforceNodeBootCheck: Vault variables (R1-F3)", () => {
  test("any SLAUDE_VAULT_* or VAULT_* refuses the boot even in the default warn mode, naming only", () => {
    for (const env of [
      { SLAUDE_VAULT_ADDR: "https://vault.example.com" },
      { VAULT_TOKEN: "fake-vault-token-value" },
      { VAULT_ADDR: "https://vault.example.com", SLAUDE_NODE_BOOT_CHECK: "warn" },
    ]) {
      const c = capture();
      expect(enforceNodeBootCheck(env, c.log)).toBe(false);
      expect(c.lines.join("\n")).toContain("refusing to boot");
      expect(c.lines.join("\n")).not.toContain("fake-vault-token-value");
    }
  });
  test("an empty Vault variable is ignored", () => {
    expect(enforceNodeBootCheck({ VAULT_TOKEN: "" }, capture().log)).toBe(true);
  });
});

describe("enforceNodeBootCheck", () => {
  test("clean environment: boots, logs nothing, the gauge reads 0", () => {
    const c = capture();
    expect(enforceNodeBootCheck({ SLAUDE_NODE_TOKEN: "fake-node", SLAUDE_REDIS_URL: "redis://r" }, c.log)).toBe(true);
    expect(c.lines).toEqual([]);
    expect(gaugeLine()).toBe(`${GAUGE} 0`);
  });

  test("refuse is the default (v0.45.0): a node holding a gateway-only variable does not boot", () => {
    const c = capture();
    expect(enforceNodeBootCheck({ SLAUDE_NODE_TOKEN: "fake-node", SLAUDE_MASTER_KEY: "fake-master-value" }, c.log)).toBe(false);
    expect(c.lines.join("\n")).toContain("refusing to boot");
    expect(c.lines.join("\n")).toContain("SLAUDE_MASTER_KEY");
    expect(c.lines.join("\n")).not.toContain("fake-master-value");
  });

  test("an unknown value of a boot switch refuses the boot, naming the variable", () => {
    for (const bad of [{ SLAUDE_NODE_BOOT_CHECK: "warnn" }, { SLAUDE_NODE_ALLOW_GATEWAY_SECRETS: "y" }]) {
      const c = capture();
      expect(enforceNodeBootCheck({ SLAUDE_NODE_TOKEN: "fake-node", ...bad }, c.log)).toBe(false);
      expect(c.lines.join("\n")).toContain(Object.keys(bad)[0]!);
      expect(c.lines.join("\n")).toContain("refusing to boot");
    }
  });

  test("warn: one warning with the names, the gauge counts them, boot continues", () => {
    const c = capture();
    const ok = enforceNodeBootCheck(
      { SLAUDE_NODE_BOOT_CHECK: "warn", SLAUDE_NODE_TOKEN: "fake-node", SLAUDE_MASTER_KEY: "fake-master-value", SLAUDE_PG_URL: "postgres://u:fake-pw@h/db" },
      c.log,
    );
    expect(ok).toBe(true);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toContain("SLAUDE_MASTER_KEY");
    expect(c.lines[0]).toContain("SLAUDE_PG_URL");
    expect(c.lines[0]).not.toContain("fake-master-value");
    expect(c.lines[0]).not.toContain("fake-pw");
    expect(gaugeLine()).toBe(`${GAUGE} 2`);
  });

  test("refuse: returns false so the caller exits, names only", () => {
    const c = capture();
    const ok = enforceNodeBootCheck({ SLAUDE_NODE_BOOT_CHECK: "refuse", SLAUDE_JOB_SECRET: "fake-job-value" }, c.log);
    expect(ok).toBe(false);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toContain("SLAUDE_JOB_SECRET");
    expect(c.lines[0]).not.toContain("fake-job-value");
    expect(gaugeLine()).toBe(`${GAUGE} 1`);
  });

  test("refuse with SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1 warns and boots", () => {
    const c = capture();
    const ok = enforceNodeBootCheck(
      { SLAUDE_NODE_BOOT_CHECK: "refuse", SLAUDE_NODE_ALLOW_GATEWAY_SECRETS: "1", SLAUDE_JOB_SECRET: "fake-job-value" },
      c.log,
    );
    expect(ok).toBe(true);
    expect(c.lines[0]).toContain("SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1");
  });
});

describe("enforceNodeBootCheck and a broken metric", () => {
  test("a metrics failure never stops a node and never hides the warning", () => {
    const spy = spyOn(m.nodeGatewaySecretsPresent, "set").mockImplementation(() => {
      throw new Error("registry broken");
    });
    try {
      const c = capture();
      expect(enforceNodeBootCheck({ SLAUDE_NODE_BOOT_CHECK: "warn", SLAUDE_MASTER_KEY: "fake" }, c.log)).toBe(true);
      expect(c.lines[0]).toContain("SLAUDE_MASTER_KEY");
      expect(enforceNodeBootCheck({}, c.log)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// The entry wiring: the check runs before anything else at node boot, and a
// refusal exits non-zero without printing a value. Only the refusing path is
// run as a process: a passing check would go on to connect to Redis.
describe("src/node/main.ts", () => {
  test("the default (refuse) exits non-zero naming the variable, not its value", async () => {
    const home = mkdtempSync(join(tmpdir(), "slaude-boot-check-"));
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/node/main.ts")], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          SLAUDE_HOME: home,
          SLAUDE_ROLE: "node",
          SLAUDE_NODE_TOKEN: "fake-node-token-value",
          SLAUDE_MASTER_KEY: "fake-master-key-value",
          SLAUDE_REDIS_URL: "redis://127.0.0.1:1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      expect(code).not.toBe(0);
      expect(out).toContain("SLAUDE_MASTER_KEY");
      expect(out).toContain("refusing to boot");
      expect(out).not.toContain("fake-master-key-value");
      expect(out).not.toContain("fake-node-token-value");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
