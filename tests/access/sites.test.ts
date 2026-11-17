import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SITES, sitesOfGroup } from "../../src/access/sites";

const gateway = readFileSync("src/gateway/core/gateway.ts", "utf8");
const count = (needle: string) => gateway.split(needle).length - 1;

describe("site registry", () => {
  test("ids are unique and well formed", () => {
    const ids = SITES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });

  test("every task 13 site is wired exactly once in gateway.ts", () => {
    for (const id of sitesOfGroup(13)) expect({ id, uses: count(`"${id}"`) }).toEqual({ id, uses: 1 });
  });

  test("gateway.ts names no site the registry lacks", () => {
    const used = [...gateway.matchAll(/(?:site: |managerAt\()"(gateway\.[a-z_.]+)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThanOrEqual(sitesOfGroup(13).length);
    const known = new Set<string>(SITES.map((s) => s.id));
    expect(used.filter((u) => !known.has(u))).toEqual([]);
  });

  test("the legacy readers are no longer called directly for task 13 sites", () => {
    expect(gateway).not.toMatch(/\badmit\(\{/);
    expect(gateway).not.toMatch(/usersWithRole\(/);
  });
});
