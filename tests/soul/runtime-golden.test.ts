import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { sessionModeBlock } from "../../src/agent/session-mode";
import { runtimeBaseline } from "../../src/soul/loader";
import { renderRuntimeFile, RuntimeTemplateError } from "../../src/soul/runtime/render";

const GOLDEN = join(import.meta.dir, "__golden__");
const golden = (name: string) => readFileSync(join(GOLDEN, `${name}.txt`), "utf8");

/** Goldens hold a token where the (per-run) knowledge dir goes. */
const norm = (s: string) => s.split(paths.knowledge).join("<KNOWLEDGE_ROOT>");

function expectSame(actual: string, name: string) {
  const want = golden(name);
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
  test("baseline with brain", () => expectSame(norm(runtimeBaseline(true)), "baseline-brain"));
  test("baseline without brain", () => expectSame(norm(runtimeBaseline(false)), "baseline-nobrain"));
  test("mode locked", () => expectSame(sessionModeBlock(lock(null)), "mode-locked"));
  test("mode open with scope", () => expectSame(sessionModeBlock(lock("only talk about the release")), "mode-open-scope"));
  test("mode open without scope", () => expectSame(sessionModeBlock(lock("  ")), "mode-open-noscope"));
  test("mode remote personal", () => expectSame(sessionModeBlock(null, remote(personal)), "mode-remote-personal"));
  test("mode remote provisioned", () => expectSame(sessionModeBlock(null, remote(prov)), "mode-remote-provisioned"));
  test("mode locked and remote", () => expectSame(sessionModeBlock(lock(null), remote(personal)), "mode-locked-remote"));
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
    expect(renderRuntimeFile("core.md", { KB_FALLBACK: "a", KB_READ: "b", KB_TOOLS: "c" })).toContain("${SLAUDE_SKILL_ARGS}");
  });
});
