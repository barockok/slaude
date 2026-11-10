/**
 * The runtime bundle of a persona without a structured soul carries the
 * gateway's channel lists, and its ETag follows them.
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
  test("present for a null-soulJson persona; 304 on the same etag; 200 with new lists after a change", async () => {
    setSoulData(SoulDataSchema.parse({ trustedChannels: ["CTEAM01"], allowedChannels: ["CPUB01"] }));
    const first = await get("plain");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { soulJson: unknown; channelClasses?: unknown };
    expect(body.soulJson).toBeNull();
    expect(body.channelClasses).toEqual({ trustedChannels: ["CTEAM01"], allowedChannels: ["CPUB01"] });
    const etag = first.headers.get("etag")!;
    expect((await get("plain", etag)).status).toBe(304);

    setSoulData(SoulDataSchema.parse({ trustedChannels: ["CTEAM01", "CNEW01"], allowedChannels: ["CPUB01"] }));
    const again = await get("plain", etag);
    expect(again.status).toBe(200);
    expect(again.headers.get("etag")).not.toBe(etag);
    expect(((await again.json()) as { channelClasses: unknown }).channelClasses).toEqual({ trustedChannels: ["CTEAM01", "CNEW01"], allowedChannels: ["CPUB01"] });
  });

  test("the default persona's bundle has a structured soul and no separate lists", async () => {
    const body = (await (await get("default")).json()) as { soulJson: unknown; channelClasses?: unknown };
    expect(body.soulJson).not.toBeNull();
    expect(body.channelClasses).toBeUndefined();
  });
});
