import { describe, expect, test } from "bun:test";
import {
  parseSlashCommand,
  helpText,
  humanModeName,
  MODE_ALIASES,
  MODE_LABELS,
  AGENT_COMMANDS,
} from "../src/gateway/slack/commands";

describe("parseSlashCommand", () => {
  test("non-slash → null", () => {
    expect(parseSlashCommand("hi")).toBeNull();
  });
  test("/mode w/o arg → mode-help", () => {
    expect(parseSlashCommand("/mode")).toEqual({ kind: "mode-help" });
  });
  test("/mode unknown → mode-help", () => {
    expect(parseSlashCommand("/mode wat")).toEqual({ kind: "mode-help" });
  });
  test.each([
    ["ask", "default"],
    ["bypass", "bypassPermissions"],
    ["yolo", "bypassPermissions"],
    ["accept-edits", "acceptEdits"],
    ["edits", "acceptEdits"],
    ["plan", "plan"],
    ["dont-ask", "dontAsk"],
    ["deny", "dontAsk"],
  ])("/mode %s → %s", (alias, mode) => {
    expect(parseSlashCommand(`/mode ${alias}`)).toEqual({ kind: "mode", mode: mode as any });
  });
  test("/abort variants", () => {
    for (const v of ["/abort", "/stop", "/cancel"]) {
      expect(parseSlashCommand(v)).toEqual({ kind: "abort" });
    }
  });
  test("help variants", () => {
    for (const v of ["/help", "/h", "/?"]) {
      expect(parseSlashCommand(v)).toEqual({ kind: "help" });
    }
  });
  test("unknown command → null", () => {
    expect(parseSlashCommand("/wat")).toBeNull();
  });
  test("/model with no arg → list", () => {
    expect(parseSlashCommand("/model")).toEqual({ kind: "model" });
  });
  test("/model <id> → set", () => {
    expect(parseSlashCommand("/model claude-opus-4-8")).toEqual({
      kind: "model",
      id: "claude-opus-4-8",
    });
  });
  test("/model keeps only the first token", () => {
    expect(parseSlashCommand("/model claude-opus-4-8 extra")).toEqual({
      kind: "model",
      id: "claude-opus-4-8",
    });
  });
});

describe("helpText", () => {
  test("renders all known modes", () => {
    const t = helpText();
    expect(t).toContain("/mode");
    expect(t).toContain("/abort");
    for (const label of Object.values(MODE_LABELS)) {
      expect(t).toContain(label);
    }
  });

  test("AGENT_COMMANDS is the single source — every usage appears in helpText", () => {
    const t = helpText();
    expect(AGENT_COMMANDS.length).toBeGreaterThan(5);
    for (const c of AGENT_COMMANDS) expect(t).toContain(c.usage);
  });

  test("AGENT_COMMANDS covers the thread/ignore gate commands", () => {
    const usages = AGENT_COMMANDS.map((c) => c.usage).join(" ");
    for (const name of ["/1on1", "/ignore-thread", "/unignore-thread", "/mode", "/abort"]) {
      expect(usages).toContain(name);
    }
  });

  test("commands render in a fenced code block with summaries aligned to one column", () => {
    const t = helpText();
    expect(t).toContain("```");
    const gutter = Math.max(...AGENT_COMMANDS.map((c) => c.usage.length)) + 2;
    for (const c of AGENT_COMMANDS) {
      expect(t).toContain(c.usage.padEnd(gutter) + c.summary);
    }
  });
});

  test("parses /ingest with no args", () => {
    expect(parseSlashCommand("/ingest")).toEqual({ kind: "ingest" });
  });

  test("parses /ingest with whitespace, ignores junk args", () => {
    expect(parseSlashCommand("/ingest  whatever")).toEqual({ kind: "ingest" });
  });

  test("/help no longer lists /ingest (deprecated — use brain memoize)", () => {
    expect(helpText()).not.toContain("/ingest");
  });

describe("humanModeName", () => {
  test("round-trips through aliases", () => {
    for (const m of Object.values(MODE_LABELS).map((_, i) => Object.keys(MODE_LABELS)[i] as any)) {
      const human = humanModeName(m);
      expect(MODE_ALIASES[human]).toBe(m);
    }
  });
});

