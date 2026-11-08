import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasNames, deliveryTurnAllowance, deniedMessage, guardrailFilesHook, isProtectedPath, ownerGuardrailsHook, readsKey } from "../../src/guardrails/hooks";
import { resolveDocs, sessionGuardrails, type GuardrailDoc } from "../../src/guardrails/resolve";
import type { FiringEvent } from "../../src/guardrails/audit";
import { firingAction } from "../../src/guardrails/audit";

const doc = (slug: string, front: string, body: string): GuardrailDoc => ({
  slug, md: `---\nname: ${slug}\n${front}\n---\n${body}`, source: "file", override: false, behindSource: false, enabled: true,
});
const rules = (r: string) => "```rules\n" + r + "\n```";
const pre = (tool_name: string, tool_input: unknown = {}) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/" }) as any;
const sig = { signal: new AbortController().signal };

function setup(docs: GuardrailDoc[], channel: string | null = null) {
  const g = sessionGuardrails(resolveDocs(docs), "default", channel, { version: 1, proseMax: 4000 });
  const firings: FiringEvent[][] = [];
  const delivered: string[][] = [];
  const seen = new Set<string>();
  const hook = ownerGuardrailsHook({
    guardrails: () => g,
    channel: () => channel,
    delivered: () => seen,
    onFiring: (e) => firings.push(e),
    onDelivered: (items) => delivered.push(items.map((i) => i.slug)),
  });
  return { g, hook, firings, delivered, seen };
}

