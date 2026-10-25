import { describe, expect, it } from "bun:test";
import { runtimeBaseline } from "../../src/soul/loader";
import { listBuiltinSkills } from "../../src/soul/builtin";

describe("runtime baseline — voice", () => {
  const b = runtimeBaseline(true);
  it("has a writing-style section", () => expect(b).toContain("## How you write"));
  it("forbids narrating machinery", () => {
    expect(b).toContain("Never narrate machinery");
    expect(b).toMatch(/from my KB/); // named as a forbidden example
  });
  it("KB-first governs action, not wording", () => expect(b).toContain("Do not mention that you checked"));
  it("never repeats a person's stated preferences to others", () =>
    expect(b).toContain("Never repeat what someone told you about how they want to be treated"));
});

// The Skill evolution section moved into the built-in skill slaude:skill-authoring.
describe("slaude:skill-authoring — skill evolution", () => {
  const b = listBuiltinSkills().find((s) => s.name === "skill-authoring")!.body;
  it("is no longer in the runtime baseline", () => {
    expect(runtimeBaseline(true)).not.toContain("## Skill evolution");
    expect(runtimeBaseline(false)).not.toContain("## Skill evolution");
  });
  it("uses the raised bar, not 'more than one tool call'", () => {
    expect(b).not.toContain("more than one tool call");
    expect(b).toMatch(/took several\s+steps/);
  });
  it("states the no-announce rule without a contradictory qualifier", () => {
    expect(b).not.toContain("proactively (not in direct response to");
    expect(b).toMatch(/Do not announce a skill save or update unless the user asked for the\s+skill/);
  });
});
