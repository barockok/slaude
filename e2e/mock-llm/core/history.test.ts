import { describe, expect, test } from "bun:test";
import { viewHistory } from "./history";
import type { MockRequest } from "./types";

describe("viewHistory", () => {
  test("no tool results yet", () => {
    const req: MockRequest = { messages: [{ role: "user", content: "[[mock:multi-tool]] go" }] };
    expect(viewHistory(req, 0)).toEqual({ toolResults: [], persona: null, tools: [] });
  });

  test("collects role:tool results after the tagged message", () => {
    const req: MockRequest = {
      messages: [
        { role: "user", content: "[[mock:multi-tool n=2]] go" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", function: { name: "Bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "step-1" },
      ],
    };
    expect(viewHistory(req, 0).toolResults).toEqual(["step-1"]);
  });

  test("also counts tool_result parts inside user messages", () => {
    const req: MockRequest = {
      messages: [
        { role: "user", content: "[[mock:multi-tool]] go" },
        { role: "assistant", content: null },
        { role: "user", content: [{ type: "tool_result", text: "step-1" }] },
      ],
    };
    expect(viewHistory(req, 0).toolResults).toEqual(["step-1"]);
  });

  test("ignores tool results from before the current turn's tagged message", () => {
    const req: MockRequest = {
      messages: [
        { role: "user", content: "[[mock:multi-tool n=1]] one" },
        { role: "tool", tool_call_id: "t1", content: "old" },
        { role: "assistant", content: "done" },
        { role: "user", content: "[[mock:multi-tool n=1]] two" },
      ],
    };
    expect(viewHistory(req, 3).toolResults).toEqual([]);
  });

  test("reads the persona marker from the system prompt", () => {
    const req: MockRequest = {
      messages: [
        { role: "system", content: "You are helpful.\nPersona-ID: alpha_1\nBe brief." },
        { role: "user", content: "[[mock:echo]] hi" },
      ],
    };
    expect(viewHistory(req, 1).persona).toBe("alpha_1");
  });

  test("reads the persona marker from system parts arrays", () => {
    const req: MockRequest = {
      messages: [
        { role: "system", content: [{ type: "text", text: "x" }, { type: "text", text: "Persona-ID: beta" }] },
        { role: "user", content: "[[mock:echo]] hi" },
      ],
    };
    expect(viewHistory(req, 1).persona).toBe("beta");
  });
});
