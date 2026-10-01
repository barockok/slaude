/**
 * publishReload had a live subscriber on every node and no publisher in src/,
 * so a config change reached other processes only by accident of ETag timing
 * and reached the publishing gateway not at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { publishConfigReload } from "../../src/gateway/core/config-reload";
import {
  getPersonaRegistry,
  setPersonaRegistry,
  invalidatePersonaRegistry,
  whenPersonaRegistrySettled,
  __resetPersonaRegistry,
  type PersonaRegistry,
} from "../../src/persona/registry";

const stub = (): PersonaRegistry => ({
  lookupByUserId: () => null,
  lookupByName: () => null,
  list: () => [],
  isMultiPersonaMode: () => false,
  isManaged: () => false,
  tombstonedPersonaFor: () => null,
});

afterEach(async () => {
  await whenPersonaRegistrySettled();
  __resetPersonaRegistry();
});

describe("persona registry invalidation", () => {
  // The snapshot keeps serving while the rebuild runs: dropping it would let
  // the next access lazily rebuild from disk, whatever the tenant's source.
  test("a set registry keeps serving until the rebuild an invalidation starts replaces it", async () => {
    const r = stub();
    setPersonaRegistry(r);
    expect(getPersonaRegistry()).toBe(r);

    invalidatePersonaRegistry();
    expect(getPersonaRegistry()).toBe(r);

    await whenPersonaRegistrySettled();
    expect(getPersonaRegistry()).not.toBe(r);
  });
});

describe("publishConfigReload", () => {
  test("invalidates locally and publishes on the tenant channel", async () => {
    const r = stub();
    setPersonaRegistry(r);
    const seen: string[] = [];

    const res = await publishConfigReload(
      { publishReload: async (t: string) => { seen.push(t); return 3; } } as any,
      "tenant-one",
    );

    expect(seen).toEqual(["tenant-one"]);
    expect(res.notified).toBe(3);
    await whenPersonaRegistrySettled();
    expect(getPersonaRegistry()).not.toBe(r);
  });

  test("still invalidates locally when there is no pub/sub", async () => {
    const r = stub();
    setPersonaRegistry(r);

    const res = await publishConfigReload(null, "default");

    expect(res.notified).toBeNull();
    await whenPersonaRegistrySettled();
    expect(getPersonaRegistry()).not.toBe(r);
  });

  // A Redis blip must not fail the config write that triggered the announcement:
  // the local invalidation already happened and ETag revalidation still converges.
  test("a failed publish is reported, not thrown", async () => {
    const r = stub();
    setPersonaRegistry(r);

    const res = await publishConfigReload(
      { publishReload: async () => { throw new Error("redis down"); } } as any,
      "default",
    );

    expect(res.notified).toBeNull();
    expect(res.error).toContain("redis down");
    await whenPersonaRegistrySettled();
    expect(getPersonaRegistry()).not.toBe(r);
  });
});
