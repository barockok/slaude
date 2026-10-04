/**
 * The node-local stdio MCP manifest (node labels spec §4.10): schema, allow
 * semantics, env expansion, and the per-session resolver keyed on the job
 * token's claims.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_NODE_MANIFEST,
  MCP_EXEC_BUN_FLAGS,
  MCP_EXEC_ENTRY,
  NODE_MANIFEST_DEFAULT_PATH,
  NodeManifestError,
  allowedServers,
  describeNodeManifest,
  loadNodeManifest,
  makeNodeLocalMcpResolver,
  parseNodeManifest,
  stdioServersFor,
} from "../../src/node/manifest";
import { NodeApiError } from "../../src/node/client";
import { BootFailure } from "../../src/gateway/core/failure-codes";

const NODE_ENV = { PATH: "/usr/bin:/bin", HOME: "/home/node", LANG: "C.UTF-8", TMPDIR: "/tmp", NODE_TF_TOKEN: "tf-fake-value", OTHER: "x" };

const valid = {
  version: 1,
  mcpServers: {
    tf: { command: "terraform-mcp", args: ["--stdio"], env: { TF_TOKEN: "${NODE_TF_TOKEN}" } },
    gh: { command: "gh-mcp", type: "stdio" },
  },
  allow: { "platform-bot": ["tf", "gh"], "support-bot": ["gh"], "ops-bot": "*" },
};

const parse = (m: unknown, env: Record<string, string | undefined> = NODE_ENV) =>
  parseNodeManifest(JSON.stringify(m), env, "node.json");

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(NodeManifestError);
    return (e as Error).message;
  }
  throw new Error("expected the manifest to be refused");
}

/** A fake job token: only the payload matters to the node (it never verifies). */
function jobToken(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

describe("parseNodeManifest — schema", () => {
  it("accepts a valid manifest and expands env from the node's environment", () => {
    const m = parse(valid);
    expect(Object.keys(m.servers).sort()).toEqual(["gh", "tf"]);
    expect(m.servers.tf).toEqual({ command: "terraform-mcp", args: ["--stdio"], env: { TF_TOKEN: "tf-fake-value" } });
    expect(m.servers.gh).toEqual({ command: "gh-mcp", args: [], env: {} });
  });

  it("expands ${VAR} inside a longer value and leaves literals alone", () => {
    const m = parse({
      version: 1,
      mcpServers: { tf: { command: "t", env: { AUTH: "Bearer ${NODE_TF_TOKEN}", MODE: "plain" } } },
      allow: {},
    });
    expect(m.servers.tf!.env).toEqual({ AUTH: "Bearer tf-fake-value", MODE: "plain" });
  });

  it("defaults mcpServers and allow to empty", () => {
    expect(parse({ version: 1 })).toEqual(EMPTY_NODE_MANIFEST);
  });

  it("refuses an unknown top-level key", () => {
    expect(refusal(() => parse({ ...valid, extra: true }))).toContain("extra");
  });

  it("refuses an unknown key on a server (a url is not stdio)", () => {
    const msg = refusal(() => parse({ version: 1, mcpServers: { web: { command: "x", url: "https://example.com" } }, allow: {} }));
    expect(msg).toContain("mcpServers.web");
    expect(msg).toContain("url");
  });

  it("refuses a non-stdio type", () => {
    const msg = refusal(() => parse({ version: 1, mcpServers: { web: { command: "x", type: "http" } }, allow: {} }));
    expect(msg).toContain("mcpServers.web.type");
    expect(msg).toContain("stdio");
  });

  it("refuses a server with no command", () => {
    expect(refusal(() => parse({ version: 1, mcpServers: { gh: { args: [] } }, allow: {} }))).toContain("mcpServers.gh.command");
  });

  it("refuses the wrong version", () => {
    expect(refusal(() => parse({ ...valid, version: 2 }))).toContain("version");
  });

  it("refuses bad server names", () => {
    for (const bad of ["", "Upper", "-lead", "has space", "a".repeat(65), "dot.name"]) {
      const msg = refusal(() => parse({ version: 1, mcpServers: { [bad]: { command: "x" } }, allow: {} }));
      expect(msg).toContain("mcpServers");
    }
  });

  it("refuses an allow entry naming an unknown server", () => {
    const msg = refusal(() => parse({ ...valid, allow: { "support-bot": ["gh", "nope"] } }));
    expect(msg).toContain("allow.support-bot");
    expect(msg).toContain("nope");
  });

  it("refuses a duplicate server name in an allow list", () => {
    expect(refusal(() => parse({ ...valid, allow: { "support-bot": ["gh", "gh"] } }))).toContain("duplicate");
  });

  it("refuses an empty persona name in allow", () => {
    expect(refusal(() => parse({ ...valid, allow: { "": ["gh"] } }))).toContain("allow");
  });

  it("refuses a duplicate key in the JSON text (JSON.parse would keep the last)", () => {
    const text = `{"version":1,"mcpServers":{"gh":{"command":"a"},"gh":{"command":"b"}},"allow":{}}`;
    expect(refusal(() => parseNodeManifest(text, NODE_ENV, "node.json"))).toContain("duplicate key 'gh'");
    const nested = `{"version":1,"mcpServers":{"gh":{"command":"a","command":"b"}},"allow":{}}`;
    expect(refusal(() => parseNodeManifest(nested, NODE_ENV, "node.json"))).toContain("duplicate key 'command'");
    const allow = `{"version":1,"mcpServers":{"gh":{"command":"a"}},"allow":{"p":["gh"],"p":"*"}}`;
    expect(refusal(() => parseNodeManifest(allow, NODE_ENV, "node.json"))).toContain("duplicate key 'p'");
  });

  it("does not mistake equal keys in different objects, or keys inside strings, for duplicates", () => {
    const text = `{"version":1,"mcpServers":{"gh":{"command":"a \\"command\\": {","args":["x","y"]},"tf":{"command":"b","args":[{"a":1}] }},"allow":{}}`;
    // the args array of objects is a schema error, not a duplicate-key error
    expect(refusal(() => parseNodeManifest(text, NODE_ENV, "node.json"))).not.toContain("duplicate");
    const ok = `{"version":1,"mcpServers":{"gh":{"command":"a"},"tf":{"command":"a"}},"allow":{"x":["gh"],"y":["gh"]}}`;
    expect(Object.keys(parseNodeManifest(ok, NODE_ENV, "node.json").servers)).toEqual(["gh", "tf"]);
  });

  it("refuses an empty file and invalid JSON", () => {
    expect(refusal(() => parseNodeManifest("", NODE_ENV, "node.json"))).toContain("empty");
    expect(refusal(() => parseNodeManifest("  \n", NODE_ENV, "node.json"))).toContain("empty");
    expect(refusal(() => parseNodeManifest("{nope", NODE_ENV, "node.json"))).toContain("not valid JSON");
  });

  it("refuses a gateway-only variable referenced in env, naming it and not printing values", () => {
    const env = { ...NODE_ENV, SLAUDE_MASTER_KEY: "master-fake-secret" };
    const msg = refusal(() =>
      parse({ version: 1, mcpServers: { tf: { command: "t", env: { K: "${SLAUDE_MASTER_KEY}" } } }, allow: {} }, env),
    );
    expect(msg).toContain("SLAUDE_MASTER_KEY");
    expect(msg).toContain("mcpServers.tf.env.K");
    expect(msg).not.toContain("master-fake-secret");
  });

  it("refuses node-held secrets the agent child is scrubbed of (node token, Redis URL)", () => {
    for (const name of ["SLAUDE_NODE_TOKEN", "SLAUDE_REDIS_URL", "PERSONA_X_KEY"]) {
      const msg = refusal(() =>
        parse({ version: 1, mcpServers: { tf: { command: "t", env: { K: `\${${name}}` } } }, allow: {} }, { ...NODE_ENV, [name]: "v" }),
      );
      expect(msg).toContain(name);
    }
  });

  it("refuses a gateway-only name as an env key", () => {
    const msg = refusal(() => parse({ version: 1, mcpServers: { tf: { command: "t", env: { SLACK_BOT_TOKEN: "lit" } } }, allow: {} }));
    expect(msg).toContain("SLACK_BOT_TOKEN");
  });

  it("refuses an env reference the node does not have, naming it", () => {
    const msg = refusal(() =>
      parse({ version: 1, mcpServers: { tf: { command: "t", env: { K: "${MISSING_VAR}" } } }, allow: {} }),
    );
    expect(msg).toContain("MISSING_VAR");
  });

  it("refuses a malformed env key", () => {
    expect(refusal(() => parse({ version: 1, mcpServers: { tf: { command: "t", env: { "BAD-KEY": "v" } } }, allow: {} }))).toContain(
      "mcpServers.tf.env",
    );
  });

  it("never prints an env value on a type error", () => {
    const msg = refusal(() => parse({ version: 1, mcpServers: { tf: { command: "t", env: { K: 12345678 } } }, allow: {} }));
    expect(msg).toContain("mcpServers.tf.env.K");
    expect(msg).not.toContain("12345678");
  });
});

/**
 * The CLI expands `${NAME}` and `${NAME:-default}` in a stdio config's command,
 * args and env values AGAIN, against the agent child's environment (provider
 * credentials included). slaude expands plain `${NAME}` in env values once, so
 * no `${` may survive into the config it hands the CLI.
 */
describe("parseNodeManifest — nothing for the CLI to expand", () => {
  const ENV = { ...NODE_ENV, ANTHROPIC_API_KEY: "provider-fake", SLAUDE_JOB_SECRET: "job-fake" };
  const one = (server: Record<string, unknown>, env: Record<string, string | undefined> = ENV) =>
    parse({ version: 1, mcpServers: { tf: { command: "t", ...server } }, allow: { p: ["tf"] } }, env);

  it("refuses a default or modifier form in an env value, naming the field and not the value", () => {
    for (const v of [
      "${ANTHROPIC_API_KEY:-}",
      "${SLAUDE_JOB_SECRET:-}",
      "${NODE_TF_TOKEN:-fallback}",
      "x ${MISSING:-y}",
      "${NODE_TF_TOKEN:=y}",
      "${NODE_TF_TOKEN-y}",
      "${#NODE_TF_TOKEN}",
      "${}",
      "${",
      "${NODE_TF_TOKEN} and ${ANTHROPIC_API_KEY:-}",
    ]) {
      const msg = refusal(() => one({ env: { K: v } }));
      expect(msg).toContain("mcpServers.tf.env.K");
      expect(msg).not.toContain("provider-fake");
      expect(msg).not.toContain("job-fake");
    }
  });

  it("refuses any ${ in command or args (plain references included)", () => {
    expect(refusal(() => one({ command: "${HOME}/bin/srv" }))).toContain("mcpServers.tf.command");
    for (const a of ["${ANTHROPIC_API_KEY}", "${ANTHROPIC_API_KEY:-}", "--root=${CLAUDE_PLUGIN_ROOT}", "${"]) {
      expect(refusal(() => one({ args: ["--stdio", a] }))).toContain("mcpServers.tf.args.1");
    }
  });

  it("refuses an expanded value that itself contains ${ (it would be expanded again), without printing it", () => {
    const env = { ...ENV, NODE_TF_TOKEN: "pre-${ANTHROPIC_API_KEY}-post" };
    const msg = refusal(() => one({ env: { K: "${NODE_TF_TOKEN}" } }, env));
    expect(msg).toContain("mcpServers.tf.env.K");
    expect(msg).not.toContain("pre-");
  });

  it("refuses a base variable (PATH, HOME, LANG, TMPDIR) whose node value contains ${", () => {
    const msg = refusal(() => one({}, { ...ENV, HOME: "/home/${ANTHROPIC_API_KEY}" }));
    expect(msg).toContain("HOME");
  });

  it("still refuses a scrubbed name inside a plain reference", () => {
    expect(refusal(() => one({ env: { K: "${SLAUDE_JOB_SECRET}" } }))).toContain("SLAUDE_JOB_SECRET");
  });

  it("no ${ reaches any field of the final config", () => {
    const m = one({ args: ["--stdio", "$HOME", "plain"], env: { A: "${NODE_TF_TOKEN}", B: "lit$", C: "{x}" } });
    const cfg = stdioServersFor(m, "p", ENV, "/opt/bun") as any;
    const strings = [cfg.tf.command, ...cfg.tf.args, ...Object.keys(cfg.tf.env), ...Object.values(cfg.tf.env)];
    for (const s of strings) expect(String(s)).not.toContain("${");
  });

  it("the final config refuses a ${ that arrives from outside the manifest (exec path, base env)", () => {
    const m = one({});
    expect(() => stdioServersFor(m, "p", ENV, "/opt/${X}/bun")).toThrow(NodeManifestError);
    expect(() => stdioServersFor(m, "p", { ...ENV, TMPDIR: "/tmp/${ANTHROPIC_API_KEY:-}" }, "/opt/bun")).toThrow("TMPDIR");
  });
});

describe("loadNodeManifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "slaude-manifest-"));

  it("a missing file is the empty manifest (nothing for anyone)", () => {
    expect(loadNodeManifest(join(dir, "absent.json"), NODE_ENV)).toEqual(EMPTY_NODE_MANIFEST);
  });

  it("reads and validates a file, naming it in a refusal", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(valid));
    expect(Object.keys(loadNodeManifest(good, NODE_ENV).servers).sort()).toEqual(["gh", "tf"]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, mcpServers: { x: { command: "c", type: "sse" } } }));
    expect(refusal(() => loadNodeManifest(bad, NODE_ENV))).toContain(bad);
  });

  it("defaults to SLAUDE_NODE_MANIFEST", () => {
    const p = join(dir, "from-env.json");
    writeFileSync(p, JSON.stringify(valid));
    const prev = process.env.SLAUDE_NODE_MANIFEST;
    process.env.SLAUDE_NODE_MANIFEST = p;
    try {
      expect(Object.keys(loadNodeManifest(undefined, NODE_ENV).servers).sort()).toEqual(["gh", "tf"]);
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_NODE_MANIFEST;
      else process.env.SLAUDE_NODE_MANIFEST = prev;
    }
  });

  it("describes a manifest by names and counts only", () => {
    const line = describeNodeManifest(parse(valid), "/etc/slaude/node.json");
    expect(line).toContain("2 stdio MCP server(s) [tf, gh]");
    expect(line).toContain("3 persona(s)");
    expect(line).not.toContain("tf-fake-value");
    expect(describeNodeManifest(EMPTY_NODE_MANIFEST, "/x")).toContain("no plugin MCP server is mounted");
    const prev = process.env.SLAUDE_NODE_MANIFEST;
    process.env.SLAUDE_NODE_MANIFEST = "";
    try {
      expect(describeNodeManifest(EMPTY_NODE_MANIFEST)).toContain(NODE_MANIFEST_DEFAULT_PATH);
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_NODE_MANIFEST;
      else process.env.SLAUDE_NODE_MANIFEST = prev;
    }
  });

  it("refuses a path it cannot read as a file", () => {
    expect(refusal(() => loadNodeManifest(dir, NODE_ENV))).toContain("cannot be read");
  });
});

