/**
 * box.yaml (box spec, "Box definition format"): one schema, strict keys, no
 * placeholders, no secret-shaped value, and messages that name the field and
 * never the value.
 */
import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { BOX_SCHEMA_FILE, boxSchemaText, buildBoxJsonSchema } from "../../scripts/gen-agent-schema";
import {
  BOX_SCHEMA_URL,
  boxDiff,
  canonicalPolicy,
  digestOf,
  isSecretShaped,
  parseBoxPayload,
  parseBoxYaml,
  policyHash,
  toBoxPayload,
} from "../../src/box/definition";
import { defaultBoxPolicy } from "../../src/box/policy";
import { PayloadError } from "../../src/persona/sync/errors";

const DIGEST = "sha256:" + "a".repeat(64);
const REF = `ghcr.io/example/boxes/ruby-dev@${DIGEST}`;

const FULL = `# yaml-language-server: $schema=${BOX_SCHEMA_URL}
version: 1
name: ruby-dev
description: Ruby 3.3 and Node 22 for the storefront repositories
image:
  build:
    dockerfile: Dockerfile
    context: .
tier: gvisor
resources:
  cpu: 2
  memoryMb: 3072
  memoryReserveMb: 1024
  pids: 512
  homeMb: 4096
  workspaceExtrasMb: 4096
  rootOverlayMb: 2048
egress:
  allow:
    - registry.npmjs.org
    - rubygems.org
    - github.com
    - "*.githubusercontent.com"
  deny: []
env:
  BUNDLE_JOBS: "4"
mcp:
  stdio:
    ruby-lsp:
      command: /usr/local/bin/ruby-lsp-mcp
      args: ["--stdio"]
durable:
  exclude: []
refresh:
  force: false
  note: ""
`;

const minimal = (extra = "") => `version: 1\nname: ruby-dev\nimage:\n  ref: ${REF}\n${extra}`;

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PayloadError);
    return (e as Error).message;
  }
  throw new Error("expected a PayloadError");
}

