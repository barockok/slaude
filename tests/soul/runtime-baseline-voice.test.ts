import { describe, expect, it } from "bun:test";
import { runtimeBaseline } from "../../src/soul/loader";

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
