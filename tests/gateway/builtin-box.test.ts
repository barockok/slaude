// The built-in default box through a real sync and a real runtime bundle. Postgres-only: run with SLAUDE_DB=pg.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { __resetPersonaRegistry } from "../../src/persona/registry";
import { payloadVersionFor } from "../../src/persona/sync/payload";
import { SyncFailure, runSync } from "../../src/persona/sync/run";
import { __resetGuardrailKeyForTests } from "../../src/guardrails/integrity";
import { CAPABILITIES_HEADER } from "../../src/guardrails/capability";
import { __clearBoxesForTests, boxSetVersion } from "../../src/db/boxes";
import { __setBuiltinBoxDirForTests } from "../../src/box/builtin";
import { nodeBoxCapabilities } from "../../src/box/capability";
import { __resetBoxRegistryForTests } from "../../src/gateway/core/box-registry";
import { handleTenantRuntime } from "../../src/gateway/api/tenants";
import { NODE_CAPS } from "../../src/node/worker";

const isPg = process.env.SLAUDE_DB === "pg";
const T = "default";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const REPO = "ghcr.io/example/slaude-box-default";
const shippedYaml = readFileSync(join(import.meta.dir, "../../boxes/default/box.yaml"), "utf8");

const made: string[] = [];
function useBuiltin(c: string | null): void {
  if (c === null) return __setBuiltinBoxDirForTests(null);
  const dir = mkdtempSync(join(tmpdir(), "builtin-box-gw-"));
  made.push(dir);
  writeFileSync(join(dir, "box.yaml"), shippedYaml);
  writeFileSync(join(dir, "image.ref"), `amd64=${REPO}@${digest(c)}\narm64=${REPO}@${digest(c)}\n`);
  __setBuiltinBoxDirForTests(dir);
  __resetBoxRegistryForTests();
}

const defaultFile = `name: default\nsoul: You are the default.\nmandate:\n  global: Default mandate.\naccess:\n  manager: UBOSS\n`;
const anaFile = (extra = "") => `name: ana\nslackUserId: UANA1\nsoul: You are Ana.\n${extra}`;
let n = 0;
function payload(opts: { ana?: string; boxes?: unknown[] } = {}) {
  n += 1;
  const personas = [parseAgentYaml("default", defaultFile).spec, parseAgentYaml("ana", anaFile(opts.ana ?? "")).spec];
  return {
    version: payloadVersionFor(personas, [], undefined, opts.boxes),
    revision: `b${n}`,
    committedAt: new Date(Date.UTC(2026, 10, 25, 10, n)).toISOString(),
    personas,
    ...(opts.boxes !== undefined ? { boxes: opts.boxes } : {}),
  };
}
const run = (p: ReturnType<typeof payload>, o: { dryRun?: boolean; env?: Record<string, string> } = {}) =>
  runSync(T, p, { dryRun: o.dryRun ?? false, env: o.env ?? { SLAUDE_BOX: "on" }, by: "ci" });
const refusal = async (p: ReturnType<typeof payload>, o: Parameters<typeof run>[1] = {}) => {
  const e = await run(p, o).catch((x) => x);
  expect(e).toBeInstanceOf(SyncFailure);
  return e as SyncFailure;
};
const req = (extra: Record<string, string> = {}) => new Request("https://x/", { headers: { [CAPABILITIES_HEADER]: [...NODE_CAPS, ...nodeBoxCapabilities("gvisor")].join(","), ...extra } });
const bundle = (persona = "ana", r: Request = req()) => handleTenantRuntime(r, T, persona, { nodeId: "n1", sessionId: "S1" });