describe("parseBoxYaml", () => {
  test("the spec's example parses, with its lists in a canonical order", () => {
    const b = parseBoxYaml("ruby-dev", FULL);
    expect(b.name).toBe("ruby-dev");
    expect(b.description).toBe("Ruby 3.3 and Node 22 for the storefront repositories");
    expect(b.image).toEqual({ build: { dockerfile: "Dockerfile", context: "." } });
    expect(b.policy.tier).toBe("gvisor");
    expect(b.policy.resources.memoryReserveMb).toBe(1024);
    expect(b.policy.egress.allow).toEqual(["*.githubusercontent.com", "github.com", "registry.npmjs.org", "rubygems.org"]);
    expect(b.policy.env).toEqual({ BUNDLE_JOBS: "4" });
    expect(b.policy.mcp.stdio["ruby-lsp"]).toEqual({ command: "/usr/local/bin/ruby-lsp-mcp", args: ["--stdio"] });
    expect(b.policy.refresh).toEqual({ force: false, note: "" });
  });

  test("a minimal file gets every default, and memoryReserveMb is a third of memoryMb", () => {
    const b = parseBoxYaml("ruby-dev", minimal());
    expect(b.image).toEqual({ ref: REF });
    expect(b.description).toBe("");
    expect(b.policy).toEqual(defaultBoxPolicy());
    expect(b.policy.resources.memoryReserveMb).toBe(1024);
    const big = parseBoxYaml("ruby-dev", minimal("resources:\n  memoryMb: 9000\n"));
    expect(big.policy.resources.memoryReserveMb).toBe(3000);
  });

  test("build defaults to the box directory and its Dockerfile", () => {
    const b = parseBoxYaml("ruby-dev", "version: 1\nname: ruby-dev\nimage:\n  build: {}\n");
    expect(b.image).toEqual({ build: { dockerfile: "Dockerfile", context: "." } });
  });

  const refused: Array<[string, string, string, RegExp]> = [
    ["a name that differs from the directory", "other", minimal(), /box 'other': name must equal the directory name/],
    ["a bad directory name", "Bad_Name", minimal(), /box '<invalid-name>': the directory name must match/],
    ["no version", "ruby-dev", `name: ruby-dev\nimage:\n  ref: ${REF}\n`, /version must be 1/],
    ["a newer version", "ruby-dev", minimal().replace("version: 1", "version: 2"), /version must be 1/],
    ["no image", "ruby-dev", "version: 1\nname: ruby-dev\n", /image is required/],
    ["both build and ref", "ruby-dev", `version: 1\nname: ruby-dev\nimage:\n  build: {}\n  ref: ${REF}\n`, /image must have exactly one of build or ref/],
    ["neither build nor ref", "ruby-dev", "version: 1\nname: ruby-dev\nimage: {}\n", /image must have exactly one of build or ref/],
    ["a tag instead of a digest", "ruby-dev", "version: 1\nname: ruby-dev\nimage:\n  ref: ghcr.io/example/boxes/ruby-dev:latest\n", /image\.ref must be <registry>\/<repository>@sha256:<digest>/],
    ["a tag beside a digest", "ruby-dev", `version: 1\nname: ruby-dev\nimage:\n  ref: ghcr.io/example/boxes/ruby-dev:3.3@${DIGEST}\n`, /image\.ref must be/],
    ["a build context outside the box", "ruby-dev", "version: 1\nname: ruby-dev\nimage:\n  build:\n    context: ../other\n", /image\.build\.context must be a path relative to the box directory/],
    ["an absolute Dockerfile", "ruby-dev", "version: 1\nname: ruby-dev\nimage:\n  build:\n    dockerfile: /etc/Dockerfile\n", /image\.build\.dockerfile must be a path relative/],
    ["an unknown top-level key", "ruby-dev", minimal("secrets:\n  A: b\n"), /box 'ruby-dev': secrets is not a known key/],
    ["an unknown nested key", "ruby-dev", minimal("resources:\n  gpu: 1\n"), /resources\.gpu is not a known key/],
    ["an unknown tier", "ruby-dev", minimal("tier: microvm\n"), /tier must be one of none, bwrap, gvisor/],
    ["a reserve above the ceiling", "ruby-dev", minimal("resources:\n  memoryMb: 512\n  memoryReserveMb: 1024\n"), /resources\.memoryReserveMb must be at most memoryMb/],
    ["a fractional memory", "ruby-dev", minimal("resources:\n  memoryMb: 512.5\n"), /resources\.memoryMb must be a whole number/],
    ["memory as text", "ruby-dev", minimal('resources:\n  memoryMb: "512"\n'), /resources\.memoryMb must be a whole number/],
    ["too many cores", "ruby-dev", minimal("resources:\n  cpu: 500\n"), /resources\.cpu must be a number of cores/],
    ["an egress URL", "ruby-dev", minimal("egress:\n  allow: [\"https://github.com\"]\n"), /egress\.allow\[0\] must be a lower-case host name/],
    ["an egress address", "ruby-dev", minimal("egress:\n  allow: [10.0.0.1]\n"), /egress\.allow\[0\] must be a host name, not an address/],
    ["an egress name with no dot", "ruby-dev", minimal("egress:\n  allow: [localhost]\n"), /egress\.allow\[0\] must be a lower-case host name/],
    ["an egress wildcard in the middle", "ruby-dev", minimal("egress:\n  allow: [\"a.*.example.com\"]\n"), /egress\.allow\[0\] must be a lower-case host name/],
    ["an egress port out of range", "ruby-dev", minimal("egress:\n  allow: [\"example.com:70000\"]\n"), /egress\.allow\[0\] has a port outside 1 to 65535/],
    ["a repeated egress host", "ruby-dev", minimal("egress:\n  deny: [example.com, example.com]\n"), /egress\.deny\[1\] repeats an earlier entry/],
    ["a numeric env value", "ruby-dev", minimal("env:\n  JOBS: 4\n"), /env\.JOBS must be text \(quote numbers\)/],
    ["a reserved env name", "ruby-dev", minimal('env:\n  HTTPS_PROXY: "http://proxy.example.com"\n'), /env\.HTTPS_PROXY is a variable the runtime sets itself/],
    ["a provider env name", "ruby-dev", minimal('env:\n  ANTHROPIC_BASE_URL: "https://llm.example.com"\n'), /env\.ANTHROPIC_BASE_URL is a variable the runtime sets itself/],
    ["a gateway-only env name", "ruby-dev", minimal('env:\n  SLAUDE_MASTER_KEY: "x"\n'), /env\.SLAUDE_MASTER_KEY is a variable the runtime sets itself/],
    ["an env name that reads like a credential", "ruby-dev", minimal('env:\n  NPM_TOKEN: "x"\n'), /env\.NPM_TOKEN is named like a credential; a box holds no secret/],
    ["a bad env name", "ruby-dev", minimal('env:\n  "has space": "x"\n'), /env\.<invalid-key> is not a valid variable name/],
    ["a relative stdio command", "ruby-dev", minimal("mcp:\n  stdio:\n    lsp:\n      command: ruby-lsp\n"), /mcp\.stdio\.lsp\.command must be an absolute path/],
    ["a stdio server with env", "ruby-dev", minimal("mcp:\n  stdio:\n    lsp:\n      command: /bin/lsp\n      env: { A: b }\n"), /mcp\.stdio\.lsp\.env is not a known key/],
    ["a bad stdio server name", "ruby-dev", minimal("mcp:\n  stdio:\n    Bad Name:\n      command: /bin/lsp\n"), /mcp\.stdio\.<invalid-key> is not a valid server name/],
    ["an http MCP server", "ruby-dev", minimal("mcp:\n  http:\n    x: { url: \"https://mcp.example.com\" }\n"), /mcp\.http is not a known key/],
    ["a durable path that climbs", "ruby-dev", minimal("durable:\n  exclude: [\"../etc\"]\n"), /durable\.exclude\[0\] must be a path relative to the home/],
    ["refresh.force as text", "ruby-dev", minimal('refresh:\n  force: "yes"\n'), /refresh\.force must be true or false/],
    ["a list instead of a mapping", "ruby-dev", "- a\n- b\n", /must be a mapping of the box's fields/],
    ["a duplicate key", "ruby-dev", minimal("tier: gvisor\ntier: bwrap\n"), /box.yaml is not valid YAML \(DUPLICATE_KEY/],
    ["broken YAML", "ruby-dev", "version: [1\n", /box.yaml is not valid YAML/],
  ];
  for (const [what, dir, yaml, re] of refused) {
    test(`refuses ${what}`, () => {
      expect(failure(() => parseBoxYaml(dir, yaml))).toMatch(re);
    });
  }

  test("a file larger than the limit is refused before it is parsed", () => {
    expect(failure(() => parseBoxYaml("ruby-dev", minimal(`description: ${"x".repeat(40_000)}\n`)))).toMatch(/box.yaml is larger than/);
  });
});

describe("a box holds no secret", () => {
  const placeholders: Array<[string, string, RegExp]> = [
    ["an env value", minimal('env:\n  REGISTRY: "${PERSONA_REGISTRY}"\n'), /box 'ruby-dev': env\.REGISTRY contains \$\{, and a box has no placeholders/],
    ["a stdio argument", minimal('mcp:\n  stdio:\n    lsp:\n      command: /bin/lsp\n      args: ["--key=${KEY}"]\n'), /mcp\.stdio\.lsp\.args\[0\] contains \$\{/],
    ["the description", minimal('description: "uses ${HOME}"\n'), /description contains \$\{/],
    ["an egress host", minimal('egress:\n  allow: ["${HOST}"]\n'), /egress\.allow\[0\] contains \$\{/],
    ["a key", minimal('env:\n  "${NAME}": "x"\n'), /env\.<invalid-key> contains \$\{/],
    ["a comment", minimal("# set ${TOKEN} here\n"), /line 5 of box.yaml contains \$\{/],
  ];
  for (const [where, yaml, re] of placeholders) {
    test(`\${ in ${where} fails the file`, () => {
      expect(failure(() => parseBoxYaml("ruby-dev", yaml))).toMatch(re);
    });
  }

  // Assembled at run time so no token-shaped literal sits in the repository.
  const shaped: Array<[string, string]> = [
    ["a GitHub token", ["gh", "p_"].join("") + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"],
    ["a Slack token", ["xox", "b-"].join("") + "123456789012-abcdefghijkl"],
    ["an AWS access key id", ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl"],
    ["a bearer header", "Bearer abcdefghijklmnopqrstuvwx"],
    ["a URL with a password", "https://deploy:hunter2hunter2@registry.example.com/"],
    ["a long mixed run", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8"],
    ["a key=value pair", "password=correct-horse-battery"],
  ];
  for (const [what, value] of shaped) {
    test(`an env value shaped like ${what} fails the file and is never echoed`, () => {
      expect(isSecretShaped(value)).toBe(true);
      const msg = failure(() => parseBoxYaml("ruby-dev", minimal(`env:\n  SETTING: ${JSON.stringify(value)}\n`)));
      expect(msg).toMatch(/box 'ruby-dev': env\.SETTING looks like a credential; a box holds no secret/);
      expect(msg).not.toContain(value);
      expect(msg).not.toContain(value.slice(0, 12));
    });
    test(`a stdio argument shaped like ${what} fails the file and is never echoed`, () => {
      const msg = failure(() => parseBoxYaml("ruby-dev", minimal(`mcp:\n  stdio:\n    lsp:\n      command: /bin/lsp\n      args: [${JSON.stringify(value)}]\n`)));
      expect(msg).toMatch(/mcp\.stdio\.lsp\.args\[0\] looks like a credential/);
      expect(msg).not.toContain(value);
    });
  }

  // Free text is shown to people (the console, the forced-refresh notice) and stored in the signed set: no credential there either.
  const token = ["gh", "p_"].join("") + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const freeText: Array<[string, string, RegExp]> = [
    ["the description", minimal(`description: "use ${token}"\n`), /box 'ruby-dev': description looks like a credential/],
    ["the refresh note", minimal(`refresh:\n  force: true\n  note: "token ${token}"\n`), /refresh\.note looks like a credential/],
    ["a durable exclude path", minimal(`durable:\n  exclude: [".cache/${token}"]\n`), /durable\.exclude\[0\] looks like a credential/],
  ];
  for (const [where, yaml, re] of freeText) {
    test(`a credential-shaped value in ${where} fails the file and is never echoed`, () => {
      const msg = failure(() => parseBoxYaml("ruby-dev", yaml));
      expect(msg).toMatch(re);
      expect(msg).not.toContain(token);
    });
  }
  test("ordinary free text passes", () => {
    const yaml = minimal('description: "Ruby 3.3 and Node 22 for the storefront repositories"\nrefresh:\n  force: true\n  note: "Ruby moved to 3.4; reinstall gems."\ndurable:\n  exclude: [".cache/huggingface"]\n');
    expect(parseBoxYaml("ruby-dev", yaml).name).toBe("ruby-dev");
  });

  test("a secret-shaped unknown key is not echoed either", () => {
    const key = ["gh", "p_"].join("") + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const msg = failure(() => parseBoxYaml("ruby-dev", minimal(`${key}: 1\n`)));
    expect(msg).toMatch(/<invalid-key> is not a known key/);
    expect(msg).not.toContain(key);
  });

  test("ordinary values pass", () => {
    const b = parseBoxYaml("ruby-dev", minimal('env:\n  BUNDLE_JOBS: "4"\n  GOFLAGS: "-mod=mod"\n  NODE_OPTIONS: "--max-old-space-size=2048"\n  PIP_INDEX_URL: "https://pypi.org/simple"\n'));
    expect(Object.keys(b.policy.env)).toEqual(["BUNDLE_JOBS", "GOFLAGS", "NODE_OPTIONS", "PIP_INDEX_URL"]);
  });
});

describe("the payload entry", () => {
  test("a compiled file round-trips through the gateway's own check", () => {
    const file = parseBoxYaml("ruby-dev", FULL);
    const entry = toBoxPayload(file, REF);
    const parsed = parseBoxPayload(JSON.parse(JSON.stringify(entry)));
    expect(parsed.name).toBe("ruby-dev");
    expect(parsed.image).toBe(REF);
    expect(parsed.digest).toBe(DIGEST);
    expect(digestOf(REF)).toBe(DIGEST);
    expect(parsed.policy).toEqual(file.policy);
    expect(parsed.description).toBe(file.description);
  });

  test("an entry with only a name and an image gets the defaults", () => {
    expect(parseBoxPayload({ name: "ruby-dev", image: REF }).policy).toEqual(defaultBoxPolicy());
  });

  test("the gateway refuses what the file check refuses", () => {
    expect(failure(() => parseBoxPayload({ name: "ruby-dev", image: "ghcr.io/example/boxes/ruby-dev:latest" }))).toMatch(/box 'ruby-dev': image must be/);
    expect(failure(() => parseBoxPayload({ name: "ruby-dev", image: REF, env: { A: "${B}" } }))).toMatch(/env\.A contains \$\{/);
    expect(failure(() => parseBoxPayload({ name: "ruby-dev", image: REF, secrets: {} }))).toMatch(/secrets is not a known key/);
    expect(failure(() => parseBoxPayload({ name: "ruby-dev", image: REF, version: 1 }))).toMatch(/version is not a known key/);
    expect(failure(() => parseBoxPayload({ name: "Bad", image: REF }))).toMatch(/box '<invalid-name>': name must match/);
    expect(failure(() => parseBoxPayload(null))).toMatch(/box '<invalid-name>': must be a mapping/);
    expect(failure(() => parseBoxPayload({ name: "ruby-dev", image: REF, resources: { memoryMb: 512, memoryReserveMb: 600 } }))).toMatch(/memoryReserveMb must be at most memoryMb/);
  });
});

describe("canonical policy and diff", () => {
  const a = parseBoxPayload({ name: "b", image: REF, egress: { allow: ["github.com", "pypi.org"] }, env: { A: "1", B: "2" } });
  test("key and list order do not change the canonical text or the hash", () => {
    const b = parseBoxPayload({ name: "b", image: REF, env: { B: "2", A: "1" }, egress: { allow: ["pypi.org", "github.com"] } });
    expect(canonicalPolicy(a.policy)).toBe(canonicalPolicy(b.policy));
    expect(policyHash(a.policy)).toBe(policyHash(b.policy));
    expect(policyHash(a.policy)).not.toBe(policyHash(defaultBoxPolicy()));
  });

  test("a new box, an unchanged box, and each kind of change", () => {
    expect(boxDiff(null, a)).toEqual(["new box"]);
    expect(boxDiff(a, a)).toEqual([]);
    const next = parseBoxPayload({
      name: "b",
      image: `ghcr.io/example/boxes/ruby-dev@sha256:${"b".repeat(64)}`,
      tier: "bwrap",
      resources: { memoryMb: 4096 },
      egress: { allow: ["github.com", "rubygems.org"], deny: ["uploads.github.com"] },
      env: { A: "changed-value", C: "3" },
      mcp: { stdio: { lsp: { command: "/bin/lsp" } } },
      durable: { exclude: [".cache/big"] },
      refresh: { force: true, note: "moved" },
    });
    const lines = boxDiff(a, next);
    expect(lines).toEqual([
      "image: new digest",
      "tier: gvisor -> bwrap",
      "resources.memoryMb: 3072 -> 4096",
      "resources.memoryReserveMb: 1024 -> 1365",
      "egress.allow: +rubygems.org",
      "egress.allow: -pypi.org",
      "egress.deny: +uploads.github.com",
      "env: +C",
      "env: -B",
      "env: ~A",
      "mcp.stdio: +lsp",
      "durable.exclude: +.cache/big",
      "refresh.force: on",
      "refresh.note: changed",
    ]);
    // Values are never printed.
    expect(lines.join("\n")).not.toContain("changed-value");
    expect(lines.join("\n")).not.toContain("moved");
    const changedServer = parseBoxPayload({ name: "b", image: next.image, mcp: { stdio: { lsp: { command: "/bin/lsp", args: ["--stdio"] } } } });
    const from = parseBoxPayload({ name: "b", image: next.image, mcp: { stdio: { lsp: { command: "/bin/lsp" } } }, refresh: { force: true } });
    expect(boxDiff(from, changedServer)).toEqual(["mcp.stdio: ~lsp", "refresh.force: off"]);
  });
});

describe("docs/site/schemas/box.schema.json", () => {
  test("the committed file is what the Zod schema generates (run `bun run schema:agent`)", () => {
    expect(readFileSync(BOX_SCHEMA_FILE, "utf8")).toBe(boxSchemaText());
  });

  test("it is published under the docs site's schemas path", () => {
    expect(buildBoxJsonSchema().$id).toBe(BOX_SCHEMA_URL);
  });

  test("every field carries help text", () => {
    const missing: string[] = [];
    const walk = (node: unknown, path: string) => {
      const props = (node as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties;
      for (const [k, v] of Object.entries(props ?? {})) {
        if (typeof v.description !== "string" || !v.description) missing.push(`${path}${k}`);
        walk(v, `${path}${k}.`);
      }
    };
    walk(buildBoxJsonSchema(), "");
    expect(missing).toEqual([]);
  });

  test("the schema has no secrets key and accepts the spec's example", () => {
    const schema = buildBoxJsonSchema();
    expect(Object.keys(schema.properties as object)).not.toContain("secrets");
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate(parse(FULL))).toBe(true);
    expect(validate(parse(minimal("secrets:\n  A: b\n")))).toBe(false);
    expect(validate(parse(minimal("tier: microvm\n")))).toBe(false);
  });
});