describe("hook.pre-tool.owner-guardrails", () => {
  test("deny: refused with the deciding rule's message; every hit recorded, the deciding one marked", async () => {
    const { hook, firings } = setup([
      doc("mail", "", rules("- id: no-send\n  on: tool\n  match: { tool: 'mcp__*__send*', input: { to: '@external\\.example$' } }\n  action: deny\n  message: Save a draft instead.\n- id: watch\n  on: tool\n  match: { tool: 'mcp__*' }\n  action: audit")),
    ]);
    const out: any = await hook(pre("mcp__mail__send_email", { to: "x@external.example", body: "secret text" }), "t1", sig);
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Save a draft instead." });
    expect(firings[0]!.map((e) => [e.slug, e.ruleId, e.applied, e.deciding, e.toolName])).toEqual([
      ["mail", "no-send", "deny", true, "mcp__mail__send_email"],
      ["mail", "watch", "audit", false, "mcp__mail__send_email"],
    ]);
    // Never the tool input.
    expect(JSON.stringify(firings)).not.toContain("secret text");
    expect(firingAction(firings[0]![0]!)).toBe("guardrail.tool.denied");
    expect(firingAction(firings[0]![1]!)).toBe("guardrail.tool.audited");
  });

  test("audit: the call goes on; no match: nothing at all; approve is enforced as deny", async () => {
    const { hook, firings } = setup([doc("w", "", rules("- id: a\n  on: tool\n  match: { tool: Bash }\n  action: audit\n- id: ok\n  on: tool\n  match: { tool: Deploy }\n  action: approve"))]);
    expect(await hook(pre("Bash", { command: "ls" }), "t1", sig)).toEqual({});
    expect(firings).toHaveLength(1);
    expect(await hook(pre("Read"), "t1", sig)).toEqual({});
    expect(firings).toHaveLength(1);
    const out: any = await hook(pre("Deploy"), "t1", sig);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(deniedMessage("w", ""));
    expect(firings[1]![0]).toMatchObject({ action: "approve", applied: "deny" });
  });

  test("on-match Guidance: the first matching call is refused once with the body; the retry proceeds", async () => {
    const { hook, delivered, g } = setup([doc("mail-care", "load: on-match\ntriggers: { tool: 'mcp__*__send*' }", "Check the recipient twice.")]);
    expect(deliveryTurnAllowance(g)).toBe(1);
    expect(deliveryTurnAllowance(null)).toBe(0);
    const first: any = await hook(pre("mcp__mail__send_email"), "t1", sig);
    expect(first.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain("Read guardrail mail-care first");
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain("Check the recipient twice.");
    expect(delivered).toEqual([["mail-care"]]);
    expect(await hook(pre("mcp__mail__send_email"), "t1", sig)).toEqual({});
    expect(delivered).toHaveLength(1);
  });

  test("an enforced deny wins over a delivery; the delivery waits for an allowed call", async () => {
    const { hook, delivered } = setup([
      doc("care", "load: on-match\ntriggers: { tool: Bash }", "Be careful with the shell."),
      doc("rule", "", rules("- id: no-rm\n  on: tool\n  match: { tool: Bash, input: { command: 'rm -rf' } }\n  action: deny\n  message: no")),
    ]);
    const denied: any = await hook(pre("Bash", { command: "rm -rf /" }), "t1", sig);
    expect(denied.hookSpecificOutput.permissionDecisionReason).toBe("no");
    expect(delivered).toHaveLength(0);
    const deliveredNow: any = await hook(pre("Bash", { command: "ls" }), "t1", sig);
    expect(deliveredNow.hookSpecificOutput.permissionDecisionReason).toContain("Be careful with the shell.");
  });

  test("remote mode: a rule on the builtin matches its alias, a rule on the alias matches the builtin; triggers too", async () => {
    const names = aliasNames({ Bash: "mcp__remote__bash", Write: "mcp__remote__write" });
    expect(names("mcp__remote__bash")).toEqual(["mcp__remote__bash", "Bash"]);
    expect(names("Write")).toEqual(["Write", "mcp__remote__write"]);
    expect(names("Read")).toEqual(["Read"]);
    const g = sessionGuardrails(resolveDocs([
      doc("no-shell", "", rules("- id: r\n  on: tool\n  match: { tool: Bash }\n  action: deny\n  message: no shell")),
      doc("no-remote-write", "", rules("- id: w\n  on: tool\n  match: { tool: 'mcp__remote__write' }\n  action: deny\n  message: no write")),
      doc("care", "load: on-match\ntriggers: { tool: Bash }", "Shell care."),
    ]), "default", null, { version: 1, proseMax: 4000 });
    const seen = new Set<string>(["care"]);
    const hook = ownerGuardrailsHook({ guardrails: () => g, channel: () => null, delivered: () => seen, onFiring: () => {}, onDelivered: () => {}, toolNames: names });
    expect(((await hook(pre("mcp__remote__bash", { command: "ls" }), "t", sig)) as any).hookSpecificOutput.permissionDecisionReason).toBe("no shell");
    expect(((await hook(pre("Write", { file_path: "/x" }), "t", sig)) as any).hookSpecificOutput.permissionDecisionReason).toBe("no write");
    const fresh = new Set<string>();
    const g2 = sessionGuardrails(resolveDocs([doc("care", "load: on-match\ntriggers: { tool: Bash }", "Shell care.")]), "default", null, { version: 1, proseMax: 4000 });
    const h2 = ownerGuardrailsHook({ guardrails: () => g2, channel: () => null, delivered: () => fresh, onFiring: () => {}, onDelivered: () => {}, toolNames: names });
    expect(((await h2(pre("mcp__remote__bash"), "t", sig)) as any).hookSpecificOutput.permissionDecisionReason).toContain("Shell care.");
  });

  test("an input too large to check is refused by a deny rule", async () => {
    const { hook } = setup([doc("r", "", rules("- id: a\n  on: tool\n  match: { tool: Write, input: { content: 'secret' } }\n  action: deny\n  message: no"))]);
    const out: any = await hook(pre("Write", { content: "x".repeat(1024 * 1024 + 1) }), "t1", sig);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/too large for the owner's guardrail r to check/);
  });

  test("no guardrails, or another event: a no-op", async () => {
    const hook = ownerGuardrailsHook({ guardrails: () => null, channel: () => null, delivered: () => new Set(), onFiring: () => {}, onDelivered: () => {} });
    expect(await hook(pre("Bash"), "t1", sig)).toEqual({});
    const { hook: h2 } = setup([doc("r", "", rules("- id: a\n  on: tool\n  match: { tool: Bash }\n  action: deny"))]);
    expect(await h2({ hook_event_name: "PostToolUse" } as any, "t1", sig)).toEqual({});
  });
});

describe("hook.pre-tool.guardrail-files", () => {
  const root = mkdtempSync(join(tmpdir(), "gr-files-"));
  const grDir = join(root, "home", "guardrails");
  mkdirSync(join(grDir, "x"), { recursive: true });
  const dbFile = join(root, "home", "data", "db.sqlite");
  mkdirSync(join(root, "home", "data"), { recursive: true });
  writeFileSync(dbFile, "");
  const work = join(root, "home", "workspaces", "t");
  mkdirSync(work, { recursive: true });
  symlinkSync(grDir, join(work, "link"));
  const paths = { guardrailsDir: grDir, dbFile };
  const hook = guardrailFilesHook(() => work, () => paths);

  test("Write, Edit, MultiEdit and NotebookEdit under the guardrails folder or on the database are refused", async () => {
    for (const tool of ["Write", "Edit", "MultiEdit"]) {
      const out: any = await hook(pre(tool, { file_path: join(grDir, "x", "GUARDRAIL.md") }), "t", sig);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    }
    const nb: any = await hook(pre("NotebookEdit", { notebook_path: join(grDir, "n.ipynb") }), "t", sig);
    expect(nb.hookSpecificOutput.permissionDecision).toBe("deny");
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-journal`]) {
      expect(((await hook(pre("Write", { file_path: f }), "t", sig)) as any).hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });

  test("relative paths, .. and symlinks are resolved; a new file in a new folder is still under it", async () => {
    expect(isProtectedPath("../../guardrails/new/GUARDRAIL.md", work, paths)).toBe(true);
    expect(isProtectedPath("link/x/GUARDRAIL.md", work, paths)).toBe(true);
    expect(isProtectedPath(join(grDir, "brand-new", "deep", "GUARDRAIL.md"), work, paths)).toBe(true);
    expect(isProtectedPath(grDir, work, paths)).toBe(true);
    expect(isProtectedPath(`${grDir}-other/file`, work, paths)).toBe(false);
    expect(isProtectedPath("notes.md", work, paths)).toBe(false);
    expect(isProtectedPath("notes.md", work, { guardrailsDir: grDir, dbFile: null })).toBe(false);
  });

  test("the signing key cannot be read with Read, Grep or Glob; other files in the folder can be read", async () => {
    const key = join(grDir, ".hmac-key");
    const out = async (tool: string, input: unknown) => ((await hook(pre(tool, input), "t", sig)) as any).hookSpecificOutput?.permissionDecisionReason;
    expect(await out("Read", { file_path: key })).toMatch(/signing key is not readable/);
    expect(await out("Grep", { pattern: "x", path: grDir })).toMatch(/signing key/);
    expect(await out("Grep", { pattern: "x", path: key })).toMatch(/signing key/);
    expect(await out("Glob", { pattern: join(grDir, "*") })).toMatch(/signing key/);
    expect(await out("Glob", { pattern: "*", path: "link" })).toMatch(/signing key/);
    expect(await out("Read", { file_path: join(grDir, "x", "GUARDRAIL.md") })).toBeUndefined();
    expect(await out("Grep", { pattern: "x", path: work })).toBeUndefined();
    expect(await out("Glob", { pattern: "**/*.md" })).toBeUndefined();
    expect(await out("Read", {})).toBeUndefined();
  });

  test("on a case-insensitive volume a different spelling is the same path", () => {
    const ci = { ...paths, caseInsensitive: true };
    expect(isProtectedPath(join(grDir.toUpperCase(), "x", "GUARDRAIL.md"), work, ci)).toBe(true);
    expect(isProtectedPath(dbFile.toUpperCase(), work, ci)).toBe(true);
    expect(readsKey(join(grDir, ".HMAC-KEY"), work, ci, false)).toBe(true);
    // Case-sensitive comparison: a spelling that differs only in case is another file.
    const cs = { ...paths, caseInsensitive: false };
    expect(readsKey(join(grDir, ".HMAC-KEY"), work, cs, false)).toBe(false);
  });

  test("other tools, other paths and inputs without a path pass", async () => {
    expect(await hook(pre("Write", { file_path: join(work, "notes.md") }), "t", sig)).toEqual({});
    expect(await hook(pre("Read", { file_path: join(grDir, "x", "GUARDRAIL.md") }), "t", sig)).toEqual({});
    expect(await hook(pre("Bash", { command: "ls" }), "t", sig)).toEqual({});
    expect(await hook(pre("Write", {}), "t", sig)).toEqual({});
    expect(await hook(pre("Write", null), "t", sig)).toEqual({});
    expect(await hook({ hook_event_name: "Stop" } as any, "t", sig)).toEqual({});
  });
});
