import { describe, it, expect } from "bun:test";
import { parseSlashCommand } from "../../../src/gateway/slack/commands";

describe("parseSlashCommand /mcp", () => {
  it("/mcp → status", () => {
    expect(parseSlashCommand("/mcp")).toEqual({ kind: "mcp", action: "status" });
  });
  it("/mcp connect <server> → connect with server", () => {
    expect(parseSlashCommand("/mcp connect workbench")).toEqual({ kind: "mcp", action: "connect", server: "workbench" });
  });
  it("/mcp connect (no server) → connect, server undefined", () => {
    expect(parseSlashCommand("/mcp connect")).toEqual({ kind: "mcp", action: "connect", server: undefined });
  });
});
