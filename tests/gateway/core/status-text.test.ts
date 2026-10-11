import { describe, it, expect } from "bun:test";
import { humanizeToolStatus } from "../../../src/gateway/core/status-text";

describe("humanizeToolStatus", () => {
  it("appends a remote marker without leaking args", () => {
    expect(humanizeToolStatus("Bash", { command: "curl -H 'Authorization: x' https://a" }, { remote: true })).toBe("running `curl` (remote)");
  });

  it("renders remote tools like their built-ins, marked (remote) exactly once", () => {
    const cases: Array<[string, any, string]> = [
      ["mcp__remote__bash", { command: "/usr/bin/git status" }, "running `git` (remote)"],
      ["mcp__remote__read", { file_path: "/home/a/secret-dir/notes.md" }, "reading notes.md (remote)"],
      ["mcp__remote__write", { file_path: "/home/a/x/out.txt" }, "writing out.txt (remote)"],
      ["mcp__remote__edit", { file_path: "/home/a/x/app.ts" }, "editing app.ts (remote)"],
      ["mcp__remote__glob", { pattern: "**/*.ts" }, "finding files (**/*.ts) (remote)"],
      ["mcp__remote__grep", { pattern: "TODO" }, 'searching for "TODO" (remote)'],
      ["mcp__remote__bash_output", { bash_id: "b1" }, "checking background job (remote)"],
      ["mcp__remote__bash_kill", { shell_id: "b1" }, "stopping background job (remote)"],
    ];
    for (const [tool, input, want] of cases) {
      expect(humanizeToolStatus(tool, input, { remote: true })).toBe(want);
      expect(humanizeToolStatus(tool, input)).toBe(want);
    }
  });

  it("never shows a leading NAME=secret assignment, local or remote", () => {
    for (const tool of ["Bash", "mcp__remote__bash"]) {
      const out = humanizeToolStatus(tool, { command: "GITHUB_TOKEN=ghp_abc123 git push" });
      expect(out).toContain("running `git`");
      expect(out).not.toContain("ghp_abc123");
      expect(out).not.toContain("GITHUB_TOKEN");
    }
  });

  it("an assignment it cannot read safely renders generically", () => {
    const out = humanizeToolStatus("Bash", { command: "PASS='a b' deploy" });
    expect(out).toBe("running command");
  });

  it("voice_start shows only its name, never the capability URLs in its args", () => {
    const out = humanizeToolStatus("mcp__slaude_voice__voice_start", {
      brief: "standup",
      audio: { stream_url: "https://wb.example.com/api/browser/audio/cap-SEC/stream", clear_url: "/api/browser/audio/cap-SEC/clear", headers: { "X-Browser-Session": "rk" } },
    });
    expect(out).toBe("running voice_start (slaude_voice)");
    expect(out).not.toContain("cap-SEC");
  });
});
