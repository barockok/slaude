/**
 * The optional box supervisor in docker-compose.scale.yaml (box plan, Phase 9).
 * It sits behind a compose profile, so `docker compose up` is what it was:
 * no privileged container, the gateway reads no box, the nodes offer tier
 * `none`. With the profile, each node has one supervisor that holds nothing.
 *
 * Read from the file. The profile was never started as a stack.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { boxdRefusedEnv } from "../../src/box/boxd/env-check";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";

const ROOT = join(import.meta.dir, "..", "..");
type Service = Record<string, any>;
const load = (f: string) => Bun.YAML.parse(readFileSync(join(ROOT, f), "utf8")) as { services: Record<string, Service>; volumes?: Record<string, unknown> };
const scale = load("docker-compose.scale.yaml");
/** `${VAR:-default}` to its default, as compose resolves it with nothing set. */
const dflt = (v: unknown) => String(v).replace(/\$\{[A-Z0-9_]+:?-([^}]*)\}/g, "$1");
const inProfile = (s: Service) => Array.isArray(s.profiles) && s.profiles.length > 0;
const isBoxd = (s: Service) => JSON.stringify(s.command ?? "").includes("src/box/boxd/main.ts");
const nodes = Object.entries(scale.services).filter(([, s]) => s.environment?.SLAUDE_ROLE === "node");
const boxds = Object.entries(scale.services).filter(([, s]) => isBoxd(s));
const volumeAt = (s: Service, path: string): string | undefined => (s.volumes as string[]).map((v) => v.split(":")).find((p) => p[1] === path)?.[0];

describe("docker-compose.scale.yaml without the boxes profile: the defaults", () => {
  const started = Object.entries(scale.services).filter(([, s]) => !inProfile(s));

  test("the services a plain `up` starts are the ones it always started", () => {
    expect(started.map(([n]) => n).sort()).toEqual(["gateway", "node-1", "node-2", "postgres", "redis"]);
  });

  test("none of them is privileged, adds a capability or shares a host namespace", () => {
    for (const [name, s] of started) {
      expect(s.privileged ?? false, name).toBe(false);
      expect(s.cap_add, name).toBeUndefined();
      expect(s.pid, name).toBeUndefined();
      expect(s.network_mode, name).toBeUndefined();
    }
  });

  test("the nodes offer tier none and the gateway reads no box, unless the operator sets the variables", () => {
    expect(nodes.length).toBe(2);
    for (const [name, s] of nodes) {
      expect(s.environment.SLAUDE_BOX_TIER, name).toBe("${SLAUDE_BOX_TIER:-none}");
      expect(dflt(s.environment.SLAUDE_BOX_TIER)).toBe("none");
      expect(s.command).toEqual(["bun", "--no-env-file", "src/node/main.ts"]);
      expect(s.depends_on.gateway.condition).toBe("service_healthy");
      // A node does not wait for a supervisor that the default never starts.
      expect(Object.keys(s.depends_on)).toEqual(["gateway"]);
    }
    expect(dflt(scale.services.gateway!.environment.SLAUDE_BOX)).toBe("off");
  });

  test("no other compose file has a privileged service or a supervisor", () => {
    for (const f of readdirSync(ROOT).filter((x) => /^docker-compose.*\.ya?ml$/.test(x) && x !== "docker-compose.scale.yaml")) {
      for (const [name, s] of Object.entries(load(f).services)) {
        expect(s.privileged ?? false, `${f} ${name}`).toBe(false);
        expect(isBoxd(s), `${f} ${name}`).toBe(false);
      }
    }
  });
});

