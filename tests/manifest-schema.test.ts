import { describe, expect, test } from "bun:test";
import {
  manifestSchema,
  lockfileSchema,
  pluginEntry,
  skillEntry,
  knowledgeEntry,
  resolveSkillSource,
  resolveSkillSlug,
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

  test("accepts vercel-style source (owner/repo)", () => {
    const r = skillEntry.parse({ source: "vercel-labs/skills" });
    expect(r.source).toBe("vercel-labs/skills");
    expect(r.git).toBeUndefined();
    expect(r.ref).toBeUndefined();
    expect(r.slug).toBeUndefined();
  });

  test("accepts vercel-style source with path (owner/repo/skill-path)", () => {
    const r = skillEntry.parse({ source: "vercel-labs/skills/react-best-practices" });
    expect(r.source).toBe("vercel-labs/skills/react-best-practices");
  });

  test("accepts vercel-style source with ref (owner/repo@ref)", () => {
    const r = skillEntry.parse({ source: "vercel-labs/skills@v1.0.0" });
    expect(r.source).toBe("vercel-labs/skills@v1.0.0");
  });

  test("accepts vercel-style source with path and ref", () => {
    const r = skillEntry.parse({ source: "vercel-labs/skills/react@main" });
    expect(r.source).toBe("vercel-labs/skills/react@main");
  });

  test("rejects source mixed with git", () => {
    expect(() => skillEntry.parse({ source: "vercel-labs/skills", git: "github:foo/bar" })).toThrow();
  });

  test("rejects source mixed with ref", () => {
    expect(() => skillEntry.parse({ source: "vercel-labs/skills", ref: "main" })).toThrow();
  });

  test("rejects invalid source format", () => {
    expect(() => skillEntry.parse({ source: "just-owner" })).toThrow();
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

describe("manifestSchema slaude_knowledge", () => {
  test("accepts manifest without slaude_knowledge (optional)", () => {
    const r = manifestSchema.parse({});
    expect(r.slaude_knowledge).toBeUndefined();
  });

  test("accepts manifest with slaude_knowledge", () => {
    const r = manifestSchema.parse({
      slaude_knowledge: { label: "ops-wiki", git: "github:owner/wiki", ref: "main" },
    });
    expect(r.slaude_knowledge?.label).toBe("ops-wiki");
    expect(r.slaude_knowledge?.git).toBe("github:owner/wiki");
  });

  test("rejects slaude_knowledge with missing label", () => {
    expect(() => manifestSchema.parse({
      slaude_knowledge: { git: "github:owner/wiki", ref: "main" },
    })).toThrow();
  });

  test("rejects slaude_knowledge with missing git/ref", () => {
    expect(() => manifestSchema.parse({
      slaude_knowledge: { label: "wiki" },
    })).toThrow();
  });
});

describe("lockfileSchema slaude_skills", () => {
  test("accepts lockfile without slaude_skills", () => {
    const r = lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
    });
    expect(r.slaude_skills).toBeUndefined();
  });

  test("accepts slaude_skills lock with single sha", () => {
    const r = lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
      slaude_skills: { git: "github:owner/sk", ref: "main", sha: "c".repeat(40) },
    });
    expect(r.slaude_skills?.sha).toBe("c".repeat(40));
  });

  test("rejects slaude_skills missing git", () => {
    expect(() => lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
      slaude_skills: { ref: "main", sha: "c".repeat(40) },
    })).toThrow();
  });

  test("rejects slaude_skills missing ref", () => {
    expect(() => lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
      slaude_skills: { git: "github:owner/sk", sha: "c".repeat(40) },
    })).toThrow();
  });

  test("rejects slaude_skills invalid sha length", () => {
    expect(() => lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
      slaude_skills: { git: "github:owner/sk", ref: "main", sha: "short" },
    })).toThrow();
  });
});

describe("lockfileSchema slaude_knowledge", () => {
  test("accepts lockfile without slaude_knowledge", () => {
    const r = lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
    });
    expect(r.slaude_knowledge).toBeUndefined();
  });

  test("accepts lockfile with slaude_knowledge raw_sha + wiki_sha", () => {
    const r = lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
      slaude_knowledge: {
        label: "ops-wiki",
        git: "github:owner/wiki",
        ref: "main",
        raw_sha: "a".repeat(40),
        wiki_sha: "b".repeat(40),
      },
    });
    expect(r.slaude_knowledge?.raw_sha).toBe("a".repeat(40));
    expect(r.slaude_knowledge?.wiki_sha).toBe("b".repeat(40));
  });

  test("rejects slaude_knowledge missing label", () => {
    expect(() => lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
      slaude_knowledge: { git: "github:owner/wiki", ref: "main" },
    })).toThrow();
  });
});

describe("resolveSkillSource", () => {
  test("parses owner/repo to github:owner/repo with main ref", () => {
    const r = resolveSkillSource("vercel-labs/skills");
    expect(r.git).toBe("github:vercel-labs/skills");
    expect(r.ref).toBe("main");
    expect(r.path).toBeUndefined();
  });

  test("parses owner/repo/path with default ref", () => {
    const r = resolveSkillSource("vercel-labs/skills/react-best-practices");
    expect(r.git).toBe("github:vercel-labs/skills");
    expect(r.ref).toBe("main");
    expect(r.path).toBe("react-best-practices");
  });

  test("parses owner/repo@ref", () => {
    const r = resolveSkillSource("vercel-labs/skills@v1.2.3");
    expect(r.git).toBe("github:vercel-labs/skills");
    expect(r.ref).toBe("v1.2.3");
    expect(r.path).toBeUndefined();
  });

  test("parses owner/repo/path@ref", () => {
    const r = resolveSkillSource("vercel-labs/skills/react@v2.0.0");
    expect(r.git).toBe("github:vercel-labs/skills");
    expect(r.ref).toBe("v2.0.0");
    expect(r.path).toBe("react");
  });

  test("parses nested path", () => {
    const r = resolveSkillSource("org/repo/skills/deep/nested");
    expect(r.git).toBe("github:org/repo");
    expect(r.path).toBe("skills/deep/nested");
  });

  test("throws on invalid source", () => {
    expect(() => resolveSkillSource("just-owner")).toThrow();
  });
});

describe("resolveSkillSlug", () => {
  test("uses explicit slug when provided", () => {
    expect(resolveSkillSlug({ slug: "my-skill" })).toBe("my-skill");
  });

  test("derives slug from git URL", () => {
    expect(resolveSkillSlug({ git: "github:foo/bar" })).toBe("bar");
  });

  test("derives slug from git URL stripping .git", () => {
    expect(resolveSkillSlug({ git: "github:foo/bar.git" })).toBe("bar");
  });

  test("derives slug from source (repo only)", () => {
    expect(resolveSkillSlug({ source: "vercel-labs/skills" })).toBe("skills");
  });

  test("derives slug from source (with path)", () => {
    expect(resolveSkillSlug({ source: "vercel-labs/skills/react-best-practices" })).toBe("react-best-practices");
  });

  test("derives slug from source (nested path)", () => {
    expect(resolveSkillSlug({ source: "org/repo/skills/deep/nested" })).toBe("nested");
  });

  test("throws when nothing to resolve from", () => {
    expect(() => resolveSkillSlug({})).toThrow();
  });
});
