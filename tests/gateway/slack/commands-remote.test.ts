import { describe, it, expect } from "bun:test";
import { parseSlashCommand, AGENT_COMMANDS } from "../../../src/gateway/slack/commands";

describe("/remote parsing", () => {
  it("bare → status", () => expect(parseSlashCommand("/remote")).toEqual({ kind: "remote", action: "status" }));
  it("off / key / status", () => {
    expect(parseSlashCommand("/remote off")).toEqual({ kind: "remote", action: "off" });
    expect(parseSlashCommand("/remote key")).toEqual({ kind: "remote", action: "key" });
    expect(parseSlashCommand("/remote status")).toEqual({ kind: "remote", action: "status" });
  });
  it("addr + dir (dir may contain spaces), case preserved", () => {
    expect(parseSlashCommand("/remote tcAbC_9 /Users/x/My Repo")).toEqual({ kind: "remote", action: "on", addr: "tcAbC_9", dir: "/Users/x/My Repo" });
  });
  it("addr alone keeps the stored dir", () => {
    expect(parseSlashCommand("/remote tcAbC_9")).toEqual({ kind: "remote", action: "on", addr: "tcAbC_9" });
  });
  it("is listed in help", () => {
    expect(AGENT_COMMANDS.map((c) => c.usage).join(" ")).toContain("/remote");
  });
});
