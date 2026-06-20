import { describe, expect, test, beforeEach } from "bun:test";
import * as MentionOnly from "../src/db/mention-only";
import { parseSlashCommand } from "../src/gateway/slack/commands";

beforeEach(() => MentionOnly._wipeForTests());

describe("mention-only db", () => {
  test("set → find; clear → gone; set is an upsert", () => {
    expect(MentionOnly.find("C1", "1.0")).toBeNull();
    MentionOnly.set({ channelId: "C1", threadTs: "1.0", createdBy: "U1" });
    expect(MentionOnly.find("C1", "1.0")?.created_by).toBe("U1");
    MentionOnly.set({ channelId: "C1", threadTs: "1.0", createdBy: "U2" });
    expect(MentionOnly.find("C1", "1.0")?.created_by).toBe("U2");
    MentionOnly.clear("C1", "1.0");
    expect(MentionOnly.find("C1", "1.0")).toBeNull();
  });
});

describe("/mention-only parse", () => {
  test("on / off", () => {
    expect(parseSlashCommand("/mention-only")).toEqual({ kind: "mention-only", action: "on" });
    expect(parseSlashCommand("/mention-only off")).toEqual({ kind: "mention-only", action: "off" });
  });
});

