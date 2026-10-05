/**
 * A node refuses to boot when its environment holds a gateway-only variable
 * (SLAUDE_NODE_BOOT_CHECK=refuse, the default since v0.45.0). Every compose
 * file's worker service therefore must not load the gateway's env file, and
 * the example env file it does load must name no gateway-only variable
 * (src/config/gateway-only-env.ts), set or commented out.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";

const ROOT = join(import.meta.dir, "..", "..");
const COMPOSE_FILES = readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));

/** `${VAR:-default}` -> default; a plain path is itself. */
const defaultOf = (p: string) => p.replace(/\$\{[A-Z0-9_]+:?-([^}]*)\}/g, "$1");

type Service = { command?: unknown; environment?: unknown; env_file?: unknown };

const envFiles = (s: Service): string[] => {
  const raw = s.env_file;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.map((e) => defaultOf(typeof e === "string" ? e : String((e as { path: string }).path)));
};
const envKeys = (s: Service): string[] => {
  const e = s.environment;
  if (!e) return [];
  if (Array.isArray(e)) return e.map((x) => String(x).split("=")[0]!);
  return Object.keys(e as object);
};
const roleOf = (s: Service): string | undefined => {
  const e = s.environment;
  if (!e) return undefined;
  if (Array.isArray(e)) return e.map(String).find((x) => x.startsWith("SLAUDE_ROLE="))?.split("=")[1];
  return (e as Record<string, string>).SLAUDE_ROLE;
};
const isWorker = (s: Service) => JSON.stringify(s.command ?? "").includes("worker") || roleOf(s) === "node";

/** Every variable an env file names, assigned or commented out (`# NAME=`). */
const namesIn = (file: string): string[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((l) => /^\s*#?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter((n): n is string => !!n);

describe("compose worker services load no gateway-only variable", () => {
  test("there is at least one compose file with a worker", () => {
    const workers = COMPOSE_FILES.flatMap((f) => Object.values((Bun.YAML.parse(readFileSync(join(ROOT, f), "utf8")) as { services: Record<string, Service> }).services).filter(isWorker));
    expect(workers.length).toBeGreaterThan(0);
  });

  for (const file of COMPOSE_FILES) {
    test(`${file}: worker env_file and environment`, () => {
      const services = (Bun.YAML.parse(readFileSync(join(ROOT, file), "utf8")) as { services: Record<string, Service> }).services;
      const gatewayFiles = new Set(Object.values(services).filter((s) => !isWorker(s)).flatMap(envFiles));
      for (const [name, svc] of Object.entries(services)) {
        if (!isWorker(svc)) continue;
        expect({ service: name, gatewayOnly: envKeys(svc).filter(isGatewayOnlyEnv) }).toEqual({ service: name, gatewayOnly: [] });
        for (const ef of envFiles(svc)) {
          // Never the gateway's own env file.
          expect({ service: name, sharesGatewayEnvFile: gatewayFiles.has(ef) }).toEqual({ service: name, sharesGatewayEnvFile: false });
          // The example the operator copies from exists and names only node variables.
          const example = join(ROOT, `${ef}.example`);
          expect({ service: name, example: ef + ".example", exists: existsSync(example) }).toEqual({ service: name, example: ef + ".example", exists: true });
          expect({ service: name, gatewayOnly: namesIn(example).filter(isGatewayOnlyEnv) }).toEqual({ service: name, gatewayOnly: [] });
        }
      }
    });
  }

  test("the detector sees the gateway's example: .env.example names gateway-only variables", () => {
    expect(namesIn(join(ROOT, ".env.example")).filter(isGatewayOnlyEnv)).toContain("SLACK_BOT_TOKEN");
  });
});
