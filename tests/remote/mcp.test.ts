import { describe, it, expect } from "bun:test";
import {
  REMOTE_TOOL_ALIASES, builtinFor, remotePermission, denyLocalBuiltins, makeRemoteCanUseTool, createRemoteMcp, REMOTE_MCP_NAME,
} from "../../src/remote/mcp";
import { RemoteError } from "../../src/remote/types";
import { localExec } from "./local-exec";

const sig = { signal: new AbortController().signal } as any;

describe("aliases", () => {
  it("routes the six built-ins to mcp__remote__*", () => {
    expect(REMOTE_TOOL_ALIASES).toEqual({
      Bash: "mcp__remote__bash", Read: "mcp__remote__read", Write: "mcp__remote__write",
      Edit: "mcp__remote__edit", Glob: "mcp__remote__glob", Grep: "mcp__remote__grep",
    });
  });
});

describe("remotePermission — parity with how the SDK treats each built-in", () => {
  const cases: Array<[string, string, "allow" | "ask" | null]> = [
    ["mcp__remote__read", "default", "allow"],
    ["mcp__remote__glob", "default", "allow"],
    ["mcp__remote__grep", "default", "allow"],
    ["mcp__remote__bash_output", "default", "allow"],
    ["mcp__remote__write", "default", "ask"],
    ["mcp__remote__edit", "default", "ask"],
    ["mcp__remote__write", "acceptEdits", "allow"],
    ["mcp__remote__edit", "acceptEdits", "allow"],
    ["mcp__remote__bash", "default", "ask"],
    ["mcp__remote__bash", "acceptEdits", "ask"],
    ["mcp__remote__bash_kill", "default", "ask"],
    ["mcp__remote__bash", "bypassPermissions", "allow"],
    ["mcp__remote__write", "plan", "deny"],
    ["mcp__remote__edit", "plan", "deny"],
    ["mcp__remote__bash", "plan", "deny"],
    ["mcp__remote__bash_kill", "plan", "deny"],
    ["mcp__remote__read", "plan", "allow"],
    ["mcp__slaude_kb__search", "default", null],
    ["Bash", "default", null],
  ];
  for (const [tool, mode, want] of cases as Array<[string, string, "allow" | "ask" | "deny" | null]>) {
    it(`${tool} in ${mode} → ${want}`, () => expect(remotePermission(tool, mode)).toBe(want));
  }
  it("builtinFor maps remote tools to the built-in an approver recognises", () => {
    expect(builtinFor("mcp__remote__bash")).toBe("Bash");
    expect(builtinFor("mcp__remote__bash_kill")).toBe("Bash");
    expect(builtinFor("mcp__remote__edit")).toBe("Edit");
    expect(builtinFor("mcp__other__x")).toBeNull();
  });
});

describe("makeRemoteCanUseTool", () => {
  it("allows read-only remote tools without asking, asks the base resolver under the built-in name otherwise", async () => {
    const asked: string[] = [];
    const base = async (name: string, input: any) => { asked.push(name); return { behavior: "allow", updatedInput: input } as any; };
    const can = makeRemoteCanUseTool(base as any, () => "default");
    expect((await can("mcp__remote__read", { file_path: "a" }, sig)).behavior).toBe("allow");
    await can("mcp__remote__bash", { command: "ls" }, sig);
    await can("mcp__slaude_kb__search", {}, sig);
    expect(asked).toEqual(["Bash", "mcp__slaude_kb__search"]);
  });
  it("denies an ask when there is no resolver", async () => {
    const can = makeRemoteCanUseTool(undefined, () => "default");
    expect((await can("mcp__remote__bash", { command: "ls" }, sig)).behavior).toBe("deny");
  });
  it("plan mode denies remote changes without asking anyone", async () => {
    const asked: string[] = [];
    const can = makeRemoteCanUseTool((async (n: string, input: any) => { asked.push(n); return { behavior: "allow", updatedInput: input }; }) as any, () => "plan");
    expect((await can("mcp__remote__write", { file_path: "a", content: "" }, sig)).behavior).toBe("deny");
    expect(asked).toEqual([]);
  });
});

describe("gating parity with the real permission policy (spec §9)", () => {
  // The gateway and node both gate with permissionPolicy (src/gateway/slack/permission-gate.ts);
  // remote tools must get exactly the decision their built-in gets, incl. SLAUDE_AUTO_ALLOW_TOOLS.
  const { permissionPolicy } = require("../../src/gateway/slack/permission-gate");
  const inputs: Record<string, any> = {
    Bash: { command: "ls -la" }, Write: { file_path: "/r/a", content: "x" }, Edit: { file_path: "/r/a", old_string: "a", new_string: "b" },
  };
  for (const autoAllow of [new Set<string>(), new Set(["Bash", "Write", "Edit"])]) {
    for (const builtin of ["Bash", "Write", "Edit"]) {
      it(`${builtin} with autoAllow=[${[...autoAllow]}] → same decision remotely`, async () => {
        const base = async (name: string, input: any) =>
          permissionPolicy(name, input, autoAllow) ?? { behavior: "deny", message: "APPROVAL_CARD" };
        const can = makeRemoteCanUseTool(base as any, () => "default");
        const local = await base(builtin, inputs[builtin]);
        const remote = await can(REMOTE_TOOL_ALIASES[builtin]!, inputs[builtin], sig);
        expect(remote.behavior).toBe(local.behavior);
      });
    }
  }
});

describe("denyLocalBuiltins", () => {
  it("denies a local built-in and lets aliased (post-alias) names through", async () => {
    const d = await denyLocalBuiltins({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} } as any, "t1", sig);
    expect((d as any).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await denyLocalBuiltins({ hook_event_name: "PreToolUse", tool_name: "mcp__remote__bash", tool_input: {} } as any, "t1", sig)).toEqual({});
    expect(await denyLocalBuiltins({ hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: {} } as any, "t1", sig)).toEqual({});
  });
});

describe("createRemoteMcp", () => {
  it("registers eight tools under the remote server name", () => {
    const s = createRemoteMcp({ exec: localExec, root: "/tmp", sessionKey: "k" });
    expect(s.name).toBe(REMOTE_MCP_NAME);
    const names = Object.keys((s.instance as any)._registeredTools ?? {});
    expect(names.sort()).toEqual(["bash", "bash_kill", "bash_output", "edit", "glob", "grep", "read", "write"]);
  });
  it("turns a transport failure into a tool error with guidance, never a throw", async () => {
    const dead = async () => { throw new RemoteError("REMOTE_UNREACHABLE", "connection closed"); };
    const s = createRemoteMcp({ exec: dead, root: "/tmp", sessionKey: "k" });
    const tool = (s.instance as any)._registeredTools.bash;
    const r = await tool.handler({ command: "ls" }, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("REMOTE_UNREACHABLE");
    expect(r.content[0].text).toContain("tell the user");
    expect(r.content[0].text).toContain("/remote <new-address>");
  });
  it("audit line carries the exit code and never the command args; exitCode is not returned to the SDK", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: string) => { lines.push(String(m)); };
    try {
      const s = createRemoteMcp({ exec: localExec, root: "/tmp", sessionKey: "k" });
      const r = await (s.instance as any)._registeredTools.bash.handler({ command: "sh -c 'exit 3' --secret-token=abc" }, {});
      expect(r.exitCode).toBeUndefined();
    } finally { console.log = orig; }
    const line = lines.find((l) => l.startsWith("[remote] tool=bash"))!;
    expect(line).toContain("subject=sh");
    expect(line).toContain("code=3");
    expect(line).not.toContain("secret-token");
  });
});
