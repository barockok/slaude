import { describe, expect, test } from "bun:test";
import { bootPersonaState, type PersonaBootDeps } from "../../src/persona/boot";

function deps(withProvider: string[]) {
  const calls: string[] = [];
  const d: PersonaBootDeps = {
    refresh: async (t) => { calls.push(`refresh:${t}`); },
    withProvider: () => withProvider,
    startRevalidation: (t) => { calls.push(`poll:${t}`); return () => calls.push("stop"); },
    loadFilesystem: () => { calls.push("fs"); },
  };
  return { d, calls };
}

describe("bootPersonaState (server.ts persona boot step)", () => {
  // R1-F4: mono must refuse a stored provider reference at start.
  test("mono with a persona that sets provider refuses to start, naming it", async () => {
    const { d } = deps(["ana"]);
    await expect(bootPersonaState("mono", "pg", d)).rejects.toThrow(/SLAUDE_ROLE=mono.*ana/);
  });

  test("mono without provider references starts and polls on Postgres", async () => {
    const { d, calls } = deps([]);
    const stop = await bootPersonaState("mono", "pg", d);
    expect(calls).toEqual(["refresh:default", "poll:default"]);
    stop?.();
    expect(calls).toContain("stop");
  });

  test("a gateway with provider references starts; sqlite does not poll", async () => {
    const { d, calls } = deps(["ana"]);
    expect(await bootPersonaState("gateway", "sqlite", d)).toBeUndefined();
    expect(calls).toEqual(["refresh:default"]);
  });

  // server.ts runs on import (no seam), so the wiring is guarded at the source.
  test("server.ts runs both provider boot steps", async () => {
    const src = await Bun.file(new URL("../../src/server.ts", import.meta.url)).text();
    expect(src).toContain("await bootPersonaState(env.role(), db.dialect)");
    expect(src).toMatch(/bootProviderSecretResolver\(env\.role\(\), process\.env\)/);
    expect(src).toMatch(/if \(providerResolver\) setProviderSecretResolver\(providerResolver\)/);
  });

  test("a node reads the filesystem only", async () => {
    const { d, calls } = deps(["ana"]);
    expect(await bootPersonaState("node", "pg", d)).toBeUndefined();
    expect(calls).toEqual(["fs"]);
  });
});
