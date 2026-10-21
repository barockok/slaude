import { describe, it, expect } from "bun:test";
import { parseSlashCommand, guestMayRun, helpText, type SlashHit } from "../../../src/gateway/slack/commands";

describe("/1on1 parsing", () => {
  it("bare /1on1 → on", () => {
    expect(parseSlashCommand("/1on1")).toEqual({ kind: "one-on-one", action: "on", scope: "" });
  });
  it("/1on1 on → on", () => {
    expect(parseSlashCommand("/1on1 on")).toEqual({ kind: "one-on-one", action: "on", scope: "" });
  });
  it("/1on1 off → off", () => {
    expect(parseSlashCommand("/1on1 off")).toEqual({ kind: "one-on-one", action: "off", scope: "" });
  });
  it("/1on1 open → treated as bare (on) since open is LLM-tool only", () => {
    expect(parseSlashCommand("/1on1 open")).toEqual({ kind: "one-on-one", action: "on", scope: "" });
  });
  it("/1on1 lock → lock", () => {
    expect(parseSlashCommand("/1on1 lock")).toEqual({ kind: "one-on-one", action: "lock" });
  });
  it("non-slash is null", () => {
    expect(parseSlashCommand("1on1")).toBeNull();
  });
  it("/1on1 status (and guests) → status", () => {
    expect(parseSlashCommand("/1on1 status")).toEqual({ kind: "one-on-one", action: "status" });
    expect(parseSlashCommand("/1on1 guests")).toEqual({ kind: "one-on-one", action: "status" });
  });
  it("/1on1 invite collects every mention once, with or without a display name", () => {
    expect(parseSlashCommand("/1on1 invite <@U0QA> <@U0REV|rev> <@U0QA>")).toEqual({
      kind: "one-on-one",
      action: "invite",
      users: ["U0QA", "U0REV"],
    });
  });
  it("/1on1 kick <@x> → kick; no mention → empty list (handler shows usage)", () => {
    expect(parseSlashCommand("/1on1 kick <@W0QA>")).toEqual({ kind: "one-on-one", action: "kick", users: ["W0QA"] });
    expect(parseSlashCommand("/1on1 invite")).toEqual({ kind: "one-on-one", action: "invite", users: [] });
    expect(parseSlashCommand("/1on1 invite qa-person")).toEqual({ kind: "one-on-one", action: "invite", users: [] });
  });
  it("help lists invite/kick/status", () => {
    const h = helpText();
    expect(h).toContain("/1on1 invite|kick @user");
    expect(h).toContain("/1on1 [lock | off | status]");
  });
});

describe("guestMayRun", () => {
  const ok = (text: string) => guestMayRun(parseSlashCommand(text) as SlashHit);
  it("help, /abort, /link and /1on1 status only", () => {
    expect(ok("/help")).toBe(true);
    expect(ok("/mode")).toBe(true); // mode-help: text only
    expect(ok("/abort")).toBe(true);
    expect(ok("/link")).toBe(true);
    expect(ok("/1on1 status")).toBe(true);
  });
  it("anything that changes the thread stays with the owner", () => {
    for (const t of ["/1on1", "/1on1 off", "/1on1 lock", "/1on1 invite <@U0X>", "/1on1 kick <@U0X>", "/mode bypass",
      "/mention-only", "/remote off", "/mcp connect x", "/cron-list", "/compact", "/model", "/bash ls", "/ignore-thread"]) {
      expect(ok(t)).toBe(false);
    }
  });
});