describe("docker-compose.scale.yaml, the boxes profile", () => {
  test("one supervisor per node, each only in the profile, and nothing else is", () => {
    expect(boxds.map(([n]) => n).sort()).toEqual(["boxd-1", "boxd-2"]);
    for (const [name, s] of boxds) expect(s.profiles, name).toEqual(["boxes"]);
    expect(Object.entries(scale.services).filter(([, s]) => inProfile(s)).map(([n]) => n).sort()).toEqual(["boxd-1", "boxd-2"]);
    // Privileged is the supervisors' alone.
    expect(Object.entries(scale.services).filter(([, s]) => s.privileged).map(([n]) => n).sort()).toEqual(["boxd-1", "boxd-2"]);
  });

  test("a supervisor is started under tini with no dotenv file, on the roots a node hands out", () => {
    for (const [name, s] of boxds) {
      expect(s.command, name).toEqual(["tini", "--", "bun", "--no-env-file", "src/box/boxd/main.ts", "--mount-root", "/data", "--mount-root", "/config-home", "--ro-root", "/app"]);
      expect(s.entrypoint, name).toBeUndefined();
      expect(s.image).toBe(scale.services["node-1"]!.image);
    }
  });

  test("a supervisor holds nothing: no env_file, no variable it would refuse, no interpolated secret, no network", () => {
    for (const [name, s] of boxds) {
      expect(s.env_file, name).toBeUndefined();
      expect(s.secrets, name).toBeUndefined();
      const e = s.environment as Record<string, string>;
      expect(Object.keys(e).sort()).toEqual(["SLAUDE_BOXD_SOCKET", "SLAUDE_BOX_DIR", "SLAUDE_BOX_TIER"]);
      expect(boxdRefusedEnv(e)).toEqual([]);
      expect(Object.keys(e).filter(isGatewayOnlyEnv)).toEqual([]);
      // The only value taken from the operator's shell is the tier.
      const interpolated = [...JSON.stringify(s).matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
      expect(interpolated).toEqual(["SLAUDE_BOXD_MEMORY", "SLAUDE_BOX_TIER"]);
      expect(s.network_mode).toBe("none");
      expect(s.ports).toBeUndefined();
      expect(["gvisor", "bwrap"]).toContain(dflt(e.SLAUDE_BOX_TIER));
    }
  });

  test("each supervisor shares its socket, box, home and config volumes with exactly one node, at the same paths", () => {
    const pairs = [["node-1", "boxd-1"], ["node-2", "boxd-2"]] as const;
    const boxVolumes = new Set<string>();
    for (const [n, b] of pairs) {
      const node = scale.services[n]!;
      const boxd = scale.services[b]!;
      for (const path of ["/data", "/run/slaude-box", "/var/lib/slaude-box", "/config-home"]) {
        expect(volumeAt(node, path), `${n} ${path}`).toBeDefined();
        expect(volumeAt(boxd, path), `${b} ${path}`).toBe(volumeAt(node, path)!);
      }
      expect(node.environment.SLAUDE_BOX_DIR).toBe(boxd.environment.SLAUDE_BOX_DIR);
      expect(node.environment.SLAUDE_BOXD_SOCKET).toBe(boxd.environment.SLAUDE_BOXD_SOCKET);
      for (const path of ["/run/slaude-box", "/var/lib/slaude-box", "/config-home"]) {
        const v = volumeAt(node, path)!;
        expect(boxVolumes.has(v), `${v} is shared by two nodes`).toBe(false);
        boxVolumes.add(v);
        expect(Object.keys(scale.volumes ?? {})).toContain(v);
      }
    }
  });

  test("a supervisor has a memory limit to read and its own cgroup namespace, and the default box count fits the default limit", async () => {
    const { checkSizing } = await import("../../src/box/capacity");
    const { DEFAULT_BOX_RESOURCES, defaultMemoryReserveMb } = await import("../../src/box/policy");
    for (const [name, s] of boxds) {
      expect(s.cgroup, name).toBe("private");
      const m = /^(\d+)g$/.exec(dflt(s.mem_limit));
      expect(m, name).not.toBeNull();
      const r = checkSizing({
        maxBoxes: Number(dflt(scale.services["node-1"]!.environment.SLAUDE_NODE_MAX_BOXES)),
        memoryBudgetMb: null,
        memoryLimitMb: Number(m![1]) * 1024,
        overheadMb: 150,
        smallestReserveMb: defaultMemoryReserveMb(DEFAULT_BOX_RESOURCES.memoryMb),
        diskMb: null,
        imageBudgetMb: 0,
        parkBudgetMb: 0,
        turnConcurrency: 1,
      });
      expect(r.errors, name).toEqual([]);
    }
  });

  test("the file says the profile was never started as a stack", () => {
    expect(readFileSync(join(ROOT, "docker-compose.scale.yaml"), "utf8")).toContain("NOT RUN as a compose stack");
  });
});
