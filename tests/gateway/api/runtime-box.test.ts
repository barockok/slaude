// Boxes in the runtime bundle and the session view. The bundle half is DB-dependent: run with SLAUDE_DB=pg.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import * as P from "../../../src/db/personas";
import * as Sessions from "../../../src/db/sessions";
import type { DesiredPersona } from "../../../src/persona/effective";
import { parseAgentYaml } from "../../../src/persona/agent-def";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { handleTenantRuntime } from "../../../src/gateway/api/tenants";
import { handleSession } from "../../../src/gateway/api/sessions";
import { CAPABILITIES_HEADER } from "../../../src/guardrails/capability";
import { __resetGuardrailKeyForTests } from "../../../src/guardrails/integrity";
import { __clearBoxesForTests, applyBoxes, pinSessionBox } from "../../../src/db/boxes";
import { parseBoxPayload } from "../../../src/box/definition";
import { nodeBoxCapabilities } from "../../../src/box/capability";
import { __resetBoxRegistryForTests } from "../../../src/gateway/core/box-registry";
import { NODE_CAPS } from "../../../src/node/worker";
import { flushAudits } from "../../../src/audit/emit";

const isPg = process.env.SLAUDE_DB === "pg";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const image = (c: string) => `ghcr.io/example/boxes/ruby-dev@${digest(c)}`;
const box = (over: Record<string, unknown> = {}) => parseBoxPayload({ name: "ruby-dev", image: image("a"), ...over });

const compiled = (extra: string) => parseAgentYaml("ana", `name: ana\nslackUserId: UANA1\nsoul: You are Ana.\n${extra}`).spec;
function persona(extra: string, provider: DesiredPersona["provider"] = null): DesiredPersona {
  const { soulData, ...definition } = compiled(extra).definition;
  return {
    name: "ana", slackUserId: "UANA1", userToken: null, model: null, soulMd: "You are Ana.", soulJson: soulData, mcp: null,
    provider, definition, origin: "git", tombstonedAt: null,
  } as DesiredPersona;
}
let rev = 0;
const sync = (p: DesiredPersona, boxes?: ReturnType<typeof box>[]) => {
  rev += 1;
  return P.applySync("default", [p], { revision: `r${rev}`, committedAt: Date.UTC(2026, 10, 24, 10, rev), by: "ci" }, undefined, undefined,
    boxes ? (tx) => applyBoxes(tx, "default", boxes, { by: "ci" }) : undefined);
};
const req = (caps: string[] = [...NODE_CAPS, ...nodeBoxCapabilities("gvisor")]) => new Request("https://x/", { headers: { [CAPABILITIES_HEADER]: caps.join(",") } });
const bundle = async (r: Request = req()) => handleTenantRuntime(r, "default", "ana", { nodeId: "n1", sessionId: "S1" });

