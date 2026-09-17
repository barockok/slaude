import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEntry, removeEntry, readEntry, type OAuthServerConfig, type OAuthTokens } from "../../src/agent/mcp-oauth/store";

const CFG: OAuthServerConfig = { type: "http", url: "https://mcp.example.com/sse", headers: {} };
const TOKENS = (accessToken: string): OAuthTokens => ({ clientId: "cid", accessToken, expiresIn: 3600 });

/**
 * A shared per-user credential store means the per-persona config dir holds a
 * symlink rather than a regular file. Both writers rename a temp file over the
 * target, and a rename REPLACES a symlink instead of following it — which would
 * silently unshare the credentials on the first write.
 */
function linkedConfigDir(label: string): { configDir: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), `slaude-${label}-`));
  const canonical = join(root, "canonical");
  const configDir = join(root, "config");
  mkdirSync(canonical, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const target = join(canonical, ".credentials.json");
  writeFileSync(target, JSON.stringify({ mcpOAuth: {} }), { mode: 0o600 });
  symlinkSync(target, join(configDir, ".credentials.json"));
  return { configDir, target };
}

describe("credential writes through a symlink", () => {
  test("writeEntry follows the link instead of replacing it", () => {
    const { configDir, target } = linkedConfigDir("write");

    writeEntry(configDir, "workbench", CFG, TOKENS("at"));

    expect(lstatSync(join(configDir, ".credentials.json")).isSymbolicLink()).toBe(true);
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(Object.keys(written.mcpOAuth)).toHaveLength(1);
  });

  test("removeEntry follows the link instead of replacing it", () => {
    const { configDir, target } = linkedConfigDir("remove");
    writeEntry(configDir, "workbench", CFG, TOKENS("at"));

    expect(removeEntry(configDir, "workbench", CFG)).toBe(true);

    expect(lstatSync(join(configDir, ".credentials.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).mcpOAuth).toEqual({});
  });

  test("a write through one link is visible through another link to the same target", () => {
    const { configDir, target } = linkedConfigDir("share");
    const second = mkdtempSync(join(tmpdir(), "slaude-share-second-"));
    symlinkSync(target, join(second, ".credentials.json"));

    writeEntry(configDir, "workbench", CFG, TOKENS("shared-token"));

    expect(readEntry(second, "workbench", CFG)?.accessToken).toBe("shared-token");
  });

  test("a plain file target still round-trips", () => {
    const configDir = mkdtempSync(join(tmpdir(), "slaude-plain-"));

    writeEntry(configDir, "workbench", CFG, TOKENS("at"));

    expect(readEntry(configDir, "workbench", CFG)?.accessToken).toBe("at");
    expect(lstatSync(join(configDir, ".credentials.json")).isFile()).toBe(true);
  });
});
