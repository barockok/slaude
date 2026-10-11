/**
 * On a node every session gets its own config directory under a pod-local
 * root, never on the shared volume. Two reasons, both measured: the agent's
 * credential write renames over the path, so a shared credentials file is
 * silently un-shared the first time it is written; and on a node the
 * credentials come only from the gateway, so nothing on the shared volume
 * should be able to supply one.
 *
 * Only credentials move. Settings and plugins are seeded from the persona's
 * home, and transcripts stay on the shared volume through the projects/
 * symlink, so a resumed session finds its history on any node.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfigRoot, sessionConfigDir } from "../../src/agent/config-root";
import { agentConfigDir, personaConfigDir } from "../../src/agent/oauth-home";
import { paths } from "../../src/config/home";

let root: string;
const saved = { role: process.env.SLAUDE_ROLE, root: process.env.SLAUDE_NODE_CONFIG_ROOT };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pod-local-"));
  process.env.SLAUDE_ROLE = "node";
  process.env.SLAUDE_NODE_CONFIG_ROOT = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["SLAUDE_ROLE", saved.role], ["SLAUDE_NODE_CONFIG_ROOT", saved.root]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("nodeConfigRoot", () => {
  test("an explicit root wins", () => {
    expect(nodeConfigRoot()).toBe(root);
  });

  test("the node role defaults to /config-home", () => {
    delete process.env.SLAUDE_NODE_CONFIG_ROOT;
    expect(nodeConfigRoot()).toBe("/config-home");
  });

  test("mono and gateway have no pod-local root", () => {
    delete process.env.SLAUDE_NODE_CONFIG_ROOT;
    process.env.SLAUDE_ROLE = "mono";
    expect(nodeConfigRoot()).toBeNull();
    process.env.SLAUDE_ROLE = "gateway";
    expect(nodeConfigRoot()).toBeNull();
  });
});

describe("sessionConfigDir", () => {
  test("a session's directory is under the pod-local root, not the shared volume", () => {
    const dir = sessionConfigDir("sess-1", "ana");
    expect(dir.startsWith(root)).toBe(true);
    expect(dir.startsWith(paths.home)).toBe(false);
  });

  test("two sessions on one node never share a directory", () => {
    expect(sessionConfigDir("sess-1")).not.toBe(sessionConfigDir("sess-2"));
  });

  test("the directory is private to the node's own user", () => {
    const dir = sessionConfigDir("sess-1");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("an existing, looser directory is tightened", () => {
    const dir = join(root, "sessions", "sess-loose");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    sessionConfigDir("sess-loose");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("transcripts resolve onto the shared volume, in the persona's own tree", () => {
    const dir = sessionConfigDir("sess-1", "ana");
    const link = join(dir, "projects");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(personaConfigDir("ana"), "projects"));
  });

  test("the default persona's transcripts resolve into the agent's own tree", () => {
    const dir = sessionConfigDir("sess-1");
    expect(readlinkSync(join(dir, "projects"))).toBe(join(agentConfigDir(), "projects"));
  });

  // Found while wiring the manifests: nodes run with no CLAUDE_CONFIG_DIR, so
  // the agent's own home resolved to ~/.claude on the pod's filesystem. The
  // default persona's transcripts therefore never reached the shared volume,
  // and a session resumed on another node started cold. The base must be the
  // shared home under SLAUDE_HOME.
  test("with no CLAUDE_CONFIG_DIR, the default persona's transcripts still land on the shared volume", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const dir = sessionConfigDir("sess-shared");
      expect(readlinkSync(join(dir, "projects"))).toBe(join(paths.claudeConfig, "projects"));
      expect(join(paths.claudeConfig, "projects").startsWith(paths.home)).toBe(true);
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  test("settings are seeded from the persona's home", () => {
    mkdirSync(personaConfigDir("ana"), { recursive: true });
    writeFileSync(join(personaConfigDir("ana"), "settings.json"), '{"x":1}');
    const dir = sessionConfigDir("sess-1", "ana");
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe('{"x":1}');
  });

  // On a node the gateway is the only source of credentials. A credentials
  // file left in a persona home by an older version must not shadow it.
  test("a credentials file in the persona's home is never copied in", () => {
    mkdirSync(personaConfigDir("ana"), { recursive: true });
    writeFileSync(join(personaConfigDir("ana"), ".credentials.json"), '{"mcpOAuth":{"k":{"accessToken":"on-disk"}}}');
    const dir = sessionConfigDir("sess-1", "ana");
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });

  test("calling it again for the same session is stable and harmless", () => {
    const a = sessionConfigDir("sess-1", "ana");
    const b = sessionConfigDir("sess-1", "ana");
    expect(a).toBe(b);
    expect(lstatSync(join(b, "projects")).isSymbolicLink()).toBe(true);
  });

  // The session id reaches a filesystem path. It comes from our own database,
  // but a path is the wrong place to discover that assumption was wrong.
  test("a session id that could escape the root is refused", () => {
    for (const bad of ["../x", "a/b", "..", "", "a\\b", "a\u0000b"]) {
      expect(() => sessionConfigDir(bad)).toThrow();
    }
  });

  test("outside the node role there is no pod-local directory to make", () => {
    process.env.SLAUDE_ROLE = "mono";
    delete process.env.SLAUDE_NODE_CONFIG_ROOT;
    expect(() => sessionConfigDir("sess-1")).toThrow();
  });
});
