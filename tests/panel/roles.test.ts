import { afterEach, describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseRoleConfig,
  resolveRole,
  loadRoleConfig,
  resolveRoleForIdentity,
  __resetRoleCache,
} from "../../src/gateway/panel/auth/roles";

const dir = mkdtempSync(join(tmpdir(), "slaude-roles-"));
const write = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

afterEach(() => {
  delete process.env.SLAUDE_PANEL_ROLES_FILE;
  delete process.env.SLAUDE_PANEL_SUPERADMIN;
  delete process.env.SLAUDE_PANEL_OPERATORS;
  __resetRoleCache();
});

describe("parseRoleConfig", () => {
  it("parses both lists", () => {
    const cfg = parseRoleConfig("superadmin:\n  - lead@example.com\noperator:\n  - alice@example.com\n");
    expect(cfg.superadmin).toEqual(["lead@example.com"]);
    expect(cfg.operator).toEqual(["alice@example.com"]);
  });

  it("tolerates a missing list", () => {
    expect(parseRoleConfig("superadmin:\n  - lead@example.com\n").operator).toEqual([]);
  });

  it("throws on a non-mapping document", () => {
    expect(() => parseRoleConfig("- just\n- a list\n")).toThrow(/mapping/);
  });

  it("throws when a list holds a non-string", () => {
    expect(() => parseRoleConfig("operator:\n  - 42\n")).toThrow(/string/);
  });
});

describe("resolveRole", () => {
  const cfg = { superadmin: ["Lead@Example.com"], operator: ["alice@example.com"] };

  it("matches case-insensitively", () => {
    expect(resolveRole("lead@EXAMPLE.com", cfg)).toBe("superadmin");
    expect(resolveRole("Alice@example.com", cfg)).toBe("operator");
  });

  it("returns null for an unlisted identity", () => {
    expect(resolveRole("eve@example.com", cfg)).toBeNull();
  });

  it("returns null for an empty identity", () => {
    expect(resolveRole("", cfg)).toBeNull();
  });

  it("prefers superadmin when listed in both", () => {
    expect(resolveRole("both@example.com", {
      superadmin: ["both@example.com"],
      operator: ["both@example.com"],
    })).toBe("superadmin");
  });
});

describe("loadRoleConfig", () => {
  it("reads the configured file", () => {
    process.env.SLAUDE_PANEL_ROLES_FILE = write("ok.yaml", "operator:\n  - alice@example.com\n");
    expect(loadRoleConfig().operator).toEqual(["alice@example.com"]);
  });

  it("falls back to env lists when no file is configured", () => {
    process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
    process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com, bob@example.com";
    const cfg = loadRoleConfig();
    expect(cfg.superadmin).toEqual(["lead@example.com"]);
    expect(cfg.operator).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("throws when the configured file is absent", () => {
    process.env.SLAUDE_PANEL_ROLES_FILE = join(dir, "nope.yaml");
    expect(() => loadRoleConfig()).toThrow(/panel role file/);
  });

  it("throws on malformed YAML with no previously good config", () => {
    process.env.SLAUDE_PANEL_ROLES_FILE = write("bad.yaml", "operator:\n  - [unclosed\n");
    expect(() => loadRoleConfig()).toThrow();
  });

  it("keeps the last good config when the file becomes malformed", () => {
    const p = write("live.yaml", "operator:\n  - alice@example.com\n");
    process.env.SLAUDE_PANEL_ROLES_FILE = p;
    expect(loadRoleConfig().operator).toEqual(["alice@example.com"]);
    writeFileSync(p, "operator:\n  - [unclosed\n");
    expect(loadRoleConfig().operator).toEqual(["alice@example.com"]);
  });

  it("picks up a role change without a restart", () => {
    const p = write("change.yaml", "operator:\n  - alice@example.com\n");
    process.env.SLAUDE_PANEL_ROLES_FILE = p;
    expect(resolveRoleForIdentity("alice@example.com")).toBe("operator");
    writeFileSync(p, "superadmin:\n  - alice@example.com\n");
    expect(resolveRoleForIdentity("alice@example.com")).toBe("superadmin");
  });
});
