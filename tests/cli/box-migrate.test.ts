/**
 * `slaude box from-manifest` and `slaude box preflight` (box plan, Phase 8):
 * what becomes of a node manifest's servers in a box, and the opt-in
 * checklist for one persona. Both report and change nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyManifest, preflight, renderFromManifest, renderPreflight } from "../../src/cli/box-migrate";
import { parseBoxYaml } from "../../src/box/definition";
import { readDeclaredNodeManifest } from "../../src/node/manifest";
import { BOX_SUPPORTED_PROVIDER_FORMS } from "../../src/box/provider-forms";
import { boxTierCapability } from "../../src/box/capability";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const REF = `ghcr.io/example/boxes/ruby-dev@${digest("a")}`;

/** One server of each case, plus one more of the first. */
const MANIFEST = {
  version: 1,
  mcpServers: {
    // 1. credential-free
    rubocop: { command: "/usr/local/bin/rubocop-mcp", args: ["--stdio"], env: { RUBOCOP_CACHE: "false" } },
    search: { command: "ripgrep-mcp" },
    // 2. a node secret, no session files
    tf: { command: "terraform-mcp", args: ["--stdio"], env: { TF_TOKEN: "${NODE_TF_TOKEN}", TF_ORG: "example-org" } },
    // 3. a node secret and the session's files
    review: { command: "code-review-mcp", args: ["--workspace", "."], env: { CODE_HOST_TOKEN: "${NODE_CODE_HOST_TOKEN}" } },
  },
  allow: { "platform-bot": "*", "support-bot": ["search"], "ops-bot": ["tf"] },
};
const declared = (m: unknown = MANIFEST) => readDeclaredNodeManifest(JSON.stringify(m), "node.json");

