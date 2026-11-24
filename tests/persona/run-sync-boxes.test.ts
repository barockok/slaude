// Box sync through a real runSync. Postgres-only: run with SLAUDE_DB=pg.
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { flushAudits } from "../../src/audit/emit";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { __resetPersonaRegistry } from "../../src/persona/registry";
import { payloadVersionFor } from "../../src/persona/sync/payload";
import { SyncFailure, runSync } from "../../src/persona/sync/run";
import { __resetGuardrailKeyForTests } from "../../src/guardrails/integrity";
import { __clearBoxesForTests, boxSetVersion, readBoxes } from "../../src/db/boxes";
import { __resetBoxRegistryForTests, loadBoxes } from "../../src/gateway/core/box-registry";
import { boxHighWater } from "../../src/box/high-water";
import { BOX_SUPPORTED_PROVIDER_FORMS, declaredProviderForms, unboxableProviderForms } from "../../src/box/provider-forms";

const isPg = process.env.SLAUDE_DB === "pg";
const T = "default";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const image = (c: string) => `ghcr.io/example/boxes/ruby-dev@${digest(c)}`;
const box = (over: Record<string, unknown> = {}) => ({ name: "ruby-dev", image: image("a"), ...over });

const defaultFile = `name: default\nsoul: You are the default.\nmandate:\n  global: Default mandate.\naccess:\n  manager: UBOSS\n`;
const anaFile = (extra = "") => `name: ana\nslackUserId: UANA1\nsoul: You are Ana.\n${extra}`;

let n = 0;
function payload(opts: { ana?: string; boxes?: unknown[] } = {}) {
  n += 1;
  const personas = [parseAgentYaml("default", defaultFile).spec, parseAgentYaml("ana", anaFile(opts.ana ?? "")).spec];
  return {
    version: payloadVersionFor(personas, [], undefined, opts.boxes),
    revision: `r${n}`,
    committedAt: new Date(Date.UTC(2026, 10, 24, 10, n)).toISOString(),
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
const wipe = async () => {
  for (const t of ["persona_overrides", "persona_sync_state", "personas", "audit_events"]) await db.run(`DELETE FROM ${t}`);
  await __clearBoxesForTests();
  __resetPersonaRegistry();
  __resetBoxRegistryForTests();
};
const boxAudits = async () => {
  await flushAudits();
  return db.query<{ target_id: string; summary: string; details: unknown }>(`SELECT target_id, summary, details FROM audit_events WHERE action = 'box.synced' ORDER BY id`);
};

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  __resetGuardrailKeyForTests();
  if (isPg) await wipe();
});
afterAll(async () => {
  if (isPg) await wipe();
});

describe("provider forms a box can serve", () => {
  test("the assumption before the spike: all three forms", () => {
    expect([...BOX_SUPPORTED_PROVIDER_FORMS].sort()).toEqual(["api-key", "auth-token", "oauth-token"]);
  });
  test("declared forms are read from the provider's fields, and an unsupported one is named", () => {
    expect(declaredProviderForms(null)).toEqual([]);
    expect(declaredProviderForms({ apiKey: "env://PERSONA_A", baseUrl: "https://llm.example.com" } as never)).toEqual(["api-key"]);
    expect(declaredProviderForms({ authToken: "env://PERSONA_A", oauthToken: "env://PERSONA_B" })).toEqual(["auth-token", "oauth-token"]);
    expect(unboxableProviderForms({ oauthToken: "env://PERSONA_B" })).toEqual([]);
    expect(unboxableProviderForms({ oauthToken: "env://PERSONA_B", apiKey: "env://PERSONA_A" }, new Set(["api-key", "auth-token"]))).toEqual(["oauth-token"]);
  });
});

