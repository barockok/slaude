import { describe, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { paths } from "../../src/config/home";
import { isProactiveWorkspace, proactiveWorkspaceDir, WorkspaceClaims } from "../../src/agent/workspace-claim";

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

// One holder per folder at a time, re-entrant for that holder, FIFO for
// everyone waiting, and folders independent of each other.
describe("WorkspaceClaims", () => {
  test("WorkspaceClaims: second holder waits until the first releases; FIFO after that", async () => {
    const c = new WorkspaceClaims(); const order: string[] = [];
    await c.acquire("/w", "s1");
    const p2 = c.acquire("/w", "s2").then(() => order.push("s2"));
    const p3 = c.acquire("/w", "s3").then(() => order.push("s3"));
    await Bun.sleep(5); expect(order).toEqual([]);
    c.releaseHolder("s1"); await p2; expect(c.holderOf("/w")).toBe("s2");
    c.releaseHolder("s2"); await p3; expect(order).toEqual(["s2", "s3"]);
  }, 2000);
  test("WorkspaceClaims: re-entrant for the same holder; release of a non-holder is a no-op", async () => {
    const c = new WorkspaceClaims();
    await c.acquire("/w", "s1"); await c.acquire("/w", "s1");
    c.releaseHolder("s9"); expect(c.holderOf("/w")).toBe("s1");
  }, 2000);
  test("WorkspaceClaims: different folders never wait on each other", async () => {
    const c = new WorkspaceClaims();
    await c.acquire("/a", "s1"); await c.acquire("/b", "s2");
    expect([c.holderOf("/a"), c.holderOf("/b")]).toEqual(["s1", "s2"]);
  }, 2000);
  test("WorkspaceClaims: the last release frees the folder; releasing a waiter does not drop its place", async () => {
    const c = new WorkspaceClaims();
    await c.acquire("/w", "s1");
    c.releaseHolder("s1");
    expect(c.holderOf("/w")).toBeNull();
    await c.acquire("/w", "s1");
    const p2 = c.acquire("/w", "s2");
    // s2's session exits while its message waits: the message is delayed, never dropped.
    c.releaseHolder("s2");
    expect(c.holderOf("/w")).toBe("s1");
    c.releaseHolder("s1");
    await p2;
    expect(c.holderOf("/w")).toBe("s2");
    c.releaseHolder("s2");
    expect(c.holderOf("/w")).toBeNull();
  }, 2000);
});
