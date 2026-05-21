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
  test("accepts git-backed skill entry without slug", () => {
    const r = skillEntry.parse({ git: "github:foo/skill", ref: "v1.0.0" });
    expect(r.git).toBe("github:foo/skill");
    expect(r.ref).toBe("v1.0.0");
    expect(r.slug).toBeUndefined();
  });

  test("accepts git-backed skill entry with slug", () => {
    const r = skillEntry.parse({ git: "github:foo/skill", ref: "main", slug: "my-skill" });
    expect(r.slug).toBe("my-skill");
  });

  test("accepts local skill entry with only slug", () => {
    const r = skillEntry.parse({ slug: "my-local-skill" });
    expect(r.slug).toBe("my-local-skill");
    expect(r.git).toBeUndefined();
    expect(r.ref).toBeUndefined();
  });

  test("rejects skill with git but no ref (mixed)", () => {
    expect(() => skillEntry.parse({ git: "github:foo/skill" })).toThrow();
  });

  test("rejects skill with ref but no git (mixed)", () => {
    expect(() => skillEntry.parse({ ref: "v1" })).toThrow();
  });

  test("rejects local skill without slug", () => {
    expect(() => skillEntry.parse({})).toThrow();
  });

  test("rejects empty slug on local entry", () => {
    expect(() => skillEntry.parse({ slug: "" })).toThrow();
  });

  test("accepts git-backed skill with path", () => {
    const r = skillEntry.parse({ git: "github:foo/repo", ref: "main", slug: "my-skill", path: "skills/my-skill" });
    expect(r.path).toBe("skills/my-skill");
  });

  test("accepts git-backed skill without path (backward compat)", () => {
    const r = skillEntry.parse({ git: "github:foo/skill", ref: "v1.0.0", slug: "old-skill" });
    expect(r.path).toBeUndefined();
  });
});

describe("knowledgeEntry", () => {
  test("accepts git-backed knowledge entry", () => {
    const r = knowledgeEntry.parse({ label: "runbooks", git: "github:foo/wiki", ref: "v3.0.0" });
    expect(r.label).toBe("runbooks");
    expect(r.git).toBe("github:foo/wiki");
  });

  test("accepts local knowledge entry with only label", () => {
    const r = knowledgeEntry.parse({ label: "local-kb" });
    expect(r.label).toBe("local-kb");
    expect(r.git).toBeUndefined();
    expect(r.ref).toBeUndefined();
  });

  test("rejects missing label on git entry", () => {
    expect(() => knowledgeEntry.parse({ git: "github:foo/wiki", ref: "v1" })).toThrow();
  });

  test("rejects missing label on local entry", () => {
    expect(() => knowledgeEntry.parse({})).toThrow();
  });

  test("rejects knowledge with git but no ref (mixed)", () => {
    expect(() => knowledgeEntry.parse({ label: "x", git: "github:foo/wiki" })).toThrow();
  });

  test("rejects knowledge with ref but no git (mixed)", () => {
    expect(() => knowledgeEntry.parse({ label: "x", ref: "v1" })).toThrow();
  });

  test("rejects empty label", () => {
    expect(() => knowledgeEntry.parse({ label: "", git: "github:foo/wiki", ref: "v1" })).toThrow();
  });

  test("accepts git-backed knowledge with path", () => {
    const r = knowledgeEntry.parse({ label: "runbooks", git: "github:foo/repo", ref: "main", path: "knowledge/runbooks" });
    expect(r.path).toBe("knowledge/runbooks");
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

  test("accepts manifest with mix of git-backed and local entries", () => {
    const r = manifestSchema.parse({
      skills: [
        { git: "github:foo/git-skill", ref: "v1" },
        { slug: "local-skill" },
      ],
      knowledge: [
        { label: "git-kb", git: "github:foo/wiki", ref: "main" },
        { label: "local-kb" },
      ],
    });
    expect(r.skills.length).toBe(2);
    expect(r.skills[0]!.git).toBe("github:foo/git-skill");
    expect(r.skills[1]!.slug).toBe("local-skill");
    expect(r.knowledge.length).toBe(2);
    expect(r.knowledge[0]!.git).toBe("github:foo/wiki");
    expect(r.knowledge[1]!.label).toBe("local-kb");
  });

  test("unknown keys are stripped by zod by default", () => {
    const r = manifestSchema.parse({ plugins: [], mcp: [] as any });
    expect(r.plugins).toEqual([]);
    expect((r as any).mcp).toBeUndefined();
  });
});

describe("manifestSchema slaude_skills", () => {
  test("accepts manifest without slaude_skills (optional)", () => {
    const r = manifestSchema.parse({});
    expect(r.slaude_skills).toBeUndefined();
  });

  test("accepts manifest with slaude_skills", () => {
    const r = manifestSchema.parse({
      slaude_skills: { git: "github:owner/my-skills", ref: "main" },
    });
    expect(r.slaude_skills?.git).toBe("github:owner/my-skills");
    expect(r.slaude_skills?.ref).toBe("main");
  });

  test("rejects slaude_skills with missing git", () => {
    expect(() => manifestSchema.parse({ slaude_skills: { ref: "main" } })).toThrow();
  });

  test("rejects slaude_skills with missing ref", () => {
    expect(() => manifestSchema.parse({ slaude_skills: { git: "github:owner/repo" } })).toThrow();
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
