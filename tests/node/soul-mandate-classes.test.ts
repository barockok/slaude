/**
 * A node builds a SOUL.md persona's mandates from the soul text in its bundle
 * and the channel lists the gateway sends beside it. The node's text parse is
 * the gateway's own deterministic parse, so with no cached extraction the two
 * agree.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/manager";
import { __resetNodeSoulWarningsForTests } from "../../src/agent/manager";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";
import type { Persona } from "../../src/persona/types";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { SoulDataSchema } from "../../src/soul/data";
import { bundleWithChannelClasses, bundleEtagForTests } from "../../src/gateway/api/tenants";
import * as PerPersona from "../../src/soul/per-persona";
import { mandateContext, normalizeChannelClasses } from "../../src/soul/mandate-scope";
import { mandateTextFromSoulText } from "../../src/soul/persona-mandates";

const KEYS = ["SLAUDE_ROLE", "SLAUDE_DB", "SLAUDE_PG_URL", "SLAUDE_HOME"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "node-classes-"));
  process.env.SLAUDE_HOME = home;
  delete process.env.SLAUDE_DB;
  delete process.env.SLAUDE_PG_URL;
});
afterEach(() => {
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  __resetNodeSoulWarningsForTests();
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

const CLASSES = { trustedChannels: ["CTEAM01"], allowedChannels: ["CPUB01"] };
const head = "# Sam\n## Mandate\nKeep the board tidy.\n";
const SOULS = {
  reduce: `${head}## Channel CTEAM01\n### Mandate\nMode: reduce\nNever page anyone.\n`,
  extend: `${head}## Channel CTEAM01\n### Mandate\nMode: extend\nAlso triage asks.\n`,
  override: `${head}## Channel CTEAM01\n### Mandate\nOnly triage asks.\n`,
  dm: `${head}## Scope dm\n### Mandate\nMode: reduce\nNo shop talk in private.\n`,
  publicReduce: `${head}## Scope public\n### Mandate\nMode: reduce\nQuiet in public.\n`,
  trustedOverride: `${head}## Scope trusted\n### Mandate\nOpen up with the team.\n`,
};

const block = (p: string) => /<channel-mandate>[\s\S]*?<\/channel-mandate>/.exec(p)?.[0] ?? "";

function nodePrompt(md: string, channel: string, extra: { channelClasses?: unknown; soulJson?: unknown; tenantId?: string } = {}) {
  process.env.SLAUDE_ROLE = "node";
  const a = new AgentManager();
  a.setPersonaSoulResolver(async () => ({ soulMd: md, soulJson: extra.soulJson ?? null, ..."channelClasses" in extra ? { channelClasses: extra.channelClasses } : {}, ...(extra.tenantId ? { tenantId: extra.tenantId } : {}) }) as never);
  return a.__systemPromptForTests("s", "sam", { channelId: channel }).then(block);
}

async function gatewayPrompt(md: string, channel: string, role: "mono" | "gateway" = "mono") {
  process.env.SLAUDE_ROLE = role;
  const p = { name: "sam", slackUserId: "U0P", config: { slackUserId: "U0P", name: "sam" }, outClient: null, soulMd: md } as unknown as Persona;
  const reg: PersonaRegistry = {
    lookupByUserId: () => null, lookupByName: (n) => (n === "sam" ? p : null), list: () => [p],
    isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null,
  };
  setPersonaRegistry(reg);
  setSoulData(SoulDataSchema.parse({ mandate: "Default.", ...CLASSES }));
  return block(await new AgentManager().__systemPromptForTests("s", "sam", { channelId: channel }));
}

describe("node mandates from the bundle's text", () => {
  test("Mode: reduce and extend channel blocks", async () => {
    const r = await nodePrompt(SOULS.reduce, "CTEAM01");
    expect(r).toContain("Keep the board tidy.");
    expect(r).toContain("Never page anyone.");
    expect(r).toContain("narrows");
    const e = await nodePrompt(SOULS.extend, "CTEAM01");
    expect(e).toContain("Keep the board tidy.");
    expect(e).toContain("Also triage asks.");
    expect(e).not.toContain("narrows");
  });

  test("a ## Scope dm block applies in a DM", async () => {
    const d = await nodePrompt(SOULS.dm, "D0ALICE");
    expect(d).toContain("No shop talk in private.");
    expect(await nodePrompt(SOULS.dm, "CTEAM01")).toBe("");
  });

  test("trust scopes apply with the classes present", async () => {
    const pub = await nodePrompt(SOULS.publicReduce, "CPUB01", { channelClasses: CLASSES });
    expect(pub).toContain("Quiet in public.");
    expect(pub).toContain("narrows");
    const tr = await nodePrompt(SOULS.trustedOverride, "CTEAM01", { channelClasses: CLASSES });
    expect(tr).toContain("Open up with the team.");
    expect(tr).not.toContain("Keep the board tidy.");
  });

  test("trust scopes without classes warn once per persona and apply nothing", async () => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
    try {
      expect(await nodePrompt(SOULS.publicReduce, "CPUB01")).toBe("");
      expect(await nodePrompt(SOULS.trustedOverride, "CTEAM01")).toBe("");
    } finally {
      spy.mockRestore();
    }
    const w = warns.filter((l) => l.includes("scope") && l.includes("sam"));
    expect(w.length).toBe(1);
    expect(w[0]).toContain("not applied");
  });

  test("a soul text with no trust scope does not warn", async () => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
    try {
      await nodePrompt(SOULS.override, "CTEAM01");
      await nodePrompt(SOULS.dm, "D0ALICE");
    } finally {
      spy.mockRestore();
    }
    expect(warns.filter((l) => l.includes("scope"))).toEqual([]);
  });

  test("a structured soulJson wins over the bundle's text", async () => {
    const soulJson = { mandate: "G", channelOverrides: [{ channel: "CTEAM01", mandate: "FROM-JSON", approvers: [] }] };
    const out = await nodePrompt(SOULS.override, "CTEAM01", { soulJson });
    expect(out).toContain("FROM-JSON");
    expect(out).not.toContain("Only triage asks.");
  });

  test("no resolver (mono, gateway): personaMandateText on the registry's text", async () => {
    for (const role of ["mono", "gateway"] as const) {
      const out = await gatewayPrompt(SOULS.override, "CTEAM01", role);
      expect(out).toContain("Only triage asks.");
    }
  });

  test.each(Object.entries(SOULS))("parity with the gateway build: %s", async (_name, md) => {
    for (const ch of ["CTEAM01", "CPUB01", "D0ALICE", "CELSE"]) {
      const gw = await gatewayPrompt(md, ch);
      const node = await nodePrompt(md, ch, { channelClasses: CLASSES });
      expect(node).toBe(gw);
    }
  });
});

describe("the bundle carries the channel lists for a persona without a structured soul", () => {
  test("added when soulJson is null, from the default soul's lists; absent otherwise", () => {
    setSoulData(SoulDataSchema.parse({ ...CLASSES }));
    process.env.SLAUDE_ROLE = "gateway";
    const b = { personaId: "sam", soulMd: "x", soulJson: null } as never;
    expect((bundleWithChannelClasses(b) as { channelClasses?: unknown }).channelClasses).toEqual(CLASSES);
    const withJson = { personaId: "sam", soulMd: "x", soulJson: { a: 1 } } as never;
    expect("channelClasses" in (bundleWithChannelClasses(withJson) as object)).toBe(false);
  });

  test("the ETag changes when a list changes (a /soul trust add)", () => {
    setSoulData(SoulDataSchema.parse({ ...CLASSES }));
    const a = bundleEtagForTests(JSON.stringify(bundleWithChannelClasses({ personaId: "sam", soulMd: "x", soulJson: null } as never)));
    setSoulData(SoulDataSchema.parse({ trustedChannels: ["CTEAM01", "CNEW01"], allowedChannels: ["CPUB01"] }));
    const b = bundleEtagForTests(JSON.stringify(bundleWithChannelClasses({ personaId: "sam", soulMd: "x", soulJson: null } as never)));
    expect(a).not.toBe(b);
  });
});

describe("a malformed channelClasses cannot break a session boot", () => {
  const MALFORMED: Array<[string, unknown]> = [
    ["empty object", {}],
    ["null member", { trustedChannels: null, allowedChannels: [] }],
    ["string", "x"],
    ["array", []],
    ["string member", { trustedChannels: "CTEAM01", allowedChannels: [] }],
    ["number", 7],
  ];
  test.each(MALFORMED)("%s: no throw, no trust scope applied, one warning", async (_n, bad) => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
    try {
      expect(await nodePrompt(SOULS.trustedOverride, "CTEAM01", { channelClasses: bad })).toBe("");
      expect(await nodePrompt(SOULS.override, "CTEAM01", { channelClasses: bad })).toContain("Only triage asks.");
    } finally {
      spy.mockRestore();
    }
    expect(warns.filter((l) => l.includes("scope restrictions are not applied")).length).toBe(1);
  });

  test("non-string entries are dropped, strings kept", () => {
    expect(normalizeChannelClasses({ trustedChannels: ["CA", 5, null], allowedChannels: ["CB"] })).toEqual({ trustedChannels: ["CA"], allowedChannels: ["CB"] });
    expect(normalizeChannelClasses({ trustedChannels: "CA", allowedChannels: [] })).toBeUndefined();
  });

  test("mandateContext and mandateTextFromSoulText never throw on non-array lists", () => {
    expect(mandateContext({ trustedChannels: null, allowedChannels: "x" } as never, "CA").trust).toBeNull();
    expect(() => mandateTextFromSoulText(SOULS.publicReduce, {} as never)).not.toThrow();
    expect(() => mandateTextFromSoulText(SOULS.publicReduce, "x" as never)).not.toThrow();
  });

  test("a channel in both lists is trusted (trusted wins), on the node and the gateway", async () => {
    const both = { trustedChannels: ["CBOTH01"], allowedChannels: ["CBOTH01"] };
    const md = `${head}## Scope public\n### Mandate\nPublic text.\n\n## Scope trusted\n### Mandate\nTrusted text.\n`;
    const node = await nodePrompt(md, "CBOTH01", { channelClasses: both });
    expect(node).toContain("Trusted text.");
    expect(node).not.toContain("Public text.");
  });

  test("the warning is keyed by tenant and persona", async () => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
    try {
      await nodePrompt(SOULS.publicReduce, "CPUB01", { tenantId: "t1" });
      await nodePrompt(SOULS.publicReduce, "CPUB01", { tenantId: "t1" });
      await nodePrompt(SOULS.publicReduce, "CPUB01", { tenantId: "t2" });
    } finally {
      spy.mockRestore();
    }
    expect(warns.filter((l) => l.includes("scope restrictions are not applied")).length).toBe(2);
  });

  test("a gateway that could not read the lists says so: the node does not warn, the gateway does", async () => {
    const node: string[] = [];
    const nspy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { node.push(a.map(String).join(" ")); });
    try {
      expect(await nodePrompt(SOULS.publicReduce, "CPUB01", { channelClasses: null })).toBe("");
    } finally {
      nspy.mockRestore();
    }
    expect(node.filter((l) => l.includes("scope restrictions"))).toEqual([]);

    const gw: string[] = [];
    const gspy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { gw.push(a.map(String).join(" ")); });
    const boom = spyOn(PerPersona, "soulDataFor").mockImplementation(() => { throw new Error("boom"); });
    try {
      const out = bundleWithChannelClasses({ personaId: "sam", tenantId: "t1", soulMd: "x", soulJson: null } as never) as { channelClasses?: unknown };
      expect(out.channelClasses).toBeNull();
    } finally {
      boom.mockRestore();
      gspy.mockRestore();
    }
    expect(gw.some((l) => l.includes("sam") && l.includes("channel lists"))).toBe(true);
  });

  test("a compiled (agent.yaml) soul is not given default lists", () => {
    const b = bundleWithChannelClasses({ personaId: "ana", soulMd: "x", soulJson: { mandate: "m" }, definition: {} } as never);
    expect("channelClasses" in b).toBe(false);
  });
});