const saved = { key: process.env.SLAUDE_MASTER_KEY, box: process.env.SLAUDE_BOX, def: process.env.SLAUDE_BOX_DEFAULT };
const wipe = async () => {
  for (const t of ["persona_overrides", "persona_sync_state", "personas", "audit_events"]) await db.run(`DELETE FROM ${t}`);
  await __clearBoxesForTests();
  __resetPersonaRegistry();
  __resetBoxRegistryForTests();
};

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  __resetGuardrailKeyForTests();
  delete process.env.SLAUDE_BOX;
  delete process.env.SLAUDE_BOX_DEFAULT;
  useBuiltin(null);
  if (isPg) await wipe();
});
afterEach(async () => {
  if (isPg) await wipe();
  for (const [name, v] of [["SLAUDE_MASTER_KEY", saved.key], ["SLAUDE_BOX", saved.box], ["SLAUDE_BOX_DEFAULT", saved.def]] as const) {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
  __resetMasterKeyCache();
  __resetGuardrailKeyForTests();
});
afterAll(() => {
  __setBuiltinBoxDirForTests(undefined);
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!isPg)("sync: a persona that names the built-in box", () => {
  test("refused without a built-in, as any name this deploy does not define", async () => {
    const e = await refusal(payload({ ana: "box: default\n" }));
    expect(e.status).toBe(422);
    expect(e.message).toBe("persona 'ana': box names 'default', which this deploy does not define");
  });

  test("accepted with one, with no boxes list, with a list that lacks it, and on a dry run; nothing is stored for it", async () => {
    useBuiltin("a");
    await run(payload({ ana: "box: default\n" }), { dryRun: true });
    await run(payload({ ana: "box: default\n" }));
    await run(payload({ ana: "box: default\n", boxes: [] }));
    expect(await db.one(`SELECT 1 AS x FROM boxes WHERE name = 'default'`)).toBeNull();
    // Another unknown name is still refused.
    expect((await refusal(payload({ ana: "box: nope\n" }))).message).toContain("which this deploy does not define");
  });

  test("a deploy that removes its own `default` while a persona names it is still refused: the built-in does not take it over", async () => {
    useBuiltin("a");
    const own = { name: "default", image: `ghcr.io/example/boxes/default@${digest("c")}` };
    await run(payload({ ana: "box: default\n", boxes: [own] }));
    const v = await boxSetVersion(T);
    const e = await refusal(payload({ ana: "box: default\n", boxes: [] }));
    expect(e.message).toContain("which this deploy removes");
    expect(await boxSetVersion(T)).toBe(v);
  });
});

describe.skipIf(!isPg)("runtime bundle: the built-in box", () => {
  test("SLAUDE_BOX off: no box in the bundle, built-in or not", async () => {
    useBuiltin("a");
    process.env.SLAUDE_BOX_DEFAULT = "default";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run(payload({ ana: "box: default\n" }), { env: {} });
    } finally {
      warn.mockRestore();
    }
    const body = (await (await bundle()).json()) as Record<string, unknown>;
    expect(Object.hasOwn(body, "box")).toBe(false);
  });

  test("`box: default` and SLAUDE_BOX_DEFAULT=default both resolve to it, version 0, with the shipped policy", async () => {
    useBuiltin("a");
    process.env.SLAUDE_BOX = "on";
    await run(payload({ ana: "box: default\n" }));
    const named = (await (await bundle()).json()) as any;
    expect(named.box).toMatchObject({ name: "default", version: 0, image: `${REPO}@${digest("a")}`, digest: digest("a") });
    expect(named.box.policy.egress.allow).toContain("registry.npmjs.org");
    expect(named.box.policy.tier).toBe("gvisor");

    await run(payload({}));
    expect(Object.hasOwn((await (await bundle()).json()) as object, "box")).toBe(false);
    process.env.SLAUDE_BOX_DEFAULT = "default";
    expect(((await (await bundle()).json()) as any).box.digest).toBe(digest("a"));
  });

  test("the ETag changes when the gateway ships another digest, and a node's cached bundle is refused", async () => {
    useBuiltin("a");
    process.env.SLAUDE_BOX = "on";
    await run(payload({ ana: "box: default\n" }));
    const etag = (await bundle()).headers.get("etag")!;
    expect((await bundle("ana", req({ "if-none-match": etag }))).status).toBe(304);
    useBuiltin("b");
    const next = await bundle("ana", req({ "if-none-match": etag }));
    expect(next.status).toBe(200);
    expect(next.headers.get("etag")).not.toBe(etag);
    expect(((await next.json()) as any).box.digest).toBe(digest("b"));
  });

  test("named and absent: the bundle is refused, never served without a box", async () => {
    useBuiltin("a");
    process.env.SLAUDE_BOX = "on";
    await run(payload({ ana: "box: default\n" }));
    useBuiltin(null);
    __resetBoxRegistryForTests();
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await bundle();
      expect(r.status).toBe(503);
      expect(((await r.json()) as any).code).toBe("BOX_UNAVAILABLE");
    } finally {
      err.mockRestore();
    }
  });
});