describe("allow semantics", () => {
  const m = parse(valid);

  it("a persona not listed gets nothing", () => {
    expect(allowedServers(m, "finance-bot")).toEqual([]);
    expect(allowedServers(m, "default")).toEqual([]);
    expect(stdioServersFor(m, "finance-bot", NODE_ENV)).toEqual({});
  });

  it("a listed persona gets exactly its servers; '*' gets every server", () => {
    expect(allowedServers(m, "support-bot")).toEqual(["gh"]);
    expect(allowedServers(m, "platform-bot")).toEqual(["tf", "gh"]);
    expect(allowedServers(m, "ops-bot").sort()).toEqual(["gh", "tf"]);
    expect(Object.keys(stdioServersFor(m, "support-bot", NODE_ENV))).toEqual(["gh"]);
  });

  it("does not resolve inherited object keys as personas", () => {
    expect(allowedServers(m, "constructor")).toEqual([]);
    expect(allowedServers(m, "__proto__")).toEqual([]);
  });

  it("a mounted server runs under the exec wrapper with an explicit minimal env", () => {
    const cfg = stdioServersFor(m, "platform-bot", { ...NODE_ENV, ANTHROPIC_API_KEY: "provider-fake" }, "/opt/bun");
    expect(cfg.tf).toEqual({
      type: "stdio",
      command: "/opt/bun",
      args: [...MCP_EXEC_BUN_FLAGS, MCP_EXEC_ENTRY, "PATH,HOME,LANG,TMPDIR,TF_TOKEN", "--", "terraform-mcp", "--stdio"],
      env: { PATH: "/usr/bin:/bin", HOME: "/home/node", LANG: "C.UTF-8", TMPDIR: "/tmp", TF_TOKEN: "tf-fake-value" },
    });
    expect(JSON.stringify(cfg)).not.toContain("provider-fake");
  });

  it("omits a base variable the node does not have; a server's own env overrides a base one", () => {
    const local = parse({ version: 1, mcpServers: { gh: { command: "g", env: { HOME: "/srv/gh" } } }, allow: { p: "*" } });
    const cfg = stdioServersFor(local, "p", { PATH: "/bin" }, "/opt/bun") as any;
    expect(cfg.gh.env).toEqual({ PATH: "/bin", HOME: "/srv/gh" });
    expect(cfg.gh.args[MCP_EXEC_BUN_FLAGS.length + 1]).toBe("PATH,HOME");
  });
});

