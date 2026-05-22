import { describe, expect, test } from "bun:test";
import {
  detectMarketplaceSource,
  deriveMarketplaceSlug,
  emptyInstalledPlugins,
  mergeInstalledPlugin,
  mergeKnownMarketplace,
  mergeSettings,
  pluginKey,
} from "../src/cli/cc-plugin-metadata";

describe("detectMarketplaceSource", () => {
  test("github: shorthand → github source", () => {
    expect(detectMarketplaceSource("github:anthropics/claude-plugins-official", "main"))
      .toEqual({ source: "github", repo: "anthropics/claude-plugins-official" });
  });

  test("github: shorthand strips .git suffix", () => {
    expect(detectMarketplaceSource("github:owner/repo.git", "main"))
      .toEqual({ source: "github", repo: "owner/repo" });
  });

  test("github.com https URL → github source", () => {
    expect(detectMarketplaceSource("https://github.com/owner/repo.git", "v1"))
      .toEqual({ source: "github", repo: "owner/repo" });
  });

  test("non-github URL → generic git source with ref", () => {
    expect(detectMarketplaceSource("git@bitbucket.org:org/openskill.git", "main"))
      .toEqual({ source: "git", url: "git@bitbucket.org:org/openskill.git", ref: "main" });
  });
});

describe("deriveMarketplaceSlug", () => {
  test("github: shorthand → last segment lowercase", () => {
    expect(deriveMarketplaceSlug("github:anthropics/Claude-Plugins-Official")).toBe("claude-plugins-official");
  });

  test("ssh URL strips .git", () => {
    expect(deriveMarketplaceSlug("git@bitbucket.org:org/openskill.git")).toBe("openskill");
  });

  test("https URL works", () => {
    expect(deriveMarketplaceSlug("https://github.com/owner/My-Repo.git")).toBe("my-repo");
  });
});

describe("mergeKnownMarketplace", () => {
  test("adds entry to empty map", () => {
    const r = mergeKnownMarketplace({}, "openskill", { source: "git", url: "u", ref: "main" }, "/x", "2026-01-01T00:00:00Z");
    expect(r).toEqual({
      openskill: { source: { source: "git", url: "u", ref: "main" }, installLocation: "/x", lastUpdated: "2026-01-01T00:00:00Z" },
    });
  });

  test("preserves other entries", () => {
    const existing = { other: { source: { source: "github", repo: "a/b" } as const, installLocation: "/o", lastUpdated: "old" } };
    const r = mergeKnownMarketplace(existing, "new", { source: "github", repo: "c/d" }, "/n", "now");
    expect(r.other).toEqual(existing.other);
    expect(r.new!.installLocation).toBe("/n");
  });
});

describe("mergeInstalledPlugin", () => {
  test("seeds a new plugin record", () => {
    const r = mergeInstalledPlugin(emptyInstalledPlugins(), "p@m", "/path", "1.0.0", "abc", "2026-01-01T00:00:00Z");
    expect(r.version).toBe(2);
    expect(r.plugins["p@m"]).toEqual([{
      scope: "user",
      installPath: "/path",
      version: "1.0.0",
      installedAt: "2026-01-01T00:00:00Z",
      lastUpdated: "2026-01-01T00:00:00Z",
      gitCommitSha: "abc",
    }]);
  });

  test("preserves installedAt on update; bumps lastUpdated", () => {
    const seed = mergeInstalledPlugin(emptyInstalledPlugins(), "p@m", "/old", "1.0.0", "abc", "2026-01-01T00:00:00Z");
    const r = mergeInstalledPlugin(seed, "p@m", "/new", "1.1.0", "def", "2026-02-02T00:00:00Z");
    expect(r.plugins["p@m"]![0]!.installedAt).toBe("2026-01-01T00:00:00Z");
    expect(r.plugins["p@m"]![0]!.lastUpdated).toBe("2026-02-02T00:00:00Z");
    expect(r.plugins["p@m"]![0]!.installPath).toBe("/new");
    expect(r.plugins["p@m"]![0]!.version).toBe("1.1.0");
    expect(r.plugins["p@m"]![0]!.gitCommitSha).toBe("def");
  });

  test("does not clobber sibling plugins", () => {
    const seed = mergeInstalledPlugin(emptyInstalledPlugins(), "a@m", "/a", "1", "sa", "2026-01-01T00:00:00Z");
    const r = mergeInstalledPlugin(seed, "b@m", "/b", "1", "sb", "2026-01-02T00:00:00Z");
    expect(Object.keys(r.plugins).sort()).toEqual(["a@m", "b@m"]);
  });
});

describe("mergeSettings", () => {
  test("creates enabledPlugins + extraKnownMarketplaces from blank", () => {
    const r = mergeSettings({}, ["p@m"], { m: { source: { source: "git", url: "u", ref: "main" } } });
    expect(r.enabledPlugins).toEqual({ "p@m": true });
    expect(r.extraKnownMarketplaces).toEqual({ m: { source: { source: "git", url: "u", ref: "main" } } });
  });

  test("merges with existing enabledPlugins", () => {
    const r = mergeSettings(
      { enabledPlugins: { existing: true } },
      ["new@m"],
      {},
    );
    expect(r.enabledPlugins).toEqual({ existing: true, "new@m": true });
  });

  test("preserves unrelated keys (permissions, model, hooks, …)", () => {
    const r = mergeSettings(
      { model: "opus", permissions: { allow: ["x"] }, hooks: { foo: 1 } },
      ["p@m"],
      { m: { source: { source: "github", repo: "a/b" } } },
    );
    expect(r.model).toBe("opus");
    expect(r.permissions).toEqual({ allow: ["x"] });
    expect(r.hooks).toEqual({ foo: 1 });
  });

  test("repeated enable is idempotent", () => {
    const r = mergeSettings({ enabledPlugins: { "p@m": true } }, ["p@m"], {});
    expect(r.enabledPlugins).toEqual({ "p@m": true });
  });
});

describe("pluginKey", () => {
  test("formats <plugin>@<marketplace>", () => {
    expect(pluginKey("excalidraw-diagram", "openskill")).toBe("excalidraw-diagram@openskill");
  });
});
