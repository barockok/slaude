import { describe, expect, test } from "bun:test";
import { TurnSenderLog } from "../../../src/gateway/core/turn-senders";

describe("TurnSenderLog", () => {
  test("records each delivered sender once, per session, until the turn ends", () => {
    const log = new TurnSenderLog();
    expect(log.get("s1")).toBeNull();
    log.note("s1", { userId: "U0ALICE", teamId: "T", origin: "slack" });
    log.note("s1", { userId: "U0ALICE", teamId: "T", origin: "slack" });
    log.note("s1", { userId: "U0ALICE", teamId: "T", origin: "cron" });
    log.note("s2", { userId: "U0BOB", teamId: "", origin: undefined });
    log.note("s2", { userId: undefined, teamId: "T", origin: "slack" });
    expect(log.get("s1")).toEqual([{ userId: "U0ALICE", teamId: "T", origin: "slack" }, { userId: "U0ALICE", teamId: "T", origin: "cron" }]);
    expect(log.get("s2")).toEqual([{ userId: "U0BOB", teamId: null, origin: null }]);
    log.end("s1");
    expect(log.get("s1")).toBeNull();
    expect(log.get("s2")).not.toBeNull();
  });
});
