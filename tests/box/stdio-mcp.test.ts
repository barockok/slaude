/**
 * Stdio MCP servers in boxes (box plan, Phase 8): the checks shared with the
 * node manifest, the stricter box form, the node's second check of what it
 * receives, and the worker's resolver choosing the box's list for a boxed
 * session and the manifest's for an unboxed one.
 */
import { describe, expect, test } from "bun:test";
import { CLI_REF, STDIO_ENV_KEY_RE, STDIO_SERVER_NAME_RE, hasNonPlainRef, stdioEnvRefs, validateStdioServer } from "../../src/config/stdio-server";
import { BOX_MCP_NAME_RE, parseBoxPayload } from "../../src/box/definition";
import { defaultBoxPolicy, type BoxPolicy } from "../../src/box/policy";
import type { BundleBoxFacts } from "../../src/box/session-box";
import { BootFailure } from "../../src/gateway/core/failure-codes";
import { PayloadError } from "../../src/persona/sync/errors";
import { NodeApiError } from "../../src/node/client";
import { MCP_EXEC_ENTRY, boxStdioServers, makeNodeLocalMcpResolver, parseNodeManifest } from "../../src/node/manifest";
import { makeNodeSessionBoxes } from "../../src/node/session-boxes";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const IMAGE = `ghcr.io/example/boxes/ruby-dev@${digest("a")}`;
const codes = (name: string, cfg: unknown, form: "node" | "box" = "node") => validateStdioServer(name, cfg, form).map((i) => `${i.code}:${i.field}`);

describe("validateStdioServer: the checks one declaration goes through", () => {
  test("a plain server passes in both forms", () => {
    expect(codes("gh", { command: "gh-mcp" })).toEqual([]);
    expect(codes("gh", { command: "gh-mcp", args: ["--stdio"], env: { GH_HOST: "${NODE_GH_HOST}" }, type: "stdio" })).toEqual([]);
    expect(codes("ruby-lsp", { command: "/usr/local/bin/ruby-lsp-mcp", args: ["--stdio"] }, "box")).toEqual([]);
  });

  test("the name pattern is one pattern, shared", () => {
    expect(BOX_MCP_NAME_RE).toBe(STDIO_SERVER_NAME_RE);
    for (const bad of ["", "Gh", "-gh", "a b", "x".repeat(65), "gh/../x"]) {
      expect(codes(bad, { command: "x" })).toContain("name:name");
      expect(codes(bad, { command: "/x" }, "box")).toContain("name:name");
    }
    expect(codes("a".repeat(64), { command: "x" })).toEqual([]);
  });

  test("shape problems name the field, and a config that is not a mapping is one problem", () => {
    expect(codes("gh", null)).toEqual(["command:command"]);
    expect(codes("gh", ["gh-mcp"])).toEqual(["command:command"]);
    expect(codes("gh", { command: "" })).toEqual(["command:command"]);
    expect(codes("gh", { command: "x", args: "--stdio" })).toEqual(["args:args"]);
    expect(codes("gh", { command: "x", args: ["a", 1] })).toEqual(["args:args"]);
    expect(codes("gh", { command: "x", env: ["A=b"] })).toEqual(["env:env"]);
    expect(codes("gh", { command: "x", env: { A: 1 } })).toEqual(["env:env.A"]);
    expect(codes("gh", { command: "x", env: { "A-B": "v" } })).toEqual(["env-key:env.(key)"]);
    expect(STDIO_ENV_KEY_RE.test("A_B1")).toBe(true);
  });

  test("node form: ${ is refused in the command and the args, and an env value may hold plain references only", () => {
    expect(codes("gh", { command: "${HOME}/bin/gh-mcp" })).toEqual(["cli-ref:command"]);
    expect(codes("gh", { command: "gh-mcp", args: ["ok", "--token=${TOKEN}", "${X:-y}"] })).toEqual(["cli-ref:args.1", "cli-ref:args.2"]);
    expect(codes("gh", { command: "gh-mcp", env: { A: "${NODE_A}", B: "pre-${NODE_B}-post" } })).toEqual([]);
    expect(codes("gh", { command: "gh-mcp", env: { A: "${NODE_A:-fallback}" } })).toEqual(["env-ref-form:env.A"]);
    expect(codes("gh", { command: "gh-mcp", env: { A: "${NODE_A" } })).toEqual(["env-ref-form:env.A"]);
    expect(codes("gh", { command: "gh-mcp", env: { A: "${1BAD}" } })).toEqual(["env-ref-form:env.A"]);
    expect(hasNonPlainRef("${A}${B}")).toBe(false);
    expect(hasNonPlainRef("${A}${")).toBe(true);
    expect(stdioEnvRefs("x${A}y${B_2}")).toEqual(["A", "B_2"]);
    expect(CLI_REF).toBe("${");
  });

  test("box form is stricter: no ${ anywhere, not even a plain reference, and no env on a server", () => {
    expect(codes("lsp", { command: "/usr/bin/${NAME}" }, "box")).toEqual(["box-ref:command"]);
    expect(codes("lsp", { command: "/usr/bin/lsp", args: ["${HOME}"] }, "box")).toEqual(["box-ref:args.0"]);
    expect(codes("lsp", { command: "/usr/bin/lsp", env: { A: "b" } }, "box")).toEqual(["box-env:env"]);
    expect(codes("lsp", { command: "/usr/bin/lsp", type: "stdio" }, "box")).toEqual(["unknown-key:(key)"]);
  });

  test("an issue never carries a value", () => {
    const secretish = ["gh", "p_"].join("") + "a".repeat(36);
    const all = [
      ...validateStdioServer("gh", { command: `x-${secretish}-\${Y}`, args: [`\${${secretish}}`], env: { A: `${secretish}\${B:-c}` } }),
      ...validateStdioServer("gh", { command: "/x", [secretish]: 1 }, "box"),
    ];
    expect(all.length).toBeGreaterThan(2);
    expect(JSON.stringify(all)).not.toContain(secretish);
  });
});