describe.skipIf(!isPg)("box sync", () => {
  test("create: a version 1 row, a signed set, the report and an audit row", async () => {
    const r = await run(payload({ boxes: [box({ egress: { allow: ["github.com"] } })], ana: "box: ruby-dev\n" }));
    expect(r.boxes).toEqual({ created: [{ name: "ruby-dev", version: 1, diff: ["new box"] }], updated: [], unchanged: [], removed: [] });
    const snap = await loadBoxes(T);
    expect(snap.setVersion).toBe(1);
    expect(snap.boxes.get("ruby-dev")!.current).toMatchObject({ version: 1, digest: digest("a"), image: image("a") });
    const stored = await db.one<{ definition: unknown }>(`SELECT definition FROM personas WHERE name = 'ana'`);
    const definition = typeof stored!.definition === "string" ? JSON.parse(stored!.definition) : stored!.definition;
    expect(definition.box).toBe("ruby-dev");
    const audits = await boxAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target_id).toBe("ruby-dev");
    expect(audits[0]!.summary).toBe("box ruby-dev created (version 1): new box");
  });

  test("a payload without a boxes list leaves the stored boxes alone", async () => {
    await run(payload({ boxes: [box()] }));
    const r = await run(payload({ ana: "box: ruby-dev\n" }));
    expect(r.boxes).toBeUndefined();
    expect(await boxSetVersion(T)).toBe(1);
    expect((await readBoxes(T)).boxes).toHaveLength(1);
  });

  test("a new digest is a new version; an unchanged resync writes nothing and audits nothing", async () => {
    await run(payload({ boxes: [box()] }));
    const r = await run(payload({ boxes: [box({ image: image("b") })] }));
    expect(r.boxes!.updated).toEqual([{ name: "ruby-dev", version: 2, diff: ["image: new digest"] }]);
    const again = await run(payload({ boxes: [box({ image: image("b") })] }));
    expect(again.boxes).toEqual({ created: [], updated: [], unchanged: ["ruby-dev"], removed: [] });
    expect(await boxSetVersion(T)).toBe(2);
    expect((await boxAudits()).map((a) => a.summary)).toEqual([
      "box ruby-dev created (version 1): new box",
      "box ruby-dev updated (version 2): image: new digest",
    ]);
  });

  test("a policy-only change is a new version on the same digest, and its values are never in the report or the audit trail", async () => {
    await run(payload({ boxes: [box({ env: { MODE: "first-value" } })] }));
    const r = await run(payload({ boxes: [box({ env: { MODE: "second-value" }, egress: { allow: ["pypi.org"] } })] }));
    expect(r.boxes!.updated).toEqual([{ name: "ruby-dev", version: 2, diff: ["egress.allow: +pypi.org", "env: ~MODE"] }]);
    const e = (await loadBoxes(T)).boxes.get("ruby-dev")!;
    expect(e.versions.map((v) => v.digest)).toEqual([digest("a"), digest("a")]);
    const trail = JSON.stringify(await boxAudits()) + JSON.stringify(r);
    expect(trail).not.toContain("first-value");
    expect(trail).not.toContain("second-value");
  });

  test("a dry run prints the per-box diff and writes nothing", async () => {
    await run(payload({ boxes: [box(), box({ name: "py-dev" })] }));
    const r = await run(payload({ boxes: [box({ image: image("b"), egress: { allow: ["pypi.org"] } }), box({ name: "go-dev" })] }), { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.boxes).toEqual({
      created: [{ name: "go-dev", version: 1, diff: ["new box"] }],
      updated: [{ name: "ruby-dev", version: 2, diff: ["image: new digest", "egress.allow: +pypi.org"] }],
      unchanged: [],
      removed: ["py-dev"],
    });
    expect(await boxSetVersion(T)).toBe(1);
    expect((await readBoxes(T)).boxes.map((b) => b.name)).toEqual(["py-dev", "ruby-dev"]);
    expect(await boxAudits()).toHaveLength(1 + 1);
  });

  test("a box no persona names can be removed", async () => {
    await run(payload({ boxes: [box(), box({ name: "py-dev" })] }));
    const r = await run(payload({ boxes: [box()] }));
    expect(r.boxes!.removed).toEqual(["py-dev"]);
    expect((await boxAudits()).at(-1)!.summary).toBe("box py-dev removed: removed");
  });

  test("removing a box a persona names is refused, dry run included, and nothing is applied", async () => {
    const first = payload({ boxes: [box()], ana: "box: ruby-dev\n" });
    await run(first);
    for (const dryRun of [true, false]) {
      const e = await refusal(payload({ boxes: [], ana: "box: ruby-dev\n" }), { dryRun });
      expect(e.status).toBe(422);
      expect(e.message).toBe("persona 'ana': box names 'ruby-dev', which this deploy removes; keep boxes/ruby-dev or remove the box key from the agent first");
    }
    expect((await readBoxes(T)).boxes).toHaveLength(1);
    const state = await db.one<{ revision: string }>(`SELECT revision FROM persona_sync_state WHERE tenant_id = ?`, [T]);
    expect(state!.revision).toBe(first.revision);
  });

  test("a persona naming an unknown box is refused, with or without a boxes list, dry run included", async () => {
    for (const dryRun of [true, false]) {
      const withList = await refusal(payload({ boxes: [box()], ana: "box: nope\n" }), { dryRun });
      expect(withList.status).toBe(422);
      expect(withList.message).toBe("persona 'ana': box names 'nope', which this deploy does not define");
      const withoutList = await refusal(payload({ ana: "box: nope\n" }), { dryRun });
      expect(withoutList.message).toBe("persona 'ana': box names 'nope', which this deploy does not define");
    }
    expect(await db.one(`SELECT 1 AS x FROM personas LIMIT 1`)).toBeNull();
  });

  test("a bad box fails the whole sync before anything is written, and names the field", async () => {
    const e = await refusal(payload({ boxes: [box({ env: { A: "${PERSONA_SECRET}" } })] }));
    expect(e.status).toBe(422);
    expect(e.message).toMatch(/box 'ruby-dev': env\.A contains \$\{/);
    const shaped = "Bearer abcdefghijklmnopqrstuvwx";
    const s = await refusal(payload({ boxes: [box({ mcp: { stdio: { lsp: { command: "/bin/lsp", args: [shaped] } } } })] }));
    expect(s.message).toMatch(/mcp\.stdio\.lsp\.args\[0\] looks like a credential/);
    expect(s.message).not.toContain(shaped);
    expect(await db.one(`SELECT 1 AS x FROM personas LIMIT 1`)).toBeNull();
    expect(await boxSetVersion(T)).toBe(0);
  });

  test("SLAUDE_BOX off: the payload is accepted and stored, with a warning that nothing applies it", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await run(payload({ boxes: [box()], ana: "box: ruby-dev\n" }), { env: {} });
      expect(r.boxes!.created).toHaveLength(1);
      expect(r.warnings).toContain("persona 'ana' names a box, but SLAUDE_BOX is off on this gateway: the box is stored and not applied");
      const on = await run(payload({ boxes: [box()], ana: "box: ruby-dev\n" }), { env: { SLAUDE_BOX: "on" } });
      expect(on.warnings.filter((w) => w.includes("SLAUDE_BOX"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("without a master key a sync that changes boxes is refused before the personas are applied", async () => {
    delete process.env.SLAUDE_MASTER_KEY;
    __resetMasterKeyCache();
    __resetGuardrailKeyForTests();
    const e = await refusal(payload({ boxes: [box()] }));
    expect(e.status).toBe(422);
    expect(e.message).toBe("boxes need SLAUDE_MASTER_KEY (the stored set is signed with it)");
    expect(await db.one(`SELECT 1 AS x FROM personas LIMIT 1`)).toBeNull();
    // An empty list on an empty set changes nothing and needs no key.
    expect((await run(payload({ boxes: [] }))).boxes).toEqual({ created: [], updated: [], unchanged: [], removed: [] });
  });

  test("a stored set that does not verify refuses the sync and is not re-signed", async () => {
    await run(payload({ boxes: [box()] }));
    await db.run(`UPDATE box_versions SET digest = ? WHERE name = 'ruby-dev'`, [digest("c")]);
    const e = await refusal(payload({ boxes: [box({ image: image("b") })] }));
    expect(e.status).toBe(503);
    expect(e.message).toMatch(/the stored box set does not verify \(box 'ruby-dev' version 1 signature does not verify\)/);
    expect(await boxSetVersion(T)).toBe(1);
    const named = await refusal(payload({ ana: "box: ruby-dev\n" }));
    expect(named.status).toBe(503);
  });

  test("a committed sync raises the high-water mark, and a set rolled back under it refuses the next sync", async () => {
    await run(payload({ boxes: [box()] }));
    expect(await boxHighWater(T)).toBe(1);
    const rows = async (t: string) => db.query<Record<string, unknown>>(`SELECT * FROM ${t}`);
    const old = { boxes: await rows("boxes"), box_versions: await rows("box_versions"), boxes_manifest: await rows("boxes_manifest") };
    await run(payload({ boxes: [box({ image: image("b") })] }));
    expect(await boxHighWater(T)).toBe(2);
    // A dry run commits nothing and so raises nothing.
    await run(payload({ boxes: [box({ image: image("c") })] }), { dryRun: true });
    expect(await boxHighWater(T)).toBe(2);

    for (const t of ["box_versions", "boxes", "boxes_manifest"]) await db.run(`DELETE FROM ${t}`);
    for (const [t, list] of Object.entries(old)) {
      for (const row of list) {
        const cols = Object.keys(row);
        await db.run(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c]));
      }
    }
    const e = await refusal(payload({ boxes: [box({ image: image("d") })] }));
    expect(e.status).toBe(503);
    expect(e.message).toMatch(/older than version 2 seen before \(rolled back\)/);
    expect((await refusal(payload({ boxes: [box({ image: image("d") })] }), { dryRun: true })).status).toBe(503);
    expect(await boxSetVersion(T)).toBe(1);
  });
});
