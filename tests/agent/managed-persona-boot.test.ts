// R40-I4: in the no-resolver path (mono, gateway) a session whose persona is not
// live in a MANAGED registry must fail its boot. Falling back would run it with
// the default persona's soul, credentials and brain slice.
import { afterEach, describe, expect, test } from "bun:test";
import { AgentManager } from "../../src/agent/manager";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";

const registry = (managed: boolean): PersonaRegistry => ({
  lookupByUserId: () => null,
  lookupByName: () => null,
  list: () => [],
  isMultiPersonaMode: () => false,
  isManaged: () => managed,
  tombstonedPersonaFor: () => null,
});

afterEach(() => __resetPersonaRegistry());

describe("booting a session for a persona that is not live", () => {
  test("a managed registry without the persona fails the boot, naming the persona", async () => {
    setPersonaRegistry(registry(true));
    await expect(new AgentManager().__systemPromptForTests("s-1", "ana")).rejects.toThrow(/ana/);
  });

  test("the default persona still boots on a managed registry", async () => {
    setPersonaRegistry(registry(true));
    expect(await new AgentManager().__systemPromptForTests("s-1", "default")).toContain("<persona>");
    expect(await new AgentManager().__systemPromptForTests("s-2", undefined)).toContain("<persona>");
  });

  test("an unmanaged (filesystem) registry keeps today's behaviour", async () => {
    setPersonaRegistry(registry(false));
    expect(await new AgentManager().__systemPromptForTests("s-1", "ana")).toContain("<persona>");
  });
});
