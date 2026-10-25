import { describe, it, expect } from "bun:test";
import { SkillGate } from "../../src/agent/skill-gate";

const WRITE = "mcp__slaude_skills__write_skill";
const DELETE = "mcp__slaude_skills__delete_skill";
const REASON =
  'Load `slaude:skill-authoring` first (call the Skill tool with skill "slaude:skill-authoring"), then retry.';
const DENY: Record<string, unknown> = {
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON },
};
const opts = { signal: new AbortController().signal };

/** The hook inputs exactly as the SDK sends them (BaseHookInput fields + event fields). */
const base = { session_id: "cli-1", transcript_path: "/t.jsonl", cwd: "/w" };
const preInput = (tool: string, input: unknown = {}) =>
  ({ ...base, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "tu1" }) as any;
const postInput = (tool: string, input: unknown, response: unknown) =>
  ({ ...base, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: response, tool_use_id: "tu2" }) as any;
const loadSkill = (skill: string, response: unknown = "Launching skill: " + skill) =>
  postInput("Skill", { skill }, response);

function booted(id = "s1", mounted = true) {
  const g = new SkillGate();
  g.reset(id);
  g.markMounted(id, mounted);
  return g;
}

describe("SkillGate", () => {
  it("blocks kb_memoize until slaude:memory has loaded", async () => {
    const g = booted();
    const MEMOIZE = "mcp__slaude_kb__kb_memoize";
    const deny: Record<string, unknown> = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: 'Load `slaude:memory` first (call the Skill tool with skill "slaude:memory"), then retry.',
      },
    };
    expect(await g.pre("s1")(preInput(MEMOIZE, { pages: [] }), "tu1", opts)).toEqual(deny);
    await g.post("s1")(loadSkill("slaude:memory"), "tu2", opts);
    expect(await g.pre("s1")(preInput(MEMOIZE, { pages: [] }), "tu1", opts)).toEqual({});
  });

  it("blocks a governed tool until its skill is loaded, then allows it", async () => {
    const g = booted();
    expect(await g.pre("s1")(preInput(WRITE, { slug: "x" }), "tu1", opts)).toEqual(DENY);
    expect(await g.pre("s1")(preInput(DELETE, { slug: "x" }), "tu1", opts)).toEqual(DENY);
    expect(g.isLoaded("s1", "slaude:skill-authoring")).toBe(false);

    expect(await g.post("s1")(loadSkill("slaude:skill-authoring"), "tu2", opts)).toEqual({});
    expect(g.isLoaded("s1", "slaude:skill-authoring")).toBe(true);
    expect(await g.pre("s1")(preInput(WRITE, { slug: "x" }), "tu1", opts)).toEqual({});
    expect(await g.pre("s1")(preInput(DELETE, { slug: "x" }), "tu1", opts)).toEqual({});
  });

  it("non-governed tools are never blocked", async () => {
    const g = booted();
    for (const t of ["Bash", "Skill", "mcp__slaude_skills__list_skills", "mcp__slaude_skills__read_skill"]) {
      expect(await g.pre("s1")(preInput(t), "tu1", opts)).toEqual({});
    }
    // another hook event reaching the callback is ignored
    expect(await g.pre("s1")({ ...preInput(WRITE), hook_event_name: "PostToolUse" }, "tu1", opts)).toEqual({});
  });

  it("failed Skill call does not mark loaded", async () => {
    const g = booted();
    const failures: unknown[] = [
      { is_error: true, content: "no such skill" },
      "Error: Unknown skill: slaude:skill-authoring",
      "<tool_use_error>Unknown skill</tool_use_error>",
    ];
    for (const r of failures) await g.post("s1")(loadSkill("slaude:skill-authoring", r), "tu2", opts);
    expect(g.isLoaded("s1", "slaude:skill-authoring")).toBe(false);

    // only an exact built-in qualified name counts
    for (const s of ["skill-authoring", "other:skill-authoring", "slaude:skill-authoring2", "slaude:nope"]) {
      await g.post("s1")(loadSkill(s), "tu2", opts);
    }
    // a non-Skill tool carrying a `skill` field does not count
    await g.post("s1")(postInput("Bash", { skill: "slaude:skill-authoring" }, "ok"), "tu2", opts);
    expect(g.isLoaded("s1", "slaude:skill-authoring")).toBe(false);
    expect(await g.pre("s1")(preInput(WRITE), "tu1", opts)).toEqual(DENY);

    // an object response without is_error is success
    await g.post("s1")(loadSkill("slaude:skill-authoring", { success: true, commandName: "slaude:skill-authoring" }), "tu2", opts);
    expect(g.isLoaded("s1", "slaude:skill-authoring")).toBe(true);
  });

  it("normalises the skill name the way the CLI does (trim, one leading /)", async () => {
    for (const form of ["/slaude:skill-authoring", " slaude:skill-authoring ", "  /slaude:skill-authoring\n"]) {
      const g = booted();
      await g.post("s1")(loadSkill(form), "tu2", opts);
      expect(g.isLoaded("s1", "slaude:skill-authoring")).toBe(true);
      expect(await g.pre("s1")(preInput(WRITE), "tu1", opts)).toEqual({});
    }
    // only one slash is stripped, and the rest must still be an exact built-in name
    const g = booted();
    for (const s of ["/slaude:other", "//slaude:skill-authoring", "/skill-authoring", "/ slaude:skill-authoring"]) {
      await g.post("s1")(loadSkill(s), "tu2", opts);
    }
    expect(g.isLoaded("s1", "slaude:skill-authoring")).toBe(false);
    expect(await g.pre("s1")(preInput(WRITE), "tu1", opts)).toEqual(DENY);
  });

  it("reset (reboot) requires loading again", async () => {
    const g = booted();
    await g.post("s1")(loadSkill("slaude:skill-authoring"), "tu2", opts);
    expect(await g.pre("s1")(preInput(WRITE), "tu1", opts)).toEqual({});
    g.reset("s1");
    g.markMounted("s1", true);
    expect(g.isLoaded("s1", "slaude:skill-authoring")).toBe(false);
    expect(await g.pre("s1")(preInput(WRITE), "tu1", opts)).toEqual(DENY);
    // sessions are independent
    g.reset("s2");
    g.markMounted("s2", true);
    await g.post("s2")(loadSkill("slaude:skill-authoring"), "tu2", opts);
    expect(await g.pre("s1")(preInput(WRITE), "tu1", opts)).toEqual(DENY);
    expect(await g.pre("s2")(preInput(WRITE), "tu1", opts)).toEqual({});
    // forget drops the session's state
    g.forget("s2");
    expect(g.size).toBe(1);
  });

  it("no plugin mounted → no enforcement", async () => {
    const g = booted("s1", false);
    expect(await g.pre("s1")(preInput(WRITE), "tu1", opts)).toEqual({});
    // a session the gate knows nothing about is not enforced either
    expect(await new SkillGate().pre("unknown")(preInput(WRITE), "tu1", opts)).toEqual({});
  });
});
