/**
 * The runtime bundle of a persona defined by an agent.yaml on disk carries its
 * compiled structure and definition, so a node needs no soul text parse.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paths } from "../../../src/config/home";
import { __resetPersonaRegistry, refreshPersonaState } from "../../../src/persona/registry";
import { handleTenantRuntime } from "../../../src/gateway/api/tenants";
import { __resetSoulDataMemo } from "../../../src/soul/extract";

// paths is read where it is used, so this test points it at its own home and puts it back.
const home = mkdtempSync(join(tmpdir(), "bundle-file-agent-"));
const saved = { home: paths.home, personas: paths.personas, soul: paths.soul };

beforeAll(async () => {
  (paths as { home: string }).home = home;
  (paths as { personas: string }).personas = join(home, "personas");
  (paths as { soul: string }).soul = join(home, "SOUL.md");
  mkdirSync(join(paths.personas, "ana"), { recursive: true });
  writeFileSync(
    join(paths.personas, "ana", "agent.yaml"),
    "name: ana\nslackUserId: slack:user:U0ANA\nsoul: |\n  You are Ana.\naccess:\n  manager: slack:user:U0BOSS\nskills: [triage]\n",
  );
  writeFileSync(
    join(home, "agent.yaml"),
    "name: default\nsoul: |\n  You are the default.\naccess:\n  manager: slack:user:U0BOSS\nskills: [release-notes]\nguardrails: [no-outbound]\n",
  );
  __resetPersonaRegistry();
  await refreshPersonaState("default");
});
afterAll(() => {
  (paths as { home: string }).home = saved.home;
  (paths as { personas: string }).personas = saved.personas;
  (paths as { soul: string }).soul = saved.soul;
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  rmSync(home, { recursive: true, force: true });
});

const get = (persona: string) =>
  handleTenantRuntime(new Request("http://gw/x", { headers: { "x-slaude-capabilities": "agent-definition/1, guardrails/1" } }), "default", persona);

type Body = { soulMd: string; soulJson: { manager: { userId: string } } | null; definition?: { skills?: string[]; guardrails?: string[] }; channelClasses?: unknown };

describe("runtime bundle of a persona defined by agent.yaml on disk", () => {
  test("a named persona ships its text, structure and skills", async () => {
    const res = await get("ana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.soulMd).toContain("You are Ana.");
    expect(body.soulJson?.manager.userId).toBe("U0BOSS");
    expect(body.definition).toEqual({ skills: ["triage"] });
    expect(body.channelClasses).toBeUndefined();
  });

  test("the default ships the compiled soul text and its definition", async () => {
    const body = (await (await get("default")).json()) as Body;
    expect(body.soulMd).toContain("You are the default.");
    expect(body.soulJson?.manager.userId).toBe("U0BOSS");
    expect(body.definition).toEqual({ skills: ["release-notes"], guardrails: ["no-outbound"] });
  });
});
