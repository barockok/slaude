import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { paths } from "../../src/config/home";
import { personaKey, scopeConfigDir } from "../../src/agent/mcp-oauth/scope-home";
import { agentConfigDir } from "../../src/agent/oauth-home";

const USER = "UTESTUSER1";

describe("personaKey", () => {
  test("a named persona is its own key", () => {
    expect(personaKey("aria")).toBe("aria");
  });

  test("the implicit default persona has no key", () => {
    expect(personaKey("default")).toBeUndefined();
    expect(personaKey(undefined)).toBeUndefined();
    expect(personaKey(null)).toBeUndefined();
    expect(personaKey("")).toBeUndefined();
  });
});

describe("scopeConfigDir", () => {
  test("global scope is the agent's own config home, persona or not", () => {
    expect(scopeConfigDir("global", USER)).toBe(agentConfigDir());
    expect(scopeConfigDir("global", USER, "aria")).toBe(agentConfigDir());
  });

  test("initiator scope under a named persona nests the user beneath it", () => {
    const dir = scopeConfigDir("initiator", USER, "aria");
    expect(dir).toBe(join(paths.home, "oauth", "aria", USER));
    expect(existsSync(dir)).toBe(true);
  });

  test("initiator scope under the default persona is the flat user home", () => {
    expect(scopeConfigDir("initiator", USER, "default")).toBe(join(paths.home, "oauth", USER));
    expect(scopeConfigDir("initiator", USER)).toBe(join(paths.home, "oauth", USER));
  });

  // The regression this module exists to prevent: connect nested the home under
  // the persona while disconnect did not, so disconnect searched an empty
  // directory, reported nothing was connected, and left a live token behind.
  test("connect and disconnect resolve the same home for the same session", () => {
    const personaId = "aria";
    const onConnect = scopeConfigDir("initiator", USER, personaId);
    const onDisconnect = scopeConfigDir("initiator", USER, personaId);
    expect(onDisconnect).toBe(onConnect);
  });

  test("a named persona's home is never the flat user home", () => {
    expect(scopeConfigDir("initiator", USER, "aria")).not.toBe(scopeConfigDir("initiator", USER));
  });
});
