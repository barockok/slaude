import { describe, it, expect } from "bun:test";
import { parseSlashCommand } from "../../../src/gateway/slack/commands";

describe("/1on1 parsing", () => {
  it("bare /1on1 → on", () => {
    expect(parseSlashCommand("/1on1")).toEqual({ kind: "one-on-one", action: "on" });
  });
  it("/1on1 on → on", () => {
    expect(parseSlashCommand("/1on1 on")).toEqual({ kind: "one-on-one", action: "on" });
  });
  it("/1on1 off → off", () => {
    expect(parseSlashCommand("/1on1 off")).toEqual({ kind: "one-on-one", action: "off" });
  });
  it("non-slash is null", () => {
    expect(parseSlashCommand("1on1")).toBeNull();
  });
});