describe("from-manifest: the three cases", () => {
  test("a fixture manifest with one server of each case is classified", () => {
    const r = classifyManifest(declared(), "platform-bot");
    expect(r.listed).toBe(true);
    expect(r.servers.map((s) => [s.name, s.case])).toEqual([
      ["review", "split"],
      ["rubocop", "box"],
      ["search", "box"],
      ["tf", "gateway"],
    ]);
  });

  test("case 1: an mcp.stdio block, credential-free, with literal env moved to the box's env", () => {
    const r = classifyManifest(declared(), "platform-bot");
    const rubocop = r.servers.find((s) => s.name === "rubocop")!;
    expect(rubocop.stdio).toEqual({ command: "/usr/local/bin/rubocop-mcp", args: ["--stdio"] });
    expect(rubocop.boxEnv).toEqual({ RUBOCOP_CACHE: "false" });
    expect(rubocop.secretEnv).toBeUndefined();
    const search = r.servers.find((s) => s.name === "search")!;
    expect(search.notes.join(" ")).toContain("absolute path inside the box image");
    expect(search.boxEnv).toBeUndefined();
  });

  test("case 2: needs a gateway-side server, with the env names that carry a node secret and never a value", () => {
    const tf = classifyManifest(declared(), "ops-bot").servers[0]!;
    expect(tf.case).toBe("gateway");
    expect(tf.secretEnv).toEqual(["TF_TOKEN"]);
    expect(tf.nodeVars).toEqual(["NODE_TF_TOKEN"]);
    expect(tf.stdio).toBeUndefined();
    expect(tf.notes.join(" ")).toContain("${PERSONA_*} placeholder");
  });

  test("case 3: needs both a token and the workspace, guessed from the arguments or stated", () => {
    const review = classifyManifest(declared(), "platform-bot").servers.find((s) => s.name === "review")!;
    expect(review.case).toBe("split");
    expect(review.secretEnv).toEqual(["CODE_HOST_TOKEN"]);
    expect(review.notes.join(" ")).toContain("its arguments name the workspace");
    // Stated by the operator for a server whose arguments say nothing.
    const stated = classifyManifest(declared(), "ops-bot", { workspace: ["tf"] }).servers[0]!;
    expect(stated.case).toBe("split");
    expect(stated.notes.join(" ")).toContain("stated with --workspace");
    expect(() => classifyManifest(declared(), "ops-bot", { workspace: ["nope"] })).toThrow("--workspace names 'nope', which the manifest does not declare");
  });

  test("a secret is recognised by a reference, by a credential-like name and by its shape", () => {
    const token = ["gh", "p_"].join("") + "b".repeat(36);
    const m = declared({
      version: 1,
      mcpServers: {
        byname: { command: "a", env: { API_KEY: "literal" } },
        byshape: { command: "b", env: { SETTING: token } },
        byref: { command: "c", env: { SETTING: "prefix-${NODE_X}" } },
        plain: { command: "d", env: { LOG_LEVEL: "debug" } },
      },
      allow: { p: "*" },
    });
    const r = classifyManifest(m, "p");
    expect(r.servers.map((s) => [s.name, s.case])).toEqual([["byname", "gateway"], ["byref", "gateway"], ["byshape", "gateway"], ["plain", "box"]]);
    const text = renderFromManifest(r);
    expect(text).not.toContain(token);
    expect(text).not.toContain("literal");
    expect(text).toContain("env that carries a node secret: API_KEY");
  });

  test("a persona the manifest does not list, and one allowed nothing", () => {
    const none = classifyManifest(declared(), "finance-bot");
    expect(none).toEqual({ persona: "finance-bot", listed: false, servers: [] });
    expect(renderFromManifest(none)).toContain("is not listed in the manifest's allow");
    const empty = classifyManifest(declared({ version: 1, mcpServers: {}, allow: { p: [] } }), "p");
    expect(renderFromManifest(empty)).toContain("is allowed no stdio server");
  });

  test("the printed mcp.stdio block is a valid part of a box.yaml", () => {
    const text = renderFromManifest(classifyManifest(declared(), "platform-bot"));
    expect(text).toContain("rubocop: moves into the box (mcp.stdio)");
    expect(text).toContain("tf: needs a gateway-side server");
    expect(text).toContain("review: needs both a token and the workspace");
    expect(text).toContain("1 server(s) fit neither side: persona 'platform-bot' stays unboxed");
    // No value of a secret env, and no node variable's value (there is none to print).
    expect(text).not.toContain("example-org");
    const block = text.slice(text.indexOf("mcp:\n"), text.indexOf("\n\n", text.indexOf("mcp:\n")));
    // The bare-name server must be given a path before the box accepts it; with one, the block parses.
    const yaml = `version: 1\nname: ruby-dev\nimage:\n  ref: ${REF}\n${block.replace("command: ripgrep-mcp", "command: /usr/local/bin/ripgrep-mcp")}\n`;
    const box = parseBoxYaml("ruby-dev", yaml);
    expect(Object.keys(box.policy.mcp.stdio)).toEqual(["rubocop", "search"]);
    expect(box.policy.env).toEqual({ RUBOCOP_CACHE: "false" });
  });

  test("every server moves: the summary says the persona can be boxed", () => {
    expect(renderFromManifest(classifyManifest(declared(), "support-bot"))).toContain("persona 'support-bot' can be boxed: every server it is allowed moves into the box.");
    expect(renderFromManifest(classifyManifest(declared(), "ops-bot"))).toContain("can be boxed once the gateway-side server(s) above are deployed");
  });

  test("the command prints the classification and exits 0; bad arguments exit 2; an unreadable manifest exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slaude-from-manifest-"));
    writeFileSync(join(dir, "node.json"), JSON.stringify(MANIFEST));
    const run = async (args: string[]) => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli/box.ts"), ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, SLAUDE_REDIS_URL: "" } });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    const ok = await run(["from-manifest", join(dir, "node.json"), "platform-bot"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("tf: needs a gateway-side server");
    expect((await run(["from-manifest", join(dir, "node.json")])).code).toBe(2);
    writeFileSync(join(dir, "bad.json"), "{not json");
    const bad = await run(["from-manifest", join(dir, "bad.json"), "platform-bot"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("not valid JSON");
  });
});