const saved = { key: process.env.SLAUDE_MASTER_KEY, box: process.env.SLAUDE_BOX, def: process.env.SLAUDE_BOX_DEFAULT };
const wipe = async () => {
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
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

describe("session view", () => {
  const ids: string[] = [];
  afterAll(async () => {
    for (const id of ids) await db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
  });
  const view = async (id: string) => (await (await handleSession(new Request("https://x/"), id, { session: id } as never)).json()) as Record<string, unknown>;

  test("an unboxed session's view has no box fields; a pinned one carries the name and the digest", async () => {
    const row = await Sessions.createForThread({ thread: { team_id: "T1", channel_id: "C0BOXVIEW", thread_ts: `${Date.now()}.1` }, model: "m", working_dir: "/tmp/wd" });
    ids.push(row.id);
    const before = await view(row.id);
    expect(Object.hasOwn(before, "box_name")).toBe(false);
    expect(Object.hasOwn(before, "box_digest")).toBe(false);
    expect((await pinSessionBox(row.id, { name: "ruby-dev", digest: digest("a") }))!.pinned).toBe(true);
    const after = await view(row.id);
    expect(after.box_name).toBe("ruby-dev");
    expect(after.box_digest).toBe(digest("a"));
    const { box_name: _n, box_digest: _d, updated_at: _u, ...rest } = after;
    const { updated_at: _u2, ...was } = before;
    expect(rest).toEqual(was);
  });
});

describe.skipIf(!isPg)("runtime bundle and boxes", () => {
  test("SLAUDE_BOX off: a persona that names a box has the bundle and the ETag of one that does not", async () => {
    await sync(persona(""));
    const plain = await bundle();
    const plainBody = (await plain.json()) as any;
    await sync(persona("box: ruby-dev\n"), [box()]);
    const named = await bundle();
    const body = (await named.json()) as any;
    expect(Object.hasOwn(body, "box")).toBe(false);
    expect(Object.hasOwn(body.definition ?? {}, "box")).toBe(false);
    expect(body).toEqual(plainBody);
    expect(named.headers.get("etag")).toBe(plain.headers.get("etag"));
    // A node that offers no sandbox is served as before.
    expect((await bundle(req([...NODE_CAPS]))).status).toBe(200);
  });

  test("SLAUDE_BOX on: the bundle carries the box's current version and policy, and no secret", async () => {
    process.env.SLAUDE_BOX = "on";
    await sync(persona("box: ruby-dev\n"), [box({ egress: { allow: ["github.com"] }, env: { BUNDLE_JOBS: "4" } })]);
    const r = await bundle();
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.definition.box).toBe("ruby-dev");
    expect(body.box).toEqual({ name: "ruby-dev", version: 1, image: image("a"), digest: digest("a"), policy: box({ egress: { allow: ["github.com"] }, env: { BUNDLE_JOBS: "4" } }).policy });
    expect(Object.keys(body.box.policy).sort()).toEqual(["durable", "egress", "env", "mcp", "refresh", "resources", "tier"]);
  });

  test("the ETag changes with the box set: a policy-only change busts a node's cached bundle, an unrelated sync does not", async () => {
    process.env.SLAUDE_BOX = "on";
    await sync(persona("box: ruby-dev\n"), [box()]);
    const a = await bundle();
    const etag = a.headers.get("etag")!;
    const cached = await bundle(new Request("https://x/", { headers: { [CAPABILITIES_HEADER]: [...NODE_CAPS, ...nodeBoxCapabilities("gvisor")].join(","), "if-none-match": etag } }));
    expect(cached.status).toBe(304);
    await sync(persona("box: ruby-dev\n"), [box()]);
    expect((await bundle()).headers.get("etag")).toBe(etag);
    await sync(persona("box: ruby-dev\n"), [box({ egress: { allow: ["pypi.org"] } })]);
    const b = await bundle();
    expect(b.headers.get("etag")).not.toBe(etag);
    expect(((await b.json()) as any).box.policy.egress.allow).toEqual(["pypi.org"]);
  });

  test("the deployment default boxes a persona that names none", async () => {
    process.env.SLAUDE_BOX = "on";
    await sync(persona(""), [box()]);
    expect(Object.hasOwn((await (await bundle()).json()) as object, "box")).toBe(false);
    process.env.SLAUDE_BOX_DEFAULT = "ruby-dev";
    expect(((await (await bundle()).json()) as any).box.name).toBe("ruby-dev");
  });

  test("a node that does not offer the box's tier is refused the bundle, audited", async () => {
    process.env.SLAUDE_BOX = "on";
    await db.run("DELETE FROM audit_events WHERE action = 'box.node.unsupported'");
    await sync(persona("box: ruby-dev\n"), [box()]);
    for (const caps of [[...NODE_CAPS], [...NODE_CAPS, ...nodeBoxCapabilities("bwrap")]]) {
      const r = await bundle(req(caps));
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).code).toBe("GUARDRAILS_UNSUPPORTED");
    }
    await flushAudits();
    const rows = await db.query<{ target_id: string }>("SELECT target_id FROM audit_events WHERE action = 'box.node.unsupported'");
    expect(rows.map((x) => x.target_id)).toEqual(["n1", "n1"]);
    // A box that accepts bwrap is served to a bwrap node and to a gvisor node.
    await sync(persona("box: ruby-dev\n"), [box({ tier: "bwrap" })]);
    expect((await bundle(req([...NODE_CAPS, ...nodeBoxCapabilities("bwrap")]))).status).toBe(200);
    expect((await bundle()).status).toBe(200);
  });

  test("a box that is gone or does not verify refuses the bundle: it is never shipped without its box", async () => {
    process.env.SLAUDE_BOX = "on";
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await sync(persona("box: ruby-dev\n"), [box()]);
      await db.run(`UPDATE box_versions SET digest = ? WHERE name = 'ruby-dev'`, [digest("c")]);
      __resetBoxRegistryForTests();
      const tampered = await bundle();
      expect(tampered.status).toBe(503);
      expect(await tampered.json()).toEqual({ error: "box unavailable", code: "BOX_UNAVAILABLE", transient: false });
      await __clearBoxesForTests();
      __resetBoxRegistryForTests();
      expect((await bundle()).status).toBe(503);
    } finally {
      err.mockRestore();
    }
  });
});
