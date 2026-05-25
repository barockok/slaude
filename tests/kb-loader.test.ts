import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureHome } from "../src/config/home";
import { loadKbs, clearKbCache, type KbEntry } from "../src/knowledge/loader";

function seedKb(label: string, setup: (dir: string) => void) {
  ensureHome();
  const dir = join(paths.knowledge, label);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  setup(dir);
}

beforeEach(() => {
  ensureHome();
  if (existsSync(paths.knowledge)) rmSync(paths.knowledge, { recursive: true, force: true });
  mkdirSync(paths.knowledge, { recursive: true });
  clearKbCache();
});

describe("loadKbs", () => {
  test("empty directory returns []", () => {
    expect(loadKbs()).toEqual([]);
  });

  test("missing root returns []", () => {
    rmSync(paths.knowledge, { recursive: true, force: true });
    expect(loadKbs()).toEqual([]);
  });

  test("README.md preferred over index.md", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), "# Hello\nfirst line");
      writeFileSync(join(dir, "index.md"), "should be skipped");
    });
    const kbs = loadKbs();
    expect(kbs.length).toBe(1);
    expect(kbs[0]!.index_file).toBe("README.md");
  });

  test("fallback to index.md when README.md absent", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "index.md"), "# Hello");
    });
    const kbs = loadKbs();
    expect(kbs.length).toBe(1);
    expect(kbs[0]!.index_file).toBe("index.md");
  });

  test("fallback to first .md alphabetically", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "zzz.md"), "last");
      writeFileSync(join(dir, "aaa.md"), "first");
    });
    const kbs = loadKbs();
    expect(kbs.length).toBe(1);
    expect(kbs[0]!.index_file).toBe("aaa.md");
  });

  test("frontmatter description key used", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), [
        "---",
        "description: Operator runbooks for org services",
        "---",
        "# Runbooks",
        "first paragraph",
      ].join("\n"));
    });
    const kbs = loadKbs();
    expect(kbs[0]!.description).toBe("Operator runbooks for org services");
  });

  test("description from first prose line when no frontmatter", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), "# Runbooks\n\nThis is the first paragraph.\n\nMore text.");
    });
    const kbs = loadKbs();
    expect(kbs[0]!.description).toBe("This is the first paragraph.");
  });

  test("description truncated at 200 chars", () => {
    const longLine = "A".repeat(250);
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), longLine);
    });
    const kbs = loadKbs();
    expect(kbs[0]!.description.length).toBe(200);
    expect(kbs[0]!.description.endsWith("...")).toBe(true);
  });

  test("non-directory entries skipped", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), "# Hello");
    });
    writeFileSync(join(paths.knowledge, "not-a-dir.md"), "skip me");
    const kbs = loadKbs();
    expect(kbs.length).toBe(1);
  });

  test("subdir with no .md files skipped", () => {
    const dir = join(paths.knowledge, "empty-kb");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "data.json"), "{}");
    expect(loadKbs()).toEqual([]);
  });

  test("label matches directory name", () => {
    seedKb("org-runbooks", (dir) => {
      writeFileSync(join(dir, "README.md"), "# Runbooks");
    });
    expect(loadKbs()[0]!.label).toBe("org-runbooks");
  });

  test("path is absolute dir path", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), "# Hello");
    });
    const kb = loadKbs()[0]!;
    expect(kb.path).toBe(join(paths.knowledge, "test-kb"));
  });

  test("cache returns same values on second call", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), "# Hello");
    });
    const a = loadKbs();
    const b = loadKbs();
    expect(a).toBe(b); // same reference
  });

  test("clearKbCache forces re-scan", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), "# Hello");
    });
    const before = loadKbs();
    clearKbCache();
    // Re-scan returns new array with same values
    const after = loadKbs();
    expect(after).not.toBe(before);
    expect(after.length).toBe(before.length);
  });

  test("empty frontmatter description falls through to prose", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), [
        "---",
        "description:   ",
        "---",
        "# Runbooks",
        "actual first line",
      ].join("\n"));
    });
    const kbs = loadKbs();
    expect(kbs[0]!.description).toBe("actual first line");
  });

  test("description from body text when no frontmatter at all", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "index.md"), "just some body text here");
    });
    const kbs = loadKbs();
    expect(kbs[0]!.description).toBe("just some body text here");
  });

  test("tags extracted from frontmatter", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), [
        "---",
        "description: Service A runbooks",
        "tags:",
        "  - service-a",
        "  - grafana",
        "  - alerts",
        "---",
        "# Runbooks",
      ].join("\n"));
    });
    const kbs = loadKbs();
    expect(kbs[0]!.tags).toEqual(["service-a", "grafana", "alerts"]);
  });

  test("tags empty array when no frontmatter", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), "# Runbooks\n\nSome text.");
    });
    const kbs = loadKbs();
    expect(kbs[0]!.tags).toEqual([]);
  });

  test("tags empty array when frontmatter lacks tags", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), [
        "---",
        "description: no tags here",
        "---",
        "# Runbooks",
      ].join("\n"));
    });
    const kbs = loadKbs();
    expect(kbs[0]!.tags).toEqual([]);
  });

  test("tags normalized to lowercase and trimmed", () => {
    seedKb("test-kb", (dir) => {
      writeFileSync(join(dir, "README.md"), [
        "---",
        "description: tagged",
        "tags:",
        "  - Service-A",
        "  -  GRAFANA ",
        "  - alerts",
        "---",
        "# Runbooks",
      ].join("\n"));
    });
    const kbs = loadKbs();
    expect(kbs[0]!.tags).toEqual(["service-a", "grafana", "alerts"]);
  });
});