describe("ignore commands", () => {
  test("/ignore @U123 10m", () => {
    expect(parseSlashCommand("/ignore <@U123> 10m")).toEqual({
      kind: "ignore",
      target: "user",
      userId: "U123",
      duration: "10m",
    });
  });

  test("/ignore @U123 (permanent)", () => {
    expect(parseSlashCommand("/ignore <@U123>")).toEqual({
      kind: "ignore",
      target: "user",
      userId: "U123",
      duration: null,
    });
  });

  test("/ignore-thread 5m", () => {
    expect(parseSlashCommand("/ignore-thread 5m")).toEqual({
      kind: "ignore",
      target: "thread",
      duration: "5m",
    });
  });

  test("/ignore-thread (permanent)", () => {
    expect(parseSlashCommand("/ignore-thread")).toEqual({
      kind: "ignore",
      target: "thread",
      duration: null,
    });
  });

  test("/unignore @U123", () => {
    expect(parseSlashCommand("/unignore <@U123>")).toEqual({
      kind: "unignore",
      target: "user",
      userId: "U123",
    });
  });

  test("/unignore-thread", () => {
    expect(parseSlashCommand("/unignore-thread")).toEqual({
      kind: "unignore",
      target: "thread",
    });
  });
});

describe("cron commands", () => {
  test("/cron-list", () => {
    expect(parseSlashCommand("/cron-list")).toEqual({ kind: "cron-list" });
  });

  test("/cron-add with bad format → null", () => {
    expect(parseSlashCommand("/cron-add expr prompt")).toBeNull();
    expect(parseSlashCommand('/cron-add "expr"')).toBeNull();
  });

  test("/cron-add with quoted args defaults to thread + fire", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "daily summary"')).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "daily summary",
      target: "thread",
      whenActive: "fire",
    });
  });

  test("/cron-add with channel target", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "digest" channel')).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "digest",
      target: "channel",
      whenActive: "fire",
    });
  });

  test("/cron-add with explicit thread target", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "digest" thread')).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "digest",
      target: "thread",
      whenActive: "fire",
    });
  });

  test("/cron-add with passive flag → when_active skip", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "digest" passive')).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "digest",
      target: "thread",
      whenActive: "skip",
    });
  });

  test("/cron-add with channel + passive flags together", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "digest" channel passive')).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "digest",
      target: "channel",
      whenActive: "skip",
    });
  });

  test("/cron-add with garbage trailing token → null", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "digest" bogus')).toBeNull();
  });

  test("/cron-remove without id → null", () => {
    expect(parseSlashCommand("/cron-remove")).toBeNull();
  });

  test("/cron-remove with id", () => {
    expect(parseSlashCommand("/cron-remove job-123")).toEqual({
      kind: "cron-remove",
      id: "job-123",
    });
  });
});

describe("/soul", () => {
  test("parses add/remove for all four nouns", () => {
    expect(parseSlashCommand("/soul trust add <#C0NEW|general>")).toEqual({
      kind: "soul", field: "trust", action: "add", value: "<#C0NEW|general>",
    });
    expect(parseSlashCommand("/soul allow remove C0PUB")).toEqual({
      kind: "soul", field: "allow", action: "remove", value: "C0PUB",
    });
    expect(parseSlashCommand("/soul dm add <@U0FRIEND>")).toEqual({
      kind: "soul", field: "dm", action: "add", value: "<@U0FRIEND>",
    });
    expect(parseSlashCommand("/soul block add <@U0BAD>")).toEqual({
      kind: "soul", field: "block", action: "add", value: "<@U0BAD>",
    });
  });

  test("parses list and clear", () => {
    expect(parseSlashCommand("/soul list")).toEqual({ kind: "soul-list" });
    expect(parseSlashCommand("/soul clear trust")).toEqual({ kind: "soul-clear", field: "trust" });
    expect(parseSlashCommand("/soul clear all")).toEqual({ kind: "soul-clear", field: "all" });
  });

  test("rejects malformed forms", () => {
    expect(parseSlashCommand("/soul")).toBeNull();
    expect(parseSlashCommand("/soul trust")).toBeNull();
    expect(parseSlashCommand("/soul trust add")).toBeNull();
    expect(parseSlashCommand("/soul trust drop C1")).toBeNull();
    expect(parseSlashCommand("/soul clear bogus")).toBeNull();
  });

  test("parses /mcp status, connect, disconnect", () => {
    expect(parseSlashCommand("/mcp")).toEqual({ kind: "mcp", action: "status" });
    expect(parseSlashCommand("/mcp connect workbench")).toEqual({ kind: "mcp", action: "connect", server: "workbench" });
    expect(parseSlashCommand("/mcp disconnect workbench")).toEqual({ kind: "mcp", action: "disconnect", server: "workbench" });
    expect(parseSlashCommand("/mcp DISCONNECT workbench")).toEqual({ kind: "mcp", action: "disconnect", server: "workbench" });
  });
});