describe("makeNodeLocalMcpResolver — keyed on the job token's claims", () => {
  const m = parse(valid);

  function setup(o: { claims?: Record<string, unknown> | null; payloadPersona?: string; runtime?: (t: string, p: string, tok: string) => Promise<unknown> } = {}) {
    const calls: Array<[string, string, string]> = [];
    const token = o.claims === null ? undefined : jobToken(o.claims ?? { persona: "support-bot", tenant: "t1" });
    const resolver = makeNodeLocalMcpResolver({
      manifest: m,
      client: {
        getRuntime: async (t: string, p: string, tok: string) => {
          calls.push([t, p, tok]);
          return (await o.runtime?.(t, p, tok)) ?? ({} as any);
        },
      },
      tenantFor: () => "t1",
      tokenFor: () => token,
      nodeEnv: NODE_ENV,
      execPath: "/opt/bun",
    });
    return { resolver, calls, token };
  }

  it("mounts exactly the claimed persona's servers after the gateway accepts the token for that persona", async () => {
    const { resolver, calls, token } = setup();
    expect(Object.keys(await resolver("s1"))).toEqual(["gh"]);
    expect(calls).toEqual([["t1", "support-bot", token!]]);
  });

  it("an unlisted persona gets nothing, without a gateway call", async () => {
    const { resolver, calls } = setup({ claims: { persona: "finance-bot", tenant: "t1" } });
    expect(await resolver("s1")).toEqual({});
    expect(calls).toEqual([]);
  });

  it("no token, no claims or no persona claim → nothing", async () => {
    expect(await setup({ claims: null }).resolver("s1")).toEqual({});
    expect(await setup({ claims: { tenant: "t1" } }).resolver("s1")).toEqual({});
    const r = makeNodeLocalMcpResolver({
      manifest: m,
      client: { getRuntime: async () => ({}) as any },
      tenantFor: () => "t1",
      tokenFor: () => "not-a-jwt",
      nodeEnv: NODE_ENV,
    });
    expect(await r("s1")).toEqual({});
    const noTenant = makeNodeLocalMcpResolver({
      manifest: m,
      client: { getRuntime: async () => ({}) as any },
      tenantFor: () => undefined,
      tokenFor: () => jobToken({ persona: "ops-bot" }),
      nodeEnv: NODE_ENV,
    });
    expect(await noTenant("s1")).toEqual({});
  });

  it("a token the gateway refuses for that persona fails the boot (never mounts), definitively", async () => {
    const { resolver } = setup({
      claims: { persona: "ops-bot", tenant: "t1" },
      runtime: async () => {
        throw new NodeApiError(403, '{"error":"job token is not scoped to this persona"}');
      },
    });
    const e = await resolver("s1").then(
      () => null,
      (x) => x,
    );
    expect(e).toBeInstanceOf(BootFailure);
    expect(e.code).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
    expect(e.transient).toBe(false);
  });

  it("a bundle fetch failure is classified like the child-env resolver's: 503 by its body, network and 5xx transient", async () => {
    const fail = async (err: unknown) => {
      const { resolver } = setup({
        claims: { persona: "ops-bot", tenant: "t1" },
        runtime: async () => {
          throw err;
        },
      });
      return resolver("s1").then(
        () => null,
        (x) => x as BootFailure,
      );
    };
    expect((await fail(new NodeApiError(503, JSON.stringify({ transient: true }))))!.transient).toBe(true);
    expect((await fail(new NodeApiError(503, JSON.stringify({ transient: false }))))!.transient).toBe(false);
    expect((await fail(new NodeApiError(502, "bad gateway")))!.transient).toBe(true);
    expect((await fail(new TypeError("fetch failed")))!.transient).toBe(true);
    expect((await fail(new NodeApiError(401, "unauthorized")))!.transient).toBe(false);
  });

  it("the unsigned payload persona cannot widen: only the claims decide", async () => {
    // The Redis payload says ops-bot ("*"); the token's claims say support-bot.
    const payloadPersona = "ops-bot";
    const { resolver } = setup({ claims: { persona: "support-bot", tenant: "t1" }, payloadPersona });
    expect(Object.keys(await resolver("s1"))).toEqual(["gh"]);
  });
});
