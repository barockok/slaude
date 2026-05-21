import { describe, expect, test } from "bun:test";
import {
  manifestSchema,
  lockfileSchema,
  pluginEntry,
  skillEntry,
  knowledgeEntry,
} from "../src/config/manifest-schema";

describe("pluginEntry", () => {
  test("accepts valid plugin entry with github: shorthand", () => {
    const r = pluginEntry.parse({ marketplace: "github:foo/bar", plugin: "superpowers", ref: "5.1.0" });
    expect(r.marketplace).toBe("github:foo/bar");
  });

  test("accepts https git URL", () => {
    const r = pluginEntry.parse({ marketplace: "https://github.com/foo/bar.git", plugin: "x", ref: "main" });
    expect(r.marketplace).toBe("https://github.com/foo/bar.git");
  });

  test("accepts git@ ssh URL", () => {
    const r = pluginEntry.parse({ marketplace: "git@github.com:foo/bar.git", plugin: "x", ref: "abc1234" });
    expect(r.marketplace).toBe("git@github.com:foo/bar.git");
  });

  test("rejects missing marketplace", () => {
    expect(() => pluginEntry.parse({ plugin: "x", ref: "v1" })).toThrow();
  });

  test("rejects missing plugin", () => {
    expect(() => pluginEntry.parse({ marketplace: "github:foo/bar", ref: "v1" })).toThrow();
  });

  test("rejects missing ref", () => {
    expect(() => pluginEntry.parse({ marketplace: "github:foo/bar", plugin: "x" })).toThrow();
  });

  test("rejects empty marketplace string", () => {
    expect(() => pluginEntry.parse({ marketplace: "", plugin: "x", ref: "v1" })).toThrow();
  });

  test("rejects empty plugin string", () => {
    expect(() => pluginEntry.parse({ marketplace: "github:foo/bar", plugin: "", ref: "v1" })).toThrow();
  });

  test("rejects empty ref string", () => {
    expect(() => pluginEntry.parse({ marketplace: "github:foo/bar", plugin: "x", ref: "" })).toThrow();
  });
});

describe("skillEntry", () => {
  test("accepts valid skill entry without slug", () => {
    const r = skillEntry.parse({ git: "github:foo/skill", ref: "v1.0.0" });
    expect(r.slug).toBeUndefined();
  });

  test("accepts valid skill entry with slug", () => {
    const r = skillEntry.parse({ git: "github:foo/skill", ref: "main", slug: "my-skill" });
    expect(r.slug).toBe("my-skill");
  });

  test("rejects missing git", () => {
    expect(() => skillEntry.parse({ ref: "v1" })).toThrow();
  });

  test("rejects missing ref", () => {
    expect(() => skillEntry.parse({ git: "github:foo/skill" })).toThrow();
  });

  test("rejects empty slug", () => {
    expect(() => skillEntry.parse({ git: "github:foo/skill", ref: "v1", slug: "" })).toThrow();
  });
});

describe("knowledgeEntry", () => {
  test("accepts valid knowledge entry", () => {
    const r = knowledgeEntry.parse({ label: "runbooks", git: "github:foo/wiki", ref: "v3.0.0" });
    expect(r.label).toBe("runbooks");
  });

  test("rejects missing label", () => {
    expect(() => knowledgeEntry.parse({ git: "github:foo/wiki", ref: "v1" })).toThrow();
  });

  test("rejects missing git", () => {
    expect(() => knowledgeEntry.parse({ label: "x", ref: "v1" })).toThrow();
  });

  test("rejects missing ref", () => {
    expect(() => knowledgeEntry.parse({ label: "x", git: "github:foo/wiki" })).toThrow();
  });

  test("rejects empty label", () => {
    expect(() => knowledgeEntry.parse({ label: "", git: "github:foo/wiki", ref: "v1" })).toThrow();
  });
});

describe("manifestSchema", () => {
  test("accepts full manifest", () => {
    const r = manifestSchema.parse({
      plugins: [{ marketplace: "github:foo/bar", plugin: "superpowers", ref: "5.1.0" }],
      skills: [{ git: "github:foo/skill", ref: "v1" }],
      knowledge: [{ label: "wiki", git: "github:foo/wiki", ref: "main" }],
    });
    expect(r.plugins.length).toBe(1);
    expect(r.skills.length).toBe(1);
    expect(r.knowledge.length).toBe(1);
  });

  test("defaults empty arrays when sections omitted", () => {
    const r = manifestSchema.parse({});
    expect(r.plugins).toEqual([]);
    expect(r.skills).toEqual([]);
    expect(r.knowledge).toEqual([]);
  });

  test("rejects non-array sections", () => {
    expect(() => manifestSchema.parse({ plugins: "nope" })).toThrow();
  });

  test("unknown keys are stripped by zod by default", () => {
    const r = manifestSchema.parse({ plugins: [], mcp: [] as any });
    expect(r.plugins).toEqual([]);
    expect((r as any).mcp).toBeUndefined();
  });
});

describe("lockfileSchema", () => {
  const validLock = {
    version: 1,
    generated_at: "2026-05-21T11:00:00Z",
    marketplaces: {
      "github:foo/bar@5.1.0": {
        sha: "a".repeat(40),
        plugins: { superpowers: { version: "5.1.0", subdir: "plugins/superpowers" } },
      },
    },
    skills: {
      "my-skill": { git: "github:foo/skill", ref: "v1.2.0", sha: "b".repeat(40) },
    },
    knowledge: {
      runbooks: { git: "github:foo/wiki", ref: "v3.0.0", sha: "c".repeat(40) },
    },
  };

  test("accepts valid lockfile", () => {
    const r = lockfileSchema.parse(validLock);
    expect(r.version).toBe(1);
    expect(Object.keys(r.marketplaces).length).toBe(1);
  });

  test("rejects version !== 1", () => {
    expect(() => lockfileSchema.parse({ ...validLock, version: 2 })).toThrow();
  });

  test("rejects bad generated_at format", () => {
    expect(() => lockfileSchema.parse({ ...validLock, generated_at: "yesterday" })).toThrow();
  });

  test("rejects sha not 40 chars", () => {
    const bad = { ...validLock, skills: { x: { git: "github:foo/x", ref: "v1", sha: "short" } } };
    expect(() => lockfileSchema.parse(bad)).toThrow();
  });

  test("defaults empty sections", () => {
    const r = lockfileSchema.parse({ version: 1, generated_at: "2026-05-21T00:00:00Z" });
    expect(r.marketplaces).toEqual({});
    expect(r.skills).toEqual({});
    expect(r.knowledge).toEqual({});
  });
});
