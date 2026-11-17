/**
 * The runtime bundle carries the structure, not the gateway's channel lists as a
 * separate field: a node reads no soul text, so there is nothing to place by them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bundle-classes-"));
const savedHome = process.env.SLAUDE_HOME;
process.env.SLAUDE_HOME = home;
const { paths } = await import("../../../src/config/home");
const { __resetPersonaRegistry } = await import("../../../src/persona/registry");
const { handleTenantRuntime } = await import("../../../src/gateway/api/tenants");
const { setSoulData, __resetSoulDataMemo } = await import("../../../src/soul/extract");
const { SoulDataSchema } = await import("../../../src/soul/data");

beforeAll(() => {
  mkdirSync(join(paths.personas, "plain"), { recursive: true });
  writeFileSync(join(paths.personas, "plain", "config.json"), JSON.stringify({ slackUserId: "UPLAIN", name: "plain" }));
  writeFileSync(join(paths.personas, "plain", "SOUL.md"), "# Plain\n## Mandate\nDo it.\n");
  __resetPersonaRegistry();
});
afterAll(() => {
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  if (savedHome === undefined) delete process.env.SLAUDE_HOME;
  else process.env.SLAUDE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const get = (persona: string, inm?: string) =>
  handleTenantRuntime(new Request("http://gw/x", { headers: inm ? { "if-none-match": inm } : {} }), "default", persona);

describe("runtime bundle channel lists", () => {
  test("the default persona's bundle has a structured soul and no separate lists", async () => {
    const body = (await (await get("default")).json()) as { soulJson: unknown; channelClasses?: unknown };
    expect(body.soulJson).not.toBeNull();
    expect(body.channelClasses).toBeUndefined();
  });

  test("a persona with no structure ships none, and no channel lists either", async () => {
    setSoulData(SoulDataSchema.parse({ trustedChannels: ["CTEAM01"] }));
    const body = (await (await get("plain")).json()) as { soulJson: unknown; channelClasses?: unknown };
    expect(body.soulJson).toBeNull();
    expect(body.channelClasses).toBeUndefined();
  });
});
