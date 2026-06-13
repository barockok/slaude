import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDmChannel,
  isTrustedSession,
  pathWithinWorkspace,
  jailDecision,
} from "../src/agent/jail";
import type { SessionRow } from "../src/db/schema";
import type { SoulData } from "../src/soul/data";

const soul = {
  manager: { userId: "MGR" },
  backupManager: { userId: "BAK" },
} as unknown as SoulData;

function row(over: Partial<SessionRow>): SessionRow {
  return {
    id: "s", created_at: 0, updated_at: 0, title: null, model: "m",
    working_dir: "/ws", status: "idle", claude_started: 0,
    slack_team_id: "T", slack_channel_id: "D1", slack_thread_ts: "1",
    permission_mode: "default", engaged: 1, dm_user_id: null, ...over,
  };
}

describe("isDmChannel", () => {
  test("D-prefixed is DM", () => expect(isDmChannel("D123")).toBe(true));
  test("channel/group are not", () => {
    expect(isDmChannel("C123")).toBe(false);
    expect(isDmChannel("G123")).toBe(false);
    expect(isDmChannel(null)).toBe(false);
  });
});

describe("isTrustedSession", () => {
  test("manager DM trusted", () =>
    expect(isTrustedSession(row({ dm_user_id: "MGR" }), soul)).toBe(true));
  test("backup DM trusted", () =>
    expect(isTrustedSession(row({ dm_user_id: "BAK" }), soul)).toBe(true));
  test("stranger DM not trusted", () =>
    expect(isTrustedSession(row({ dm_user_id: "X" }), soul)).toBe(false));
  test("manager in a channel (not DM) not trusted", () =>
    expect(isTrustedSession(row({ slack_channel_id: "C1", dm_user_id: "MGR" }), soul)).toBe(false));
  test("missing dm_user_id not trusted", () =>
    expect(isTrustedSession(row({ dm_user_id: null }), soul)).toBe(false));
});

describe("pathWithinWorkspace", () => {
  let ws: string;
  let outside: string;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "jail-"));
    ws = join(base, "ws");
    outside = join(base, "outside");
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(ws, "escape"));
  });
  test("in-tree path allowed", () =>
    expect(pathWithinWorkspace(join(ws, "a/b.txt"), ws)).toBe(true));
  test("new file in tree allowed", () =>
    expect(pathWithinWorkspace(join(ws, "new.txt"), ws)).toBe(true));
  test("absolute outside denied", () =>
    expect(pathWithinWorkspace(outside + "/x", ws)).toBe(false));
  test(".. escape denied", () =>
    expect(pathWithinWorkspace(join(ws, "../outside/x"), ws)).toBe(false));
  test("symlink escape denied", () =>
    expect(pathWithinWorkspace(join(ws, "escape/x"), ws)).toBe(false));
});

describe("jailDecision", () => {
  const root = "/ws";
  test("off mode: never denies", () =>
    expect(jailDecision({ mode: "off", jailed: true, toolName: "Read", input: { file_path: "/etc/passwd" }, root })).toBeNull());
  test("trusted (jailed=false): never denies", () =>
    expect(jailDecision({ mode: "adversarial", jailed: false, toolName: "Read", input: { file_path: "/etc/passwd" }, root })).toBeNull());
  test("discipline denies out-of-tree Read", () => {
    const d = jailDecision({ mode: "discipline", jailed: true, toolName: "Read", input: { file_path: "/etc/passwd" }, root });
    expect(d?.behavior).toBe("deny");
  });
  test("discipline allows in-tree Write", () =>
    expect(jailDecision({ mode: "discipline", jailed: true, toolName: "Write", input: { file_path: "/ws/a.txt" }, root })).toBeNull());
  test("discipline denies bash escape", () => {
    const d = jailDecision({ mode: "discipline", jailed: true, toolName: "Bash", input: { command: "cat /etc/passwd" }, root });
    expect(d?.behavior).toBe("deny");
  });
  test("discipline allows in-tree bash", () =>
    expect(jailDecision({ mode: "discipline", jailed: true, toolName: "Bash", input: { command: "ls ." }, root })).toBeNull());
  test("adversarial ignores bash (OS sandbox owns it)", () =>
    expect(jailDecision({ mode: "adversarial", jailed: true, toolName: "Bash", input: { command: "cat /etc/passwd" }, root })).toBeNull());
  test("non-fs tool ignored", () =>
    expect(jailDecision({ mode: "discipline", jailed: true, toolName: "mcp__x__y", input: {}, root })).toBeNull());
});
