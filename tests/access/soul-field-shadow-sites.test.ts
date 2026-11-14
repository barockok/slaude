/**
 * Slice C task 15: the soul-field readers (model, ingest, soul overrides and
 * the manager compares around them) go through the shadow seam and keep the
 * legacy answer under every source mode and a broken resolver or engine.
 */
import { describe, expect, test } from "bun:test";
import { __setGrantsReader } from "../../src/access/role";
import { settleShadows } from "../../src/access/wired";
import * as SO from "../../src/db/soul-overrides";
import { surfaceTools } from "../../src/gateway/core/surface-mcp";
import type { Surface } from "../../src/gateway/core/surface";
import { isManagerOrApprover } from "../../src/gateway/slack/mcp-tools";
import { canTriggerIngest } from "../../src/gateway/slack/ingest-auth";
import { canChangeModel } from "../../src/gateway/slack/model-auth";
import { SoulDataSchema } from "../../src/soul/data";
import { setSoulData } from "../../src/soul/extract";
import { mutateOverride } from "../../src/soul/overrides";
import { compared, decisions, legacyUnderEveryMode, useShadowEnv } from "../helpers/shadow-modes";

const TEAM = "T0EXAMPLE";
const soul = SoulDataSchema.parse({
  manager: { userId: "U0MGR" },
  backupManager: { userId: "U0BAK" },
  approvers: [{ userId: "U0APP", scope: "anything", catchall: true }],
  dmAllowedUsers: ["U0DM"],
});
const WHO = ["U0MGR", "U0BAK", "U0APP", "U0DM", "U0NOBODY"];

useShadowEnv({
  before: async () => {
    __setGrantsReader(async () => []);
    setSoulData(soul);
    await SO.clear();
  },
  after: async () => {
    __setGrantsReader(null);
    await SO.clear();
  },
});

describe("model and ingest readers", () => {
  const model = async () => Object.fromEntries(WHO.map((u) => [u, canChangeModel(u, soul, { persona: "default", teamId: TEAM })]));
  const ingest = async () => Object.fromEntries(WHO.map((u) => [u, canTriggerIngest(u, soul, { persona: "default", teamId: TEAM })]));
  legacyUnderEveryMode("canChangeModel", model, { U0MGR: true, U0BAK: true, U0APP: true, U0DM: true, U0NOBODY: false });
  legacyUnderEveryMode("canTriggerIngest", ingest, { U0MGR: true, U0BAK: true, U0APP: true, U0DM: false, U0NOBODY: false });

  test("both count decisions and compare in shadow; the soul alone agrees with the engine", async () => {
    await model();
    await ingest();
    await settleShadows();
    for (const site of ["model_auth.can_change", "ingest_auth.can_trigger"]) {
      expect(decisions(site)).toBe(WHO.length);
      expect(compared(site)).toBe(WHO.length);
    }
  });

  test("without a workspace the legacy answer stands and nothing is compared", async () => {
    expect(canChangeModel("U0DM", soul)).toBe(true);
    expect(canTriggerIngest("U0DM", soul)).toBe(false);
    await settleShadows();
    expect(compared("model_auth.can_change") + compared("ingest_auth.can_trigger")).toBe(0);
  });
});

describe("override self-lockout guard", () => {
  const scenario = async () => {
    const own = await mutateOverride({ field: "block", action: "add", value: "U0MGR", by: "U0MGR" }, { managerId: "U0MGR", teamId: TEAM });
    const other = await mutateOverride({ field: "block", action: "add", value: "U0OTHER", by: "U0MGR" }, { managerId: "U0MGR", teamId: TEAM });
    const noTeam = await mutateOverride({ field: "block", action: "add", value: "U0MGR", by: "U0MGR" }, { managerId: "U0MGR" });
    await SO.clear();
    return [own.ok, other.ok, noTeam.ok];
  };
  legacyUnderEveryMode("blocking the manager is refused, another user is not", scenario, [false, true, false]);

  test("counts the compare", async () => {
    await scenario();
    await settleShadows();
    expect(decisions("soul_override.self_lockout")).toBe(3);
  });
});

describe("soul_override tool", () => {
  const surface: Surface = {
    id: "fake",
    capabilities: new Set() as any,
    reply: async () => ({ ref: "r" }),
    getHistory: async () => ({ messages: [], hasMore: false }),
    requestApproval: async () => ({ approved: true, by: "U0MGR" }),
  };
  const scenario = async () => {
    const out: Record<string, boolean> = {};
    for (const who of ["U0MGR", "U0BAK", "U0NOBODY"]) {
      const def = surfaceTools(surface, { initiator: () => who, teamId: () => TEAM, auditContext: () => ({ persona: "default" }) as any }).find((d) => d.name === "soul_override")!;
      const r: any = await def.handler({ field: "trust", action: "add", value: "C0EXAMPLE" });
      out[who] = !r.isError;
      await SO.clear();
    }
    return out;
  };
  legacyUnderEveryMode("only the primary manager passes", scenario, { U0MGR: true, U0BAK: false, U0NOBODY: false });

  test("counts the manager compare", async () => {
    await scenario();
    await settleShadows();
    expect(decisions("soul_override.tool_manager_same")).toBe(3);
  });
});

describe("isManagerOrApprover", () => {
  const scenario = async () => {
    __setGrantsReader(async () => []);
    const out: Record<string, boolean> = {};
    for (const u of WHO) out[u] = await isManagerOrApprover("default", u, "C0EXAMPLE", TEAM);
    out.noTeam = await isManagerOrApprover("default", "U0MGR", "C0EXAMPLE");
    return out;
  };
  legacyUnderEveryMode("manager and approver yes, others no", scenario, { U0MGR: true, U0BAK: true, U0APP: true, U0DM: false, U0NOBODY: false, noTeam: true });

  test("counts decisions and compares only with a workspace", async () => {
    await scenario();
    await settleShadows();
    expect(decisions("mcp_tools.manager_or_approver")).toBe(WHO.length + 1);
    expect(compared("mcp_tools.manager_or_approver")).toBe(WHO.length);
  });
});
