import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeReload } from "../../src/gateway/core/reload-route";

type Remote = (id: string, prompt?: string) => Promise<void>;

describe("routeReload", () => {
  afterEach(() => spyOn(console, "error").mockRestore());

  test("a session live in this process is reloaded here and nothing is published", () => {
    const remoteCalls: unknown[][] = [];
    const remote: Remote = async (...a) => void remoteCalls.push(a);
    const localCalls: unknown[][] = [];
    const local = (...a: [string, string?]) => (localCalls.push(a), true);
    expect(routeReload(local, remote, "s1", "p")).toBe(true);
    expect(localCalls).toEqual([["s1", "p"]]);
    expect(remoteCalls).toEqual([]);
  });

  test("a session not live here is published for its node and reported as requested", () => {
    const remoteCalls: unknown[][] = [];
    const remote: Remote = async (...a) => void remoteCalls.push(a);
    expect(routeReload(() => false, remote, "s2", "carry on")).toBe(true);
    expect(remoteCalls).toEqual([["s2", "carry on"]]);
    expect(routeReload(() => false, remote, "s3")).toBe(true);
    expect(remoteCalls[1]).toEqual(["s3", undefined]);
  });

  test("without a node queue, a session not live here is reported not live", () => {
    expect(routeReload(() => false, null, "s4")).toBe(false);
  });

  test("a failed publish is logged once and the request still reports as made", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const remote: Remote = async () => {
      throw new Error("redis down");
    };
    expect(routeReload(() => false, remote, "s5")).toBe(true);
    await Bun.sleep(10);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("s5");
    expect(String(err.mock.calls[0]?.[0])).toContain("redis down");
  });
});

describe("gateway reload wiring", () => {
  test("every reload in gateway.ts goes through the routing helper, never straight to the local manager", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/gateway/core/gateway.ts"), "utf8");
    const direct = src.split("\n").filter((l) => l.includes("agent.reload(") && !l.includes("routeReload("));
    // The helper's own line is the only place the local manager is called, and it is inside routeReload's arguments.
    expect(direct).toEqual([]);
    expect(src).toContain("routeReload(");
  });
});
