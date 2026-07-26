import { describe, test, expect } from "bun:test";
import { parseSlashCommand } from "../../../src/gateway/slack/commands";

describe("parseSlashCommand /bash", () => {
  test("plain text single word", () => {
    expect(parseSlashCommand("/bash whoami")).toEqual({ kind: "bash", command: "whoami" });
  });

  test("plain text multi-word", () => {
    expect(parseSlashCommand("/bash ls -la /tmp")).toEqual({ kind: "bash", command: "ls -la /tmp" });
  });

  test("backtick-wrapped single word", () => {
    expect(parseSlashCommand("/bash `whoami`")).toEqual({ kind: "bash", command: "whoami" });
  });

  test("backtick-wrapped multi-word", () => {
    expect(parseSlashCommand("/bash `curl -v http://example.com`")).toEqual({
      kind: "bash",
      command: "curl -v http://example.com",
    });
  });

  test("triple-backtick inline", () => {
    expect(parseSlashCommand("/bash ```whoami```")).toEqual({ kind: "bash", command: "whoami" });
  });

  test("triple-backtick with newlines", () => {
    expect(parseSlashCommand("/bash ```\ncurl -v http://example.com\n```")).toEqual({
      kind: "bash",
      command: "curl -v http://example.com",
    });
  });

  test("triple-backtick with language specifier line", () => {
    expect(parseSlashCommand("/bash ```bash\ncurl -v http://example.com\n```")).toEqual({
      kind: "bash",
      command: "curl -v http://example.com",
    });
  });

  test("empty command → null", () => {
    expect(parseSlashCommand("/bash")).toBeNull();
  });

  test("whitespace-only after /bash → null", () => {
    expect(parseSlashCommand("/bash   ")).toBeNull();
  });

  test("preserves case in command", () => {
    const result = parseSlashCommand("/bash echo Hello World");
    expect(result).toEqual({ kind: "bash", command: "echo Hello World" });
  });

  test("command with pipes and redirects", () => {
    expect(parseSlashCommand("/bash cat /etc/hostname | tr -d '\\n'")).toEqual({
      kind: "bash",
      command: "cat /etc/hostname | tr -d '\\n'",
    });
  });
});