describe("a box's mcp.stdio at sync (the gateway's check)", () => {
  const entry = (stdio: unknown) => ({ name: "ruby-dev", image: IMAGE, mcp: { stdio } });
  const refusal = (stdio: unknown): string => {
    try {
      parseBoxPayload(entry(stdio));
    } catch (e) {
      expect(e).toBeInstanceOf(PayloadError);
      return (e as Error).message;
    }
    throw new Error("expected the box to be refused");
  };

  test("a credential-free server is accepted as written", () => {
    const p = parseBoxPayload(entry({ "ruby-lsp": { command: "/usr/local/bin/ruby-lsp-mcp", args: ["--stdio"] } }));
    expect(p.policy.mcp.stdio).toEqual({ "ruby-lsp": { command: "/usr/local/bin/ruby-lsp-mcp", args: ["--stdio"] } });
  });

  test("${ anywhere in a server is refused and the field is named, never the value", () => {
    expect(refusal({ lsp: { command: "/usr/bin/lsp", args: ["--root=${HOME}"] } })).toMatch(/^box 'ruby-dev': mcp\.stdio\.lsp\.args\[0\] contains \$\{/);
    expect(refusal({ lsp: { command: "/usr/bin/${X}" } })).toMatch(/^box 'ruby-dev': mcp\.stdio\.lsp\.command contains \$\{/);
  });

  test("a bad name, an env key on a server and a relative command are refused", () => {
    expect(refusal({ "Bad Name": { command: "/usr/bin/lsp" } })).toContain("is not a valid server name");
    expect(refusal({ lsp: { command: "/usr/bin/lsp", env: { A: "b" } } })).toContain("env is not a known key");
    expect(refusal({ lsp: { command: "lsp" } })).toContain("must be an absolute path to a program in the image");
  });
});

describe("boxStdioServers: the node checks again what it received", () => {
  test("the box's servers become plain stdio configs: no exec wrapper, no env", () => {
    const out = boxStdioServers({ "ruby-lsp": { command: "/usr/local/bin/ruby-lsp-mcp", args: ["--stdio"] }, rg: { command: "/usr/bin/rg-mcp", args: [] } });
    expect(out).toEqual({
      "ruby-lsp": { type: "stdio", command: "/usr/local/bin/ruby-lsp-mcp", args: ["--stdio"] },
      rg: { type: "stdio", command: "/usr/bin/rg-mcp", args: [] },
    });
    expect(JSON.stringify(out)).not.toContain(MCP_EXEC_ENTRY);
    expect(boxStdioServers({})).toEqual({});
  });

  test.each([
    ["a ${ in an argument", { lsp: { command: "/usr/bin/lsp", args: ["${ANTHROPIC_API_KEY}"] } }],
    ["a ${ in the command", { lsp: { command: "/usr/bin/${X}", args: [] } }],
    ["a name that is not one", { "../x": { command: "/usr/bin/lsp", args: [] } }],
    ["a relative command", { lsp: { command: "lsp", args: [] } }],
    ["an env key on the server", { lsp: { command: "/usr/bin/lsp", args: [], env: { A: "b" } } as never }],
  ])("%s fails the boot; the server is never dropped and the session run on", (_what, stdio) => {
    let thrown: unknown;
    try {
      boxStdioServers(stdio as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BootFailure);
    expect((thrown as BootFailure).code).toBe("BOX_UNAVAILABLE");
    expect((thrown as Error).message).not.toContain("ANTHROPIC_API_KEY");
    expect((thrown as Error).message).not.toContain("../x");
  });
});

describe("the worker's local MCP resolver: box or manifest, never both", () => {
  const NODE_ENV = { PATH: "/usr/bin:/bin", HOME: "/home/node", LANG: "C.UTF-8", TMPDIR: "/tmp", NODE_TF_TOKEN: "tf-fake-value" };
  const manifest = parseNodeManifest(
    JSON.stringify({
      version: 1,
      mcpServers: { tf: { command: "terraform-mcp", env: { TF_TOKEN: "${NODE_TF_TOKEN}" } }, gh: { command: "gh-mcp" } },
      allow: { "platform-bot": ["tf", "gh"], "support-bot": ["gh"] },
    }),
    NODE_ENV,
    "node.json",
  );
  const token = (persona: string) => `h.${Buffer.from(JSON.stringify({ persona, tenant: "t1" })).toString("base64url")}.s`;
  const policy = (stdio: BoxPolicy["mcp"]["stdio"]): BoxPolicy => ({ ...defaultBoxPolicy(), mcp: { stdio } });
  const bundleBox = (stdio: BoxPolicy["mcp"]["stdio"]): BundleBoxFacts => ({ name: "ruby-dev", image: IMAGE, digest: digest("a"), policy: policy(stdio) });

  function setup(o: {
    persona?: string;
    box?: BundleBoxFacts | null;
    pinned?: boolean;
    manifest?: typeof manifest | null;
    tier?: "none" | "gvisor";
    runtime?: () => Promise<unknown>;
  }) {
    const persona = o.persona ?? "platform-bot";
    const calls: string[] = [];
    const warnings: string[] = [];
    const client = {
      getRuntime: async (_t: string, p: string) => {
        calls.push(p);
        if (o.runtime) return (await o.runtime()) as never;
        return (o.box ? { box: o.box } : {}) as never;
      },
    };
    const deps = { client, tenantFor: () => "t1", tokenFor: () => token(persona) };
    const boxes = (o.tier ?? "gvisor") === "none" ? null : makeNodeSessionBoxes({ ...deps, sessionFor: async () => (o.pinned === false ? {} : o.box ? { box_name: "ruby-dev", box_digest: digest("a") } : {}) });
    const resolver = makeNodeLocalMcpResolver({
      manifest: o.manifest === undefined ? manifest : o.manifest,
      ...deps,
      ...(boxes ? { boxOf: (id: string) => boxes.boxOf(id) } : {}),
      nodeEnv: NODE_ENV,
      execPath: "/opt/bun",
      warn: (l) => void warnings.push(l),
    });
    return { resolver, calls, warnings };
  }

  test("an unboxed session on a sandbox node gets the manifest's servers, through the exec wrapper, exactly as before", async () => {
    const { resolver } = setup({ box: null });
    const out = await resolver("s1");
    expect(Object.keys(out).sort()).toEqual(["gh", "tf"]);
    expect((out.tf as { command: string; args: string[] }).command).toBe("/opt/bun");
    expect((out.tf as { args: string[] }).args).toContain(MCP_EXEC_ENTRY);
  });

  test("a boxed session lists exactly the box's servers; a manifest entry is ignored for it", async () => {
    const { resolver, warnings } = setup({ box: bundleBox({ "ruby-lsp": { command: "/usr/local/bin/ruby-lsp-mcp", args: ["--stdio"] } }) });
    const out = await resolver("s1");
    expect(out).toEqual({ "ruby-lsp": { type: "stdio", command: "/usr/local/bin/ruby-lsp-mcp", args: ["--stdio"] } });
    // The node secret a manifest server would have carried is nowhere in what a boxed session mounts.
    expect(JSON.stringify(out)).not.toContain("tf-fake-value");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("persona=platform-bot runs in box 'ruby-dev' and is also allowed stdio servers in the node manifest");
  });

  test("the warning is one per persona, and none when the manifest does not allow the persona", async () => {
    const boxed = setup({ box: bundleBox({}) });
    await boxed.resolver("s1");
    await boxed.resolver("s2");
    expect(boxed.warnings).toHaveLength(1);
    const unlisted = setup({ persona: "finance-bot", box: bundleBox({}) });
    expect(await unlisted.resolver("s1")).toEqual({});
    expect(unlisted.warnings).toEqual([]);
  });

  test("a boxed session with no servers gets none: the manifest is not a fallback", async () => {
    expect(await setup({ box: bundleBox({}) }).resolver("s1")).toEqual({});
  });

  test("a node with no manifest still serves a boxed session's servers", async () => {
    const { resolver } = setup({ manifest: null, box: bundleBox({ rg: { command: "/usr/bin/rg-mcp", args: [] } }) });
    expect(Object.keys(await resolver("s1"))).toEqual(["rg"]);
  });

  test("tier none: nothing asks about a box, and the manifest path makes its one bundle call", async () => {
    const { resolver, calls } = setup({ tier: "none", box: bundleBox({ rg: { command: "/usr/bin/rg-mcp", args: [] } }), persona: "support-bot" });
    expect(Object.keys(await resolver("s1"))).toEqual(["gh"]);
    expect(calls).toEqual(["support-bot"]);
  });

  test("a boxed persona whose session is not pinned fails the boot; it is not given the manifest's servers", async () => {
    const { resolver } = setup({ box: bundleBox({}), pinned: false });
    const e = await resolver("s1").catch((x) => x);
    expect(e).toBeInstanceOf(BootFailure);
    expect((e as BootFailure).code).toBe("BOX_UNAVAILABLE");
  });

  test("a bundle the gateway refuses fails the boot with the gateway's reason", async () => {
    const { resolver } = setup({ runtime: async () => Promise.reject(new NodeApiError(503, JSON.stringify({ code: "BOX_UNAVAILABLE", transient: false }))) });
    const e = await resolver("s1").catch((x) => x);
    expect(e).toBeInstanceOf(BootFailure);
    expect((e as BootFailure).code).toBe("BOX_UNAVAILABLE");
  });

  test("a box whose server holds a ${ fails the boot on the node, even though the gateway sent it", async () => {
    const { resolver } = setup({ box: bundleBox({ lsp: { command: "/usr/bin/lsp", args: ["${HOME}"] } }) });
    expect(await resolver("s1").catch((x) => x)).toBeInstanceOf(BootFailure);
  });
});
