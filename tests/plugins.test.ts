import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/home";
import { loadInstalledPluginPaths } from "../src/config/plugins";

const pluginsDir = join(paths.claudeConfig, "plugins");
const pluginsFile = join(pluginsDir, "installed_plugins.json");

function writeInstalled(json: unknown) {
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(pluginsFile, JSON.stringify(json));
}

beforeEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

describe("loadInstalledPluginPaths", () => {
  test("missing file → empty", () => {
    expect(loadInstalledPluginPaths()).toEqual([]);
  });

  test("malformed JSON → empty", () => {
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(pluginsFile, "{not json");
    expect(loadInstalledPluginPaths()).toEqual([]);
  });

  test("missing plugins root → empty", () => {
    writeInstalled({ version: 2 });
    expect(loadInstalledPluginPaths()).toEqual([]);
  });

  test("translates installPath → { type:'local', path }", () => {
    const path = mkdirSync(join(paths.claudeConfig, "plugins", "cache", "mp", "p", "v"), { recursive: true })!;
    writeInstalled({
      version: 2,
      plugins: {
        "p@mp": [{ scope: "user", installPath: path }],
      },
    });
    expect(loadInstalledPluginPaths()).toEqual([{ type: "local", path }]);
  });

  test("skips records whose installPath does not exist", () => {
    writeInstalled({
      version: 2,
      plugins: {
        "missing@mp": [{ scope: "user", installPath: "/nonexistent/path" }],
      },
    });
    expect(loadInstalledPluginPaths()).toEqual([]);
  });

  test("dedupes repeated installPath across plugin keys", () => {
    const path = mkdirSync(join(paths.claudeConfig, "plugins", "cache", "mp", "dup", "v"), { recursive: true })!;
    writeInstalled({
      version: 2,
      plugins: {
        "a@mp": [{ scope: "user", installPath: path }],
        "b@mp": [{ scope: "user", installPath: path }],
      },
    });
    expect(loadInstalledPluginPaths()).toEqual([{ type: "local", path }]);
  });

  test("skips entries missing installPath", () => {
    writeInstalled({
      version: 2,
      plugins: {
        "bare@mp": [{ scope: "user" }],
      },
    });
    expect(loadInstalledPluginPaths()).toEqual([]);
  });
});
