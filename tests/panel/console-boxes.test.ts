/**
 * The console's read-only boxes view: built field by field from the verified
 * set. An env value and a stdio argument never leave the gateway, and a set
 * that does not verify shows nothing.
 */
import { describe, expect, test } from "bun:test";
import { boxesView } from "../../src/gateway/panel/boxes-view";
import { BoxIntegrityError, type BoxEntry, type BoxSnapshot, type BoxVersion } from "../../src/gateway/core/box-registry";
import { parseBoxPayload } from "../../src/box/definition";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const version = (name: string, n: number, c: string, over: Record<string, unknown> = {}): BoxVersion => {
  const b = parseBoxPayload({ name, image: `ghcr.io/example/boxes/${name}@${digest(c)}`, ...over });
  return { name, version: n, image: b.image, digest: b.digest, policy: b.policy, forced: b.policy.refresh.force };
};
const entry = (name: string, versions: BoxVersion[], description = ""): BoxEntry => ({ name, description, current: versions.at(-1)!, versions });
const snapshot = (entries: BoxEntry[], setVersion = 3): BoxSnapshot => ({ setVersion, boxes: new Map(entries.map((e) => [e.name, e])) });

const ENV_VALUE = "value-that-must-not-be-shown";
const ARG_VALUE = "--argument-that-must-not-be-shown";

describe("boxesView", () => {
  test("boxes by name, versions newest first, the policy field by field", async () => {
    const ruby = entry(
      "ruby-dev",
      [
        version("ruby-dev", 1, "a"),
        version("ruby-dev", 2, "b", {
          tier: "bwrap",
          egress: { allow: ["rubygems.org", "github.com"], deny: ["uploads.github.com"] },
          env: { BUNDLE_JOBS: ENV_VALUE, ALPHA: "1" },
          mcp: { stdio: { "ruby-lsp": { command: "/usr/local/bin/ruby-lsp-mcp", args: [ARG_VALUE, "--stdio"] } } },
          durable: { exclude: [".cache/big"] },
          refresh: { force: true, note: "Ruby moved to 3.4" },
        }),
      ],
      "Ruby toolchain",
    );
    const out = await boxesView("default", { enabled: true, load: async () => snapshot([ruby, entry("py-dev", [version("py-dev", 1, "c")])]) });
    expect(out.enabled).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.setVersion).toBe(3);
    expect(out.boxes.map((b) => b.name)).toEqual(["py-dev", "ruby-dev"]);
    const b = out.boxes[1]!;
    expect(b).toMatchObject({ name: "ruby-dev", description: "Ruby toolchain", version: 2, repository: "ghcr.io/example/boxes/ruby-dev", digest: digest("b") });
    expect(b.versions).toEqual([
      { version: 2, current: true, repository: "ghcr.io/example/boxes/ruby-dev", digest: digest("b"), forced: true, tier: "bwrap" },
      { version: 1, current: false, repository: "ghcr.io/example/boxes/ruby-dev", digest: digest("a"), forced: false, tier: "gvisor" },
    ]);
    expect(b.policy).toEqual({
      tier: "bwrap",
      resources: { cpu: 2, memoryMb: 3072, memoryReserveMb: 1024, pids: 512, homeMb: 4096, workspaceExtrasMb: 4096, rootOverlayMb: 2048 },
      egress: { allow: ["github.com", "rubygems.org"], deny: ["uploads.github.com"] },
      env: ["ALPHA", "BUNDLE_JOBS"],
      stdio: [{ name: "ruby-lsp", command: "/usr/local/bin/ruby-lsp-mcp", args: 2 }],
      durableExclude: [".cache/big"],
      refresh: { force: true, note: "Ruby moved to 3.4" },
    });
  });

  test("an env value and a stdio argument are never in the response", async () => {
    const e = entry("ruby-dev", [version("ruby-dev", 1, "a", { env: { SETTING: ENV_VALUE }, mcp: { stdio: { lsp: { command: "/bin/lsp", args: [ARG_VALUE] } } } })]);
    const text = JSON.stringify(await boxesView("default", { enabled: true, load: async () => snapshot([e]) }));
    expect(text).not.toContain(ENV_VALUE);
    expect(text).not.toContain(ARG_VALUE);
    expect(text).toContain("SETTING");
  });

  test("a field the store gains later is not passed through", async () => {
    const e = entry("ruby-dev", [version("ruby-dev", 1, "a")]);
    (e.current.policy as unknown as Record<string, unknown>).futureField = "leak";
    (e as unknown as Record<string, unknown>).internal = "leak";
    expect(JSON.stringify(await boxesView("default", { enabled: true, load: async () => snapshot([e]) }))).not.toContain("leak");
  });

  test("a set that does not verify shows nothing but the reason; any other failure is not swallowed", async () => {
    const out = await boxesView("default", {
      enabled: false,
      load: async () => {
        throw new BoxIntegrityError("box 'ruby-dev' version 1 signature does not verify");
      },
    });
    expect(out).toEqual({ enabled: false, verified: false, problem: "box 'ruby-dev' version 1 signature does not verify", setVersion: null, boxes: [] });
    await expect(boxesView("default", { enabled: true, load: async () => { throw new Error("db down"); } })).rejects.toThrow("db down");
  });

  test("no boxes: an empty list, and the switch as it is", async () => {
    expect(await boxesView("default", { enabled: false, load: async () => snapshot([], 0) })).toEqual({ enabled: false, verified: true, setVersion: 0, boxes: [] });
  });
});

describe("GET /panel/api/boxes", () => {
  const SECRET = "s".repeat(40);
  const cookie = `${AT_COOKIE}=${mintSession({ sub: "s", email: "alice@example.com" }, "at", { secret: SECRET })}`;
  const saved = { secret: process.env.SLAUDE_PANEL_SECRET, ops: process.env.SLAUDE_PANEL_OPERATORS, box: process.env.SLAUDE_BOX };

  test("is read-only: GET only, and empty with the switch off on a deployment with no boxes", async () => {
    process.env.SLAUDE_PANEL_SECRET = SECRET;
    process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
    delete process.env.SLAUDE_BOX;
    __resetRoleCache();
    try {
      const panel = createPanelApi({ registry: null, role: "mono", pubsub: null, panelLock: null, chat: async () => {} });
      const req = (method: string) => new Request("https://panel.example.com/panel/api/boxes", { method, headers: { cookie, ...(method !== "GET" ? { "x-panel-csrf": "1" } : {}) } });
      const res = (await panel.fetch(req("GET")))!;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean; verified: boolean; boxes: unknown[] };
      expect(body.enabled).toBe(false);
      expect(body.verified).toBe(true);
      // The default suite runs on sqlite, which has no box tables; a Postgres run may hold other suites' boxes.
      if (process.env.SLAUDE_DB !== "pg") expect(body.boxes).toEqual([]);
      for (const m of ["POST", "PUT", "DELETE"]) expect((await panel.fetch(req(m)))!.status).toBe(405);
    } finally {
      for (const [k, v] of [["SLAUDE_PANEL_SECRET", saved.secret], ["SLAUDE_PANEL_OPERATORS", saved.ops], ["SLAUDE_BOX", saved.box]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      __resetRoleCache();
    }
  });
});
