/**
 * Review focus, items 7, 10 and 12 (box plan, "Review Focus"):
 *
 *   - item 7 as one property over the pin and the refresh together: whatever
 *     the order of deploys, dispatches and commands, the digest a dispatch
 *     answers is the one the audit trail's last pin or refresh row names;
 *   - item 10: a remote environment's tools are an in-process server of the
 *     node worker, so a box whose egress list refuses the remote host does
 *     not stand between `/env use` and that host. Nothing else in the suite
 *     puts the two features side by side;
 *   - item 12 on the gateway's side of the sync, for every credential shape.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { egressVerdict } from "../../src/box/egress/policy";
import { buildBoxEnv } from "../../src/box/env";
import { defaultBoxPolicy } from "../../src/box/policy";
import { sessionBoxPin, type BoxPinDeps } from "../../src/gateway/core/box-pin";
import { refresh, refreshIfStale, type BoxRefreshDeps } from "../../src/gateway/core/box-refresh";
import type { BoxVersion } from "../../src/gateway/core/box-registry";
import { parsePayload } from "../../src/persona/sync/payload";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { REMOTE_MCP_NAME, createRemoteMcp } from "../../src/remote/mcp";
import type { ExecOpts, ExecResult } from "../../src/remote/types";

/** A distinct digest per number, none shaped like the stand-in of an image that was never pushed. */
const digest = (n: number): string => `sha256:${(0xa0000000 + n).toString(16).repeat(8)}`;

/** A box set, one session row and an audit trail, shared by the pin and the refresh as the database is. */
function world() {
  const versions: BoxVersion[] = [];
  const pins = new Map<string, { name: string; digest: string }>();
  const audits: Array<{ action: string; details?: Record<string, unknown> }> = [];
  let busy = false;
  let next = 1;
  const add = (o: { newImage: boolean; forced: boolean }): void => {
    const prev = versions.at(-1);
    const d = o.newImage || !prev ? digest(next++) : prev.digest;
    versions.push({
      name: "ruby-dev",
      version: versions.length + 1,
      image: `ghcr.io/example/boxes/ruby-dev@${d}`,
      digest: d,
      policy: { ...defaultBoxPolicy(), refresh: { force: o.forced, note: "" } },
      forced: o.forced,
    });
  };
  const current = async (): Promise<BoxVersion | null> => versions.at(-1) ?? null;
  const pinned = async (_t: string, _n: string, d: string) => {
    const at = [...versions].reverse().find((v) => v.digest === d);
    const cur = versions.at(-1);
    if (!at || !cur) return null;
    return { ...at, policy: cur.policy, stale: versions.some((v) => v.version > at.version && v.forced && v.digest !== d) };
  };
  const audit = ((e: { action: string; details?: Record<string, unknown> }) => void audits.push(e)) as unknown as BoxPinDeps["audit"];
  const pinDeps: BoxPinDeps = {
    enabled: () => true,
    boxNameFor: () => "ruby-dev",
    unboxableForms: () => [],
    unboxedAllowed: () => true,
    current,
    pinned,
    read: async (id) => pins.get(id) ?? null,
    pin: async (id, box) => {
      const had = pins.get(id);
      if (!had) pins.set(id, box);
      return { ...(had ?? box), pinned: !had };
    },
    audit,
  };
  const refreshDeps: BoxRefreshDeps = {
    read: pinDeps.read,
    current,
    pinned,
    turnInFlight: async () => busy,
    setDigest: async (id, name, from, to) => {
      const p = pins.get(id);
      if (!p || p.name !== name || p.digest !== from) return false;
      pins.set(id, { name, digest: to });
      return true;
    },
    reload: () => {},
    mark: async () => {},
    audit,
  };
  return { versions, pins, audits, add, pinDeps, refreshDeps, setBusy: (v: boolean) => (busy = v) };
}

const CTX = { tenant: "default", persona: "ana", sessionId: "S1" };

