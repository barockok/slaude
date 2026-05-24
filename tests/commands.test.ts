import { describe, expect, test } from "bun:test";
import {
  parseSlashCommand,
  helpText,
  humanModeName,
  MODE_ALIASES,
  MODE_LABELS,
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
});

  test("parses /ingest with no args", () => {
    expect(parseSlashCommand("/ingest")).toEqual({ kind: "ingest" });
  });

  test("parses /ingest with whitespace, ignores junk args", () => {
    expect(parseSlashCommand("/ingest  whatever")).toEqual({ kind: "ingest" });
  });

  test("/help mentions /ingest", () => {
    expect(helpText()).toContain("/ingest");
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