describe("preflight: the opt-in checklist", () => {
  const AGENT = (extra = "") => `name: ana\nslackUserId: UANA1\nsoul: You are Ana.\n${extra}`;
  const BOX = (extra = "") => `version: 1\nname: ruby-dev\nimage:\n  ref: ${REF}\n${extra}`;
  const MCP = (servers: Record<string, unknown>) => `mcp:\n  mcpServers:\n${Object.entries(servers).map(([n, s]) => `    ${n}: ${JSON.stringify(s)}`).join("\n")}\n`;
  const CODE_HOST = { type: "http", url: "https://code-host-mcp.example.com/mcp?token=not-shown", headers: { Authorization: "Bearer ${PERSONA_ANA_CODE_HOST}" } };

  function repo(o: { agent?: string | null; box?: string | null; manifest?: unknown } = {}): { dir: string; manifest?: string } {
    const dir = mkdtempSync(join(tmpdir(), "slaude-preflight-"));
    if (o.agent !== null) {
      mkdirSync(join(dir, "personas", "ana"), { recursive: true });
      writeFileSync(join(dir, "personas", "ana", "agent.yaml"), o.agent ?? AGENT("box: ruby-dev\nprovider:\n  apiKey: env://PERSONA_ANA_KEY\n"));
    }
    if (o.box !== null) {
      mkdirSync(join(dir, "boxes", "ruby-dev"), { recursive: true });
      writeFileSync(join(dir, "boxes", "ruby-dev", "box.yaml"), o.box ?? BOX());
    }
    if (o.manifest === undefined) return { dir };
    writeFileSync(join(dir, "node.json"), JSON.stringify(o.manifest));
    return { dir, manifest: join(dir, "node.json") };
  }
  const gvisorNodes = async (_label: string, cap: string) => [{ node: "n1", has: cap === boxTierCapability("gvisor") }, { node: "n2", has: false }];
  const status = (r: Awaited<ReturnType<typeof preflight>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
  const detail = (r: Awaited<ReturnType<typeof preflight>>, id: string) => r.checks.find((c) => c.id === id)!.detail;

  test("a persona that fits: every decidable item is ok, and what cannot be decided from files is listed, not assumed", async () => {
    const { dir, manifest } = repo({ manifest: { version: 1, mcpServers: { search: { command: "/usr/bin/rg-mcp" } }, allow: { ana: ["search"] } } });
    const r = await preflight("ana", { repo: dir, manifest, privateCode: false, liveNodes: gvisorNodes });
    expect(status(r)).toEqual({ persona: "ok", box: "ok", provider: "ok", seeding: "manual", manifest: "ok", tier: "ok", "private-code": "ok" });
    expect(r.verdict).toBe("boxable");
    expect(r.box).toBe("ruby-dev");
    expect(detail(r, "tier")).toBe("1 of 2 live node(s) of label 'default' offer tier gvisor or stronger");
    const text = renderPreflight(r);
    expect(text).toContain("nothing here stops it from being boxed; 1 item(s) above could not be decided");
    expect(text).toContain("This command reports only. It changed nothing.");
  });

  test("provider form: supported today; with a form taken out of the constant it fails and names the form", async () => {
    const { dir } = repo({ agent: AGENT("box: ruby-dev\nprovider:\n  oauthToken: env://PERSONA_ANA_OAUTH\n") });
    expect(status(await preflight("ana", { repo: dir })).provider).toBe("ok");
    const narrowed = new Set([...BOX_SUPPORTED_PROVIDER_FORMS].filter((f) => f !== "oauth-token"));
    const r = await preflight("ana", { repo: dir, supportedForms: narrowed });
    expect(status(r).provider).toBe("fail");
    expect(detail(r, "provider")).toContain("(oauth-token) cannot be used from a box");
    expect(detail(r, "provider")).not.toContain("PERSONA_ANA_OAUTH");
    expect(r.verdict).toBe("stays-unboxed");
  });

  test("a persona with no provider of its own: the deployment's credential is not visible here, so it is a manual item", async () => {
    const { dir } = repo({ agent: AGENT("box: ruby-dev\n") });
    const r = await preflight("ana", { repo: dir });
    expect(status(r).provider).toBe("manual");
  });

  test("a manifest server with a secret fails the check and names the server and its case, never the variable's value", async () => {
    const { dir, manifest } = repo({ manifest: MANIFEST_FOR_ANA });
    const r = await preflight("ana", { repo: dir, manifest });
    expect(status(r).manifest).toBe("fail");
    expect(detail(r, "manifest")).toContain("tf: needs a gateway-side server");
    expect(detail(r, "manifest")).toContain("review: needs both a token and the workspace");
    expect(r.verdict).toBe("stays-unboxed");
    // Not given a manifest: said so, not passed.
    expect(status(await preflight("ana", { repo: dir })).manifest).toBe("manual");
  });
  const MANIFEST_FOR_ANA = { ...MANIFEST, allow: { ana: "*" } };

  test("the box's tier must be offered by a live node of the persona's label", async () => {
    const { dir } = repo({ agent: AGENT("box: ruby-dev\nrunsOn: heavy\n") });
    const asked: string[] = [];
    const none = await preflight("ana", { repo: dir, liveNodes: async (label, cap) => (asked.push(`${label}:${cap}`), [{ node: "n1", has: false }]) });
    expect(asked).toEqual(["heavy:box-tier/gvisor"]);
    expect(status(none).tier).toBe("fail");
    expect(detail(none, "tier")).toBe("none of the 1 live node(s) of label 'heavy' offers tier gvisor");
    expect(detail(await preflight("ana", { repo: dir, liveNodes: async () => [] }), "tier")).toBe("label 'heavy' has no live node");
    // No Redis here: not checked, and said so.
    expect(status(await preflight("ana", { repo: dir })).tier).toBe("manual");
    // A box that accepts tier none needs no node to be asked.
    const anyTier = repo({ box: BOX("tier: none\n") });
    expect(status(await preflight("ana", { repo: anyTier.dir })).tier).toBe("ok");
  });

  test("private code: needs a code-host MCP server in the persona's mcp, otherwise it stays unboxed with the reason", async () => {
    const plain = repo();
    const no = await preflight("ana", { repo: plain.dir, privateCode: true });
    expect(status(no)["private-code"]).toBe("fail");
    expect(detail(no, "private-code")).toContain("stays unboxed: it needs private repositories or registries and its mcp declares no MCP server for the code host");
    expect(no.verdict).toBe("stays-unboxed");

    const withHost = repo({ agent: AGENT(`box: ruby-dev\n${MCP({ "code-host": CODE_HOST })}`) });
    const named = await preflight("ana", { repo: withHost.dir, privateCode: true, codeHost: "code-host" });
    expect(status(named)["private-code"]).toBe("ok");
    expect(detail(named, "private-code")).toContain("through its gateway-side MCP server 'code-host'");
    // Not named by the operator: a likely server is offered for confirmation, not assumed.
    const guessed = await preflight("ana", { repo: withHost.dir, privateCode: true });
    expect(status(guessed)["private-code"]).toBe("manual");
    expect(detail(guessed, "private-code")).toContain("confirm with --code-host");
    // Named, but not in the persona's mcp.
    expect(status(await preflight("ana", { repo: withHost.dir, privateCode: true, codeHost: "elsewhere" }))["private-code"]).toBe("fail");
    // Not answered at all.
    expect(status(await preflight("ana", { repo: plain.dir }))["private-code"]).toBe("manual");
    // Nothing of the server's URL query or header is in any text.
    const all = [named, guessed].map(renderPreflight).join("\n");
    expect(all).not.toContain("not-shown");
    expect(all).not.toContain("Bearer");
  });

  test("a persona that is missing, has no agent.yaml, names no box, or names an undefined box", async () => {
    const missing = await preflight("ana", { repo: repo({ agent: null }).dir });
    expect(status(missing)).toEqual({ persona: "fail" });
    expect(missing.verdict).toBe("stays-unboxed");
    const noBox = await preflight("ana", { repo: repo({ agent: AGENT() }).dir });
    expect(status(noBox).box).toBe("manual");
    expect(noBox.box).toBeNull();
    const overridden = await preflight("ana", { repo: repo({ agent: AGENT() }).dir, box: "ruby-dev" });
    expect(status(overridden).box).toBe("ok");
    const undefinedBox = await preflight("ana", { repo: repo({ agent: AGENT("box: py-dev\n") }).dir });
    expect(status(undefinedBox).box).toBe("fail");
    await expect(preflight("../etc", { repo: repo().dir })).rejects.toThrow("not a valid name");
  });

  test("it edits nothing: the repository is byte for byte the same afterwards", async () => {
    const { dir, manifest } = repo({ manifest: MANIFEST_FOR_ANA });
    const snapshot = () => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const n of readdirSync(d).sort()) {
          const p = join(d, n);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else out.push(`${p}:${st.size}:${st.mtimeMs}`);
        }
      };
      walk(dir);
      return out;
    };
    const before = snapshot();
    await preflight("ana", { repo: dir, manifest, privateCode: true, liveNodes: gvisorNodes });
    expect(snapshot()).toEqual(before);
  });

  test("the command: exit 0 when nothing fails, 1 when the persona stays unboxed; with no terminal the private-code question is left open", async () => {
    const run = async (args: string[]) => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli/box.ts"), ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, SLAUDE_REDIS_URL: "" } });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    const { dir } = repo();
    const open = await run(["preflight", "ana", "--repo", dir]);
    expect(open.code).toBe(0);
    expect(open.out).toContain("check  private-code: not answered");
    expect(open.out).toContain("check  tier: not checked (no Redis in this environment)");
    const fails = await run(["preflight", "ana", "--repo", dir, "--private-code"]);
    expect(fails.code).toBe(1);
    expect(fails.out).toContain("FAIL   private-code: stays unboxed");
    expect((await run(["preflight", "ana", "--repo", dir, "--no-private-code"])).out).toContain("ok     private-code");
    expect((await run(["preflight"])).code).toBe(2);
  });
});
