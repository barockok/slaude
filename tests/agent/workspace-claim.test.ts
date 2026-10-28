import { describe, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { paths } from "../../src/config/home";
import { isProactiveWorkspace, proactiveWorkspaceDir } from "../../src/agent/workspace-claim";

describe("proactive workspace paths", () => {
  test("the proactive folder is per agent, under paths.workspaces", () => {
    expect(proactiveWorkspaceDir("U0AGENT")).toBe(join(paths.workspaces, "agent-U0AGENT", "proactive"));
  });
  test("an agent id cannot leave paths.workspaces", () => {
    for (const id of ["../../etc", "a/b", "x y", ""]) {
      const d = proactiveWorkspaceDir(id);
      expect(dirname(dirname(d))).toBe(paths.workspaces);
      expect(basename(dirname(d))).toMatch(/^agent-[A-Za-z0-9_-]*$/);
    }
  });
  test("isProactiveWorkspace: only the proactive folder of some agent", () => {
    expect(isProactiveWorkspace(proactiveWorkspaceDir("U0AGENT"))).toBe(true);
    expect(isProactiveWorkspace(join(paths.workspaces, "T-C0EXAMPLE-1800.100"))).toBe(false);
    expect(isProactiveWorkspace(join(paths.workspaces, "agent-U0AGENT", "proactive", "repo"))).toBe(false);
    expect(isProactiveWorkspace(null)).toBe(false);
  });
});
