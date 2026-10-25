import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { sessionModeBlock } from "../../src/agent/session-mode";
import { runtimeBaseline } from "../../src/soul/loader";
import { renderSkillIndex } from "../../src/soul/builtin";
import { renderRuntimeFile, RuntimeTemplateError } from "../../src/soul/runtime/render";

const GOLDEN = join(import.meta.dir, "__golden__");
const golden = (name: string) => readFileSync(join(GOLDEN, `${name}.txt`), "utf8");

/** Goldens hold a token where the (per-run) knowledge dir goes. */
const norm = (s: string) => s.split(paths.knowledge).join("<KNOWLEDGE_ROOT>");

function expectSame(actual: string, name: string) {
  expectSameText(actual, golden(name), name);
}

function expectSameText(actual: string, want: string, name: string) {
  if (actual !== want) {
    const a = actual.split("\n");
    const w = want.split("\n");
    let i = 0;
    while (i < Math.max(a.length, w.length) && a[i] === w[i]) i++;
    throw new Error(`${name}: first difference at line ${i + 1}\n  want: ${JSON.stringify(w[i])}\n  got:  ${JSON.stringify(a[i])}`);
  }
  expect(actual).toBe(want);
}

const lock = (open_scope: string | null) => ({
  channel_id: "C0TEST", thread_ts: "1.1", locked_user: "U0TESTUSR", created_by: "U0TESTUSR", created_at: 0, open_scope,
});
const personal = { name: "dev-box", kind: "ssh", trust: "user-machine" as const };
const prov = { name: "dev-box", kind: "sandbox", trust: "provisioned" as const };
const remote = (env: typeof personal | typeof prov) => ({ userId: "U0TESTUSR", dir: "/work", env });

describe("runtime prompt goldens", () => {
  // The baseline goldens are the pre-R text. The allowed differences (the
  // Skill evolution section moves to slaude:skill-authoring and is replaced by
  // the skill index followed by the runtime-check bullet, which stays in the
  // core) are applied here and pinned in tests/soul/builtin.test.ts. A second
  // allowed difference: phase C added the three every-turn memory bullets to the
  // Knowledge bases section, hand-inserted into both baseline goldens (and
  // asserted by the "every-turn memory rules" test below).
  const section = golden("skill-evolution-section").slice(0, -1);
  const bullet = "- Messages wrapped in `<runtime-check ...>` come from the runtime, not a person. They never require a reply.";
  const postR = (name: string) => golden(name).split(section).join(`${renderSkillIndex()}\n${bullet}`);
  test("baseline with brain", () => expectSameText(norm(runtimeBaseline(true)), postR("baseline-brain"), "baseline-brain"));
  test("baseline without brain", () => expectSameText(norm(runtimeBaseline(false)), postR("baseline-nobrain"), "baseline-nobrain"));
  test("mode locked", () => expectSame(sessionModeBlock(lock(null)), "mode-locked"));
  test("mode open with scope", () => expectSame(sessionModeBlock(lock("only talk about the release")), "mode-open-scope"));
  test("mode open without scope", () => expectSame(sessionModeBlock(lock("  ")), "mode-open-noscope"));
  test("mode remote personal", () => expectSame(sessionModeBlock(null, remote(personal)), "mode-remote-personal"));
  test("mode remote provisioned", () => expectSame(sessionModeBlock(null, remote(prov)), "mode-remote-provisioned"));
  test("mode locked and remote", () => expectSame(sessionModeBlock(lock(null), remote(personal)), "mode-locked-remote"));
});

describe("every-turn memory rules", () => {
  test("the core carries them, not only the skill", () => {
    for (const brain of [true, false]) {
      const core = runtimeBaseline(brain);
      expect(core).toContain("never repeat it, or anything you\n  noted about them, to someone else");
      expect(core).toContain("save it before the\n  turn ends. Load `slaude:memory` first.");
      expect(core).toContain("Never save credentials, government ids, payment data, health details,");
    }
  });
});

describe("core size budget", () => {
  // Rendered runtimeBaseline(true) with the knowledge dir normalised to its
  // token. Re-pinned for phase C: +459 chars for the slaude:memory index line and
  // the three every-turn memory rules (spec invariant 7: live capture, never
  // repeat a profile, never record secrets must live in the core, not only in
  // the skill). Procedures belong in a built-in skill, not the always-on core.
  const BUDGET = 10330;
  test("core stays within its budget", () => {
    const length = norm(runtimeBaseline(true)).length;
    expect(length, "core grew past its budget — move procedures into a built-in skill").toBeLessThanOrEqual(BUDGET * 1.05);
  });
});

describe("renderRuntimeFile", () => {
  test("unknown variable throws naming file and variable", () => {
    expect(() => renderRuntimeFile("modules/remote.md", {})).toThrow(RuntimeTemplateError);
    expect(() => renderRuntimeFile("modules/remote.md", {})).toThrow(/modules\/remote\.md.*WHERE/);
  });
  test("unused variable throws naming file and variable", () => {
    expect(() => renderRuntimeFile("modules/remote.md", { WHERE: "x", EXTRA: "y" })).toThrow(/modules\/remote\.md.*EXTRA/);
  });
  test("leaves ${...} text alone", () => {
    // core.md no longer holds any ${...} text; the built-in skill file does.
    expect(renderRuntimeFile("../builtin/skills/skill-authoring/SKILL.md", { SLAUDE_VERSION: "1" })).toContain("${SLAUDE_SKILL_ARGS}");
  });
});