/** The digest the audit trail says the session is on: the pin row, then every refresh row in order. */
function auditedDigest(audits: Array<{ action: string; details?: Record<string, unknown> }>): string | null {
  let at: string | null = null;
  for (const a of audits) {
    if (a.action === "box.pinned") {
      expect(at).toBeNull();
      at = String(a.details!.digest);
    } else if (a.action === "box.refreshed") {
      // A refresh row always starts where the trail stood.
      expect(a.details!.from).toBe(at);
      at = String(a.details!.to);
    }
  }
  return at;
}

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("review focus 7: a pinned session and the audit trail", () => {
  test("a session pinned to one digest answers that digest through any number of unforced versions, with no row but the pin", async () => {
    const w = world();
    w.add({ newImage: true, forced: false });
    const first = (await sessionBoxPin(CTX, w.pinDeps))!.digest;
    for (let i = 0; i < 5; i++) {
      w.add({ newImage: true, forced: false });
      const pin = (await sessionBoxPin(CTX, w.pinDeps))!;
      expect(await refreshIfStale(CTX, pin, w.refreshDeps)).toBeNull();
      expect((await sessionBoxPin(CTX, w.pinDeps))!.digest).toBe(first);
    }
    expect(w.audits.map((a) => a.action)).toEqual(["box.pinned"]);
  });

  test("property: over random deploys, dispatches and refresh commands, the digest a dispatch answers is the one the trail names", async () => {
    // A refresh logs one line; sixty runs of them would bury the result.
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    const seen = { user: 0, forced: 0 };
    const oneRun = async (seed: number): Promise<void> => {
      const w = world();
      const rand = rng(seed);
      w.add({ newImage: true, forced: false });
      let moves = 0;
      for (let step = 0; step < 40; step++) {
        const r = rand();
        if (r < 0.2) w.add({ newImage: true, forced: false });
        else if (r < 0.3) w.add({ newImage: true, forced: true });
        else if (r < 0.4) w.add({ newImage: false, forced: rand() < 0.5 });
        else if (r < 0.5) w.setBusy(rand() < 0.5);
        else if (r < 0.65) {
          // `/box refresh` in the thread.
          const res = await refresh(CTX, { by: { kind: "user", userId: "U1" } }, w.refreshDeps);
          if (res.status === "refreshed") moves++;
        } else {
          // A dispatch, as src/gateway/core/dispatch.ts runs it: the pin, then the forced-refresh check, then the pin the job carries.
          const pin = (await sessionBoxPin(CTX, w.pinDeps))!;
          const moved = await refreshIfStale(CTX, pin, w.refreshDeps);
          if (moved) moves++;
          const runs = moved ? moved.to : pin.digest;
          expect(`seed ${seed}: ${runs}`).toBe(`seed ${seed}: ${auditedDigest(w.audits)}`);
        }
        // At every step, not only at a dispatch: the row and the trail agree.
        const row = w.pins.get(CTX.sessionId)?.digest ?? null;
        expect(`seed ${seed}: ${row}`).toBe(`seed ${seed}: ${auditedDigest(w.audits)}`);
      }
      const refreshed = w.audits.filter((a) => a.action === "box.refreshed");
      expect(refreshed).toHaveLength(moves);
      expect(w.audits.filter((a) => a.action === "box.pinned").length).toBeLessThanOrEqual(1);
      seen.user += refreshed.filter((a) => a.details!.by === "user").length;
      seen.forced += refreshed.filter((a) => a.details!.by === "forced").length;
    };
    try {
      for (let seed = 1; seed <= 60; seed++) await oneRun(seed);
    } finally {
      quiet.mockRestore();
    }
    // The runs really moved sessions both ways: the property was not held by nothing happening.
    expect(seen.user).toBeGreaterThan(20);
    expect(seen.forced).toBeGreaterThan(20);
  });

  test("a turn in flight moves nothing and writes nothing, forced or asked for", async () => {
    const w = world();
    w.add({ newImage: true, forced: false });
    const pin = (await sessionBoxPin(CTX, w.pinDeps))!;
    w.add({ newImage: true, forced: true });
    w.setBusy(true);
    expect(await refreshIfStale(CTX, pin, w.refreshDeps)).toBeNull();
    expect((await refresh(CTX, { by: { kind: "user", userId: "U1" } }, w.refreshDeps)).status).toBe("deferred");
    expect((await sessionBoxPin(CTX, w.pinDeps))!.digest).toBe(pin.digest);
    expect(w.audits.map((a) => a.action)).toEqual(["box.pinned"]);
  });
});

// ---------------------------------------------------------------------------

