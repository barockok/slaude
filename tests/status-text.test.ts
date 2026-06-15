import { describe, expect, test } from "bun:test";
import { humanizeToolStatus, redactSecrets, shortPath } from "../src/gateway/core/status-text";

// The status string is broadcast to Slack — these tests pin the security
// invariant: it must never carry a secret, a raw command, or an absolute path.

describe("shortPath", () => {
  test("absolute path → basename only (no directory structure)", () => {
    expect(shortPath("/data/oauth/U0XXXXXXXXX/projects/x/memory/note.md")).toBe("note.md");
    expect(shortPath("/etc/passwd")).toBe("passwd");
  });
  test("relative path → tail segments (already workspace-scoped)", () => {
    expect(shortPath("src/knowledge/gather.ts")).toBe("knowledge/gather.ts");
    expect(shortPath("file.ts")).toBe("file.ts");
  });
  test("empty/undefined → empty string", () => {
    expect(shortPath(undefined)).toBe("");
    expect(shortPath("")).toBe("");
  });
});

describe("redactSecrets", () => {
  const cases: Array<[string, RegExp]> = [
    ['curl -H "Authorization: Bearer sk-abc123def456ghi789"', /Authorization/i],
    ["export GITHUB_TOKEN=ghp_AbCdEf0123456789AbCdEf0123456789", /ghp_AbCd/],
    ["psql --password=hunter2supersecret", /hunter2/],
    ["slack xoxb-123456789012-abcdefghijkl", /xoxb-123/],
    ["aws AKIAIOSFODNN7EXAMPLE", /AKIAIOSF/],
    ["google AIzaSyD-1234567890abcdefghijklmnopqrstu", /AIzaSyD/],
    ["jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", /eyJhbGci/],
  ];
  for (const [raw, leaked] of cases) {
    test(`masks: ${raw.slice(0, 28)}…`, () => {
      const out = redactSecrets(raw);
      expect(out).toContain("••••");
      expect(out).not.toMatch(leaked);
    });
  }
  test("leaves benign text untouched", () => {
    expect(redactSecrets("running `git`")).toBe("running `git`");
    expect(redactSecrets("reading gather.ts")).toBe("reading gather.ts");
  });
});

describe("humanizeToolStatus — Bash never leaks args", () => {
  test("shows program name only, drops the rest of the command", () => {
    expect(humanizeToolStatus("Bash", { command: 'curl -H "Authorization: Bearer sk-secret123456" https://x' }))
      .toBe("running `curl`");
    expect(humanizeToolStatus("Bash", { command: "find /data/oauth/U06/projects /tmp -maxdepth 3" }))
      .toBe("running `find`");
    expect(humanizeToolStatus("Bash", { command: "TOKEN=ghp_abc123def456ghi789jkl git push" }))
      // first token is the env assignment; redaction net catches the secret in it
      .not.toContain("ghp_");
  });
  test("strips a path prefix on the binary", () => {
    expect(humanizeToolStatus("Bash", { command: "/usr/local/bin/psql --password=topsecret123" }))
      .toBe("running `psql`");
  });
  test("empty command → generic", () => {
    expect(humanizeToolStatus("Bash", { command: "" })).toBe("running command");
  });
});

describe("humanizeToolStatus — paths and urls", () => {
  test("file tools show basename, never absolute path", () => {
    const s = humanizeToolStatus("Read", { file_path: "/data/oauth/U06/secret-dir/creds.md" });
    expect(s).toBe("reading creds.md");
    expect(s).not.toContain("/");
  });
  test("WebFetch shows host only — drops path/query (api keys)", () => {
    expect(humanizeToolStatus("WebFetch", { url: "https://api.example.com/v1/x?api_key=sk-leak12345678" }))
      .toBe("fetching api.example.com");
  });
});

describe("humanizeToolStatus — every branch renders a safe label", () => {
  const cases: Array<[string, any, string]> = [
    ["Read", { file_path: "a/b/c.ts" }, "reading b/c.ts"],
    ["Write", { file_path: "/x/y/out.ts" }, "writing out.ts"],
    ["Edit", { file_path: "a/b/c.ts" }, "editing b/c.ts"],
    ["MultiEdit", { file_path: "a/b/c.ts" }, "editing b/c.ts"],
    ["NotebookEdit", {}, "editing notebook"],
    ["Grep", { pattern: "needle" }, 'searching for "needle"'],
    ["Glob", { pattern: "*.ts" }, "finding files (*.ts)"],
    ["LS", { path: "/x/y/dir" }, "listing dir"],
    ["TodoWrite", {}, "updating todos"],
    ["WebSearch", { query: "weather" }, 'searching web: "weather"'],
    ["Task", {}, "delegating to subagent"],
    ["mcp__slaude_surface__reply", {}, "replying"],
    ["mcp__slaude_slack__reply", {}, "replying"],
    ["mcp__slaude_surface__edit", {}, "editing reply"],
    ["mcp__slaude_surface__upload", { path: "/x/y/f.png" }, "uploading f.png"],
    ["mcp__slaude_surface__react", { name: "tada" }, "reacting :tada:"],
    ["mcp__slaude_surface__unreact", { name: "x" }, "reacting :x:"],
    ["mcp__slaude_surface__request_approval", {}, "requesting approval"],
    ["mcp__slaude_surface__get_history", {}, "reading conversation history"],
    ["mcp__slaude_slack__get_user_profile", {}, "fetching user profile"],
    ["mcp__slaude_slack__get_channel_info", {}, "fetching channel info"],
    ["mcp__slaude_slack__get_thread_history", {}, "reading thread history"],
    ["mcp__slaude_slack__list_users_in_channel", {}, "listing channel members"],
    ["mcp__slaude_slack__search_messages", {}, "searching messages"],
    ["mcp__grafana__query_loki_logs", {}, "running query_loki_logs (grafana)"],
    ["SomeUnknownTool", {}, "running SomeUnknownTool"],
  ];
  for (const [tool, input, expected] of cases) {
    test(`${tool} → ${expected}`, () => {
      expect(humanizeToolStatus(tool, input)).toBe(expected);
    });
  }
  test("WebFetch with empty/invalid url → generic (urlHost catch)", () => {
    expect(humanizeToolStatus("WebFetch", { url: "not a url" })).toBe("fetching url");
    expect(humanizeToolStatus("WebFetch", {})).toBe("fetching url");
  });
  test("react with missing name → '?'", () => {
    expect(humanizeToolStatus("mcp__slaude_surface__react", {})).toBe("reacting :?:");
  });
});
