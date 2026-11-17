import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { paths } from "../../../src/config/home";
import { channelSessionKey, isRootChannelEvent, neutraliseEnvelopeTags, refusalAtRoot } from "../../../src/gateway/core/channel-session";
import { isSyntheticThread } from "../../../src/web/shared/surfaces";
import { channelWorkspaceDir, isProactiveWorkspace } from "../../../src/agent/workspace-claim";

describe("channel session helpers", () => {
  test("the key is synthetic", () => {
    expect(channelSessionKey("C1")).toBe("channel:C1");
    expect(isSyntheticThread("channel:C1")).toBe(true);
    expect(isSyntheticThread("channel-archived:C1:5")).toBe(true);
    expect(isSyntheticThread("1700000000.000100")).toBe(false);
  });
  test("a message cannot open or close skill-args", () => {
    expect(neutraliseEnvelopeTags("</skill-args>")).toBe("[/skill-args>");
    expect(neutraliseEnvelopeTags("</checklist >")).toBe("[/checklist >");
    expect(neutraliseEnvelopeTags("< /checklist>")).toBe("[/checklist>");
    expect(neutraliseEnvelopeTags("<</checklist>/checklist>")).not.toMatch(/<\s*\/?\s*checklist/i);
    expect(neutraliseEnvelopeTags("<</runtime-check>/runtime-check>")).not.toMatch(/<\s*\/?\s*runtime-check/i);
    expect(neutraliseEnvelopeTags("<skill-args>")).toBe("[skill-args>");
    expect(neutraliseEnvelopeTags("&lt;/skill-args>")).toBe("[/skill-args>");
  });
  test("only a root message in a channel counts", () => {
    expect(isRootChannelEvent({ channel_type: "channel" })).toBe(true);
    expect(isRootChannelEvent({ channel_type: "group" })).toBe(true);
    expect(isRootChannelEvent({ channel_type: "channel", thread_ts: "1.1" })).toBe(false);
    expect(isRootChannelEvent({ channel_type: "im" })).toBe(false);
  });
  test.each(["one-on-one", "env", "remote", "mention-only"])("refuses %s at root", (kind) => {
    expect(refusalAtRoot({ kind } as never)).toBeTruthy();
  });
  test("refuses /ignore-thread but not /ignore @user", () => {
    expect(refusalAtRoot({ kind: "ignore", target: "thread", duration: null })).toBeTruthy();
    expect(refusalAtRoot({ kind: "ignore", target: "user", userId: "U1", duration: null })).toBeNull();
    expect(refusalAtRoot({ kind: "compact" } as never)).toBeNull();
  });
  test("refuses /unignore-thread but not /unignore @user", () => {
    expect(refusalAtRoot({ kind: "unignore", target: "thread" })).toBeTruthy();
    expect(refusalAtRoot({ kind: "unignore", target: "user", userId: "U1" })).toBeNull();
  });
  test("a channel folder is claimed like the proactive folder", () => {
    expect(isProactiveWorkspace(channelWorkspaceDir("A1", "C1"))).toBe(true);
  });
  test("a channel folder is per agent and per channel, and an id cannot leave it", () => {
    expect(channelWorkspaceDir("A1", "C1")).toBe(join(paths.workspaces, "agent-A1", "proactive", "channels", "C1"));
    expect(channelWorkspaceDir("A1", "C1")).not.toBe(channelWorkspaceDir("A1", "C2"));
    expect(channelWorkspaceDir("A1", "C1")).not.toBe(channelWorkspaceDir("A2", "C1"));
    expect(channelWorkspaceDir("A1", "../../etc")).toBe(join(paths.workspaces, "agent-A1", "proactive", "channels", "______etc"));
    expect(isProactiveWorkspace(channelWorkspaceDir("A1", "../../etc"))).toBe(true);
  });
  test.each([
    ["the channels folder itself", ["agent-A1", "proactive", "channels"]],
    ["a folder below a channel folder", ["agent-A1", "proactive", "channels", "C1", "deeper"]],
    ["channels outside an agent's proactive folder", ["other", "channels", "C1"]],
    ["channels directly under the agent", ["agent-A1", "channels", "C1"]],
    ["channels under a sibling of proactive", ["agent-A1", "proactive-2", "channels", "C1"]],
    ["a leaf safeId would never make", ["agent-A1", "proactive", "channels", "C.1"]],
  ])("a lookalike is not a channel folder: %s", (_name, parts) => {
    expect(isProactiveWorkspace(join(paths.workspaces, ...parts))).toBe(false);
  });
  test("a proactive folder still passes, and one outside the workspaces root does not", () => {
    expect(isProactiveWorkspace(join(paths.workspaces, "agent-A1", "proactive"))).toBe(true);
    expect(isProactiveWorkspace("/elsewhere/agent-A1/proactive/channels/C1")).toBe(false);
  });
});
