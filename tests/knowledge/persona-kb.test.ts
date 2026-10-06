/**
 * Per-persona knowledge scope helpers (WS-C §4.1.2) and the in-process side:
 * kb_think's synthesis scope and its gather fan-out see only the persona's
 * kb-* sources, and the in-process slaude_kb server lists only its KBs.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, paths } from "../../src/config/home";
import { clearKbCache } from "../../src/knowledge/loader";
import { personaKbList, personaKbs, personaKbSourceIds, installedKbSourceIds } from "../../src/knowledge/persona-kb";
import { brainHandlers, createKbMcp, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { resolveBrainScope, type BrainScope } from "../../src/knowledge/scope";

beforeEach(() => {
  ensureHome();
  if (existsSync(paths.knowledge)) rmSync(paths.knowledge, { recursive: true, force: true });
  for (const label of ["finance", "runbook"]) {
    mkdirSync(join(paths.knowledge, label), { recursive: true });
    writeFileSync(join(paths.knowledge, label, "README.md"), `# ${label}\n`);
  }
  clearKbCache();
});

const registry = (managed: boolean, kb: Record<string, string[] | null>) =>
  ({
    lookupByName: (n: string) => (n in kb ? { name: n, kbSources: kb[n] } : null),
    isManaged: () => managed,
    defaultPersona: () => ({ model: null, mcp: null, kbSources: kb.default ?? null }),
  }) as any;

describe("persona KB list semantics", () => {
  const reg = registry(true, { finance: ["kb-finance", "kb-unknown"], closed: [], open: null, default: null });
  test("absent/null = every installed KB", () => {
    expect(personaKbSourceIds("open", reg)).toEqual(installedKbSourceIds());
    expect(personaKbSourceIds(undefined, reg).sort()).toEqual(["kb-finance", "kb-runbook"]);
  });
  test("[] = none", () => {
    expect(personaKbSourceIds("closed", reg)).toEqual([]);
    expect(personaKbs("closed", reg)).toEqual([]);
  });
  test("a list = only those, intersected with what is installed (an unknown id reads nothing)", () => {
    expect(personaKbSourceIds("finance", reg)).toEqual(["kb-finance"]);
    expect(personaKbList("finance", reg)).toEqual(["kb-finance", "kb-unknown"]);
  });
  test("a filesystem registry reads every installed KB", () => {
    expect(personaKbSourceIds("finance", registry(false, { finance: [] })).sort()).toEqual(["kb-finance", "kb-runbook"]);
  });
});

describe("kb_think with a persona's scope", () => {
  test("synthesis and the gather cross-check read only the persona's kb-* sources", async () => {
    const reg = registry(true, { finance: ["kb-finance"] });
    let thinkScope: BrainScope | null = null;
    const searched: string[] = [];
    const deps: BrainToolDeps = {
      scope: () => resolveBrainScope({
        userId: null, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "U0FIN",
        kbSources: personaKbSourceIds("finance", reg),
      }),
      gate: () => ({ userId: null, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "U0FIN" }),
      managers: () => [],
      requestApproval: async () => ({ approved: false }) as any,
      think: async (_q, scope) => {
        thinkScope = scope;
        return { answer: "a", citations: [] };
      },
      call: async (name, _p, scope) => {
        if (name === "search") searched.push(scope.sourceId);
        return [];
      },
    };
    await brainHandlers.kb_think({ question: "what is the budget" }, deps);
    expect(thinkScope!.allowedSources.filter((s) => s.startsWith("kb-"))).toEqual(["kb-finance"]);
    expect(searched.filter((s) => s.startsWith("kb-"))).toEqual(["kb-finance"]);
  });
});

describe("in-process slaude_kb", () => {
  async function callTool(cfg: any, name: string, args: Record<string, unknown>) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await cfg.instance.connect(serverT);
    const client = new Client({ name: "t", version: "0.0.0" });
    await client.connect(clientT);
    try {
      return (await client.callTool({ name, arguments: args })) as any;
    } finally {
      await client.close();
    }
  }

  test("list_kbs and search_kbs use the persona's list, resolved per call", async () => {
    let allowed = ["kb-finance"];
    const reg = () => registry(true, { finance: allowed });
    const cfg = createKbMcp(undefined, { kbs: () => personaKbs("finance", reg()) });
    const list = JSON.parse((await callTool(cfg, "list_kbs", {})).content[0].text);
    expect(list.map((k: any) => k.label)).toEqual(["finance"]);
    allowed = [];
    expect((await callTool(createKbMcp(undefined, { kbs: () => personaKbs("finance", reg()) }), "search_kbs", { query: "runbook" })).content[0].text)
      .toBe("(no knowledge bases available)");
  });
});