describe("review focus 10: /env use in a boxed session", () => {
  const REMOTE_HOST = "devbox.tailnet.example";

  test("the remote tools run in the worker's process, so the box's egress list is not on their path", async () => {
    // The box: an egress list that does not mention the remote host refuses it, on the ssh port and on the web ports.
    const egress = { allow: ["registry.npmjs.org"], deny: [] };
    for (const port of [22, 443]) expect(egressVerdict(egress, REMOTE_HOST, port)).toEqual({ allow: false, reason: "not-allowlisted" });

    // The environment: its server is handed to the SDK as an object of this process, not as a command or a URL the
    // CLI inside the box would have to start or reach.
    const calls: Array<{ cmd: string; opts: ExecOpts }> = [];
    const exec = async (cmd: string, opts: ExecOpts): Promise<ExecResult> => {
      calls.push({ cmd, opts });
      return { stdout: "ran on the remote machine\n", stderr: "", code: 0, truncated: false, timedOut: false };
    };
    const server = createRemoteMcp({ exec, root: "/home/dev/project", sessionKey: "s1" });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe(REMOTE_MCP_NAME);
    expect(server.instance).toBeDefined();
    expect(Object.keys(server).sort()).toEqual(["instance", "name", "type"]);

    // A tool call reaches `exec` here, in this process: the connection to the remote host is opened by whoever
    // holds `exec` (the node worker), and no proxy of a box is asked.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "review-focus", version: "0.0.0" });
    await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
    try {
      const res = (await client.callTool({ name: "bash", arguments: { command: "echo hi" } })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(res.isError ?? false).toBe(false);
      expect(JSON.stringify(res.content)).toContain("ran on the remote machine");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.some((c) => c.cmd.includes("echo hi"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("a box's environment says nothing of a remote environment: no host, no key, no variable of the feature", () => {
    const out = buildBoxEnv({
      sdkEnv: { SLAUDE_REMOTE_HOST: REMOTE_HOST, SLAUDE_REMOTE_KEY: "ssh-ed25519 AAAA-example", SSH_AUTH_SOCK: "/run/ssh.sock" },
      imageEnv: {},
      policy: defaultBoxPolicy(),
      scratchDir: "/data/scratch/s1",
      configDir: "/config/s1",
      providerForm: "api-key",
    });
    expect(JSON.stringify(out)).not.toContain(REMOTE_HOST);
    expect(Object.keys(out).filter((k) => /REMOTE|SSH/.test(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("review focus 12: the gateway's own check of a synced box", () => {
  const REF = `ghcr.io/example/boxes/ruby-dev@sha256:${"a".repeat(64)}`;
  const persona = parseAgentYaml("ana", "name: ana\nslackUserId: slack:user:UTESTUSER1\nsoul: You are Ana.\n").spec;
  const sync = (box: Record<string, unknown>): string => {
    try {
      parsePayload({ version: 8, revision: "r1", committedAt: "2026-11-24T10:00:00Z", personas: [persona], boxes: [{ name: "ruby-dev", image: REF, ...box }] });
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  // Assembled at run time so no token-shaped literal sits in the repository.
  const shaped: Array<[string, string]> = [
    ["a code host token", ["gh", "p_"].join("") + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"],
    ["a chat token", ["xox", "b-"].join("") + "123456789012-abcdefghijkl"],
    ["a cloud access key id", ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP"],
    ["a signed token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl"],
    ["a bearer header", "Bearer abcdefghijklmnopqrstuvwx"],
    ["a URL with a password", "https://deploy:hunter2hunter2@registry.example.com/"],
    ["a key=value pair", "password=correct-horse-battery"],
  ];

  test("a clean box passes the same check", () => {
    expect(sync({ env: { BUNDLE_JOBS: "4" }, mcp: { stdio: { lsp: { command: "/usr/bin/lsp", args: ["--stdio"] } } } })).toBe("");
  });

  for (const [what, value] of shaped) {
    test(`${what}: refused as an env value and as a stdio argument, naming the field and never the value`, () => {
      const asEnv = sync({ env: { SETTING: value } });
      expect(asEnv).toMatch(/box 'ruby-dev': env\.SETTING looks like a credential/);
      const asArg = sync({ mcp: { stdio: { lsp: { command: "/usr/bin/lsp", args: ["--stdio", value] } } } });
      expect(asArg).toMatch(/box 'ruby-dev': mcp\.stdio\.lsp\.args\[1\] looks like a credential/);
      for (const msg of [asEnv, asArg]) {
        expect(msg).not.toContain(value);
        expect(msg).not.toContain(value.slice(0, 10));
        expect(msg).not.toContain(value.slice(-10));
      }
    });
  }

  const placeholders: Array<[string, Record<string, unknown>, RegExp]> = [
    ["an env value", { env: { A: "${B}" } }, /env\.A contains \$\{/],
    ["an env name", { env: { "${A}": "b" } }, /env\.<invalid-key> contains \$\{/],
    ["a stdio command", { mcp: { stdio: { lsp: { command: "/usr/bin/${LSP}" } } } }, /mcp\.stdio\.lsp\.command contains \$\{/],
    ["a stdio argument", { mcp: { stdio: { lsp: { command: "/usr/bin/lsp", args: ["${KEY}"] } } } }, /mcp\.stdio\.lsp\.args\[0\] contains \$\{/],
    ["the description", { description: "uses ${HOME}" }, /description contains \$\{/],
    ["an egress host", { egress: { allow: ["${HOST}"] } }, /egress\.allow\[0\] contains \$\{/],
    ["a durable path", { durable: { exclude: [".cache/${X}"] } }, /durable\.exclude\[0\] contains \$\{/],
    ["the refresh note", { refresh: { note: "see ${URL}" } }, /refresh\.note contains \$\{/],
  ];
  for (const [where, box, re] of placeholders) {
    test(`\${ in ${where} fails the sync and the message names the field`, () => {
      const msg = sync(box);
      expect(msg).toMatch(re);
      expect(msg).toMatch(/^box 'ruby-dev': /);
    });
  }
});
