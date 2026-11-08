/**
 * Owner guardrails in the agent loop: the boot snapshot, the Guidance block in
 * the system prompt, tool rules in bypass mode, once-per-session delivery, a
 * wake's turn cap, and a boot that fails closed when the set cannot be read.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

process.env.SLAUDE_MEMORY = "sqlite";
process.env.SLAUDE_AUTO_EVOLVE = "0";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
const realQuery = realSdk.query;
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
let currentQuery: (args: QueryArgs) => any = (a) => realQuery(a as any);
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk, query: (args: QueryArgs) => currentQuery(args) }));

const { AgentManager } = await import("../../src/agent/manager");
const { resolveDocs, sessionGuardrails } = await import("../../src/guardrails/resolve");
import type { BackgroundTurnRun, GuardrailSink } from "../../src/agent/manager";

class FakeSession {
  out: any[] = [];
  ended = false;
  err: Error | null = null;
  _wake: (() => void) | null = null;
  wake() { const w = this._wake; this._wake = null; w?.(); }
  start({ prompt, options }: QueryArgs, onUser?: (s: FakeSession) => void) {
    const self = this;
    options.abortController?.signal.addEventListener("abort", () => { self.err = new Error("aborted"); self.wake(); });
    (async () => {
      try {
        for await (const _ of prompt) onUser?.(self);
        self.ended = true;
        self.wake();
      } catch (e) { self.err = e as Error; self.wake(); }
    })();
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (self.err) { const e = self.err; self.err = null; throw e; }
          if (self.out.length > 0) { yield self.out.shift(); continue; }
          if (self.ended) return;
          await new Promise<void>((r) => (self._wake = r));
        }
      },
      setPermissionMode: async () => ({}),
      mcpServerStatus: async () => [],
      interrupt: async () => {},
    };
  }
}

let lastOptions: any;
let reply = false;
beforeEach(() => {
  lastOptions = undefined;
  reply = false;
  currentQuery = (args) => {
    lastOptions = args.options;
    return new FakeSession().start(args, (s) => {
      if (!reply) return;
      s.out.push({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      s.wake();
    });
  };
});
afterAll(() => { currentQuery = (a) => realQuery(a as any); });

let seq = 0;
const thread = () => ({ team_id: "T1", channel_id: "C1", thread_ts: `${Date.now()}.${++seq}` });
async function until(cond: () => boolean, ms = 3000, label = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(5);
  }
}

const doc = (slug: string, front: string, body: string) => ({
  slug, md: `---\nname: ${slug}\ndescription: about ${slug}\n${front}\n---\n${body}`, source: "file" as const, override: false, behindSource: false, enabled: true,
});
const SET = resolveDocs([
  doc("house-style", "", "Always sign as the team.\n\n```rules\n- id: no-shell\n  on: tool\n  match: { tool: Bash }\n  action: deny\n  message: The owner does not allow the shell.\n```"),
  doc("mail-care", "load: on-match\ntriggers: { tool: 'mcp__*__send*', inbound: '(?i)invoice' }", "Check the recipient twice."),
]);
const resolver = async (_s: string, persona: string | undefined, channel: string | null) =>
  sessionGuardrails(SET, persona ?? "default", channel, { version: 3, proseMax: 4000 });
const pre = (tool_name: string, tool_input: unknown = {}) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "/" });
const sig = { signal: new AbortController().signal };
const preHooks = (o: any) => o.hooks.PreToolUse.flatMap((m: any) => m.hooks);
async function runPre(o: any, input: any): Promise<any[]> {
  const out = [];
  for (const h of preHooks(o)) out.push(await h(input, "t", sig));
  return out;
}

function recordingSink() {
  const firings: string[] = [];
  const deliveries: string[] = [];
  const sink: GuardrailSink = {
    firing: (_s, events, ctx) => { for (const e of events) firings.push(`${e.slug}#${e.ruleId}:${e.applied}:${ctx.kind}`); },
    delivered: (_s, slugs, ctx) => { for (const s of slugs) deliveries.push(`${s}:${ctx.via}:${ctx.kind}`); },
  };
  return { sink, firings, deliveries };
}

describe("the system prompt", () => {
  it("carries <owner-guardrails> after <persona> and before the session blocks; rules stay out", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(resolver);
    const p = await mgr.__systemPromptForTests("sess-p", undefined, { channelId: "C1" });
    const persona = p.indexOf("</persona>");
    const block = p.indexOf("<owner-guardrails>");
    expect(persona).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(persona);
    expect(block).toBeLessThan(p.indexOf("<mcp-servers>"));
    expect(p).toContain("Always sign as the team.");
    expect(p).toContain("- mail-care: about mail-care");
    expect(p).not.toContain("Check the recipient twice.");
    expect(p).not.toContain("The owner does not allow the shell.");
  });

  it("no resolver, or nothing applies: no block", async () => {
    expect(await new AgentManager().__systemPromptForTests("sess-q", undefined)).not.toContain("<owner-guardrails>");
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(async () => null);
    expect(await mgr.__systemPromptForTests("sess-r", undefined)).not.toContain("<owner-guardrails>");
  });
});

describe("a booted session", () => {
  it("denies a tool an owner rule denies, in bypass mode too, and records it", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(resolver);
    const { sink, firings } = recordingSink();
    mgr.setGuardrailSink(sink);
    const row = await mgr.ensureSession(thread());
    await mgr.setPermissionMode(row.id, "bypassPermissions");
    await mgr.sendMessage(row.id, "hello");
    await until(() => lastOptions !== undefined, 3000, "boot");
    expect(lastOptions.permissionMode).toBe("bypassPermissions");
    expect(mgr.guardrailsFor(row.id)?.version).toBe(3);
    const out = await runPre(lastOptions, pre("Bash", { command: "ls" }));
    expect(out.some((o) => o?.hookSpecificOutput?.permissionDecision === "deny" && o.hookSpecificOutput.permissionDecisionReason === "The owner does not allow the shell.")).toBe(true);
    expect(firings).toEqual(["house-style#no-shell:deny:interactive"]);
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
    expect(mgr.guardrailsFor(row.id)).toBeNull();
  });

  it("in a remote thread a rule on Bash denies the remote alias the CLI reports", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(resolver);
    const noopExec = async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false });
    mgr.setRemote(async () => ({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" }), () => ({ exec: noopExec, release: async () => {}, dispose: async () => {} }));
    const row = await mgr.ensureSession(thread());
    await mgr.sendMessage(row.id, "hello");
    await until(() => lastOptions !== undefined, 3000, "boot");
    expect(lastOptions.toolAliases.Bash).toBe("mcp__remote__bash");
    const out = await runPre(lastOptions, pre("mcp__remote__bash", { command: "ls" }));
    expect(out.some((o) => o?.hookSpecificOutput?.permissionDecisionReason === "The owner does not allow the shell.")).toBe(true);
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
  });

  it("tool-triggered Guidance is delivered once per boot, again after a reboot", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(resolver);
    const { sink, deliveries } = recordingSink();
    mgr.setGuardrailSink(sink);
    const row = await mgr.ensureSession(thread());
    await mgr.sendMessage(row.id, "hello");
    await until(() => lastOptions !== undefined, 3000, "boot");
    const send = pre("mcp__mail__send_email", { to: "a@b.example" });
    const first = await runPre(lastOptions, send);
    expect(first.find((o) => o?.hookSpecificOutput)?.hookSpecificOutput.permissionDecisionReason).toContain("Check the recipient twice.");
    const second = await runPre(lastOptions, send);
    expect(second.every((o) => !o?.hookSpecificOutput)).toBe(true);
    expect(deliveries).toEqual(["mail-care:tool:interactive"]);
    // A reboot is a fresh CLI that has not seen it.
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
    lastOptions = undefined;
    await mgr.sendMessage(row.id, "again");
    await until(() => lastOptions !== undefined, 3000, "reboot");
    const third = await runPre(lastOptions, send);
    expect(third.find((o) => o?.hookSpecificOutput)?.hookSpecificOutput.permissionDecisionReason).toContain("Read guardrail mail-care first");
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
  });

  it("inbound-triggered Guidance reaches the next turn once, with the session notes", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(resolver);
    const { sink, deliveries } = recordingSink();
    mgr.setGuardrailSink(sink);
    const row = await mgr.ensureSession(thread());
    mgr.offerGuidance(row.id, []);
    mgr.offerGuidance(row.id, [{ slug: "mail-care", name: "mail-care", body: "Check the recipient twice." }]);
    mgr.offerGuidance(row.id, [{ slug: "mail-care", name: "mail-care", body: "Check the recipient twice." }]);
    mgr.noteSessionEvent(row.id, "Connected MCP server `x`.");
    await mgr.sendMessage(row.id, "about the invoice");
    await until(() => lastOptions !== undefined, 3000, "boot");
    const hook = lastOptions.hooks.UserPromptSubmit[0].hooks[0];
    const ups = { hook_event_name: "UserPromptSubmit", prompt: "x", session_id: "s", transcript_path: "", cwd: "/" };
    const out: any = await hook(ups, undefined, sig);
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("<session-events>");
    expect(ctx).toContain('<owner-guardrail name="mail-care">');
    expect(deliveries).toEqual(["mail-care:inbound:interactive"]);
    // Offered again in the same session: already given, dropped.
    mgr.offerGuidance(row.id, [{ slug: "mail-care", name: "mail-care", body: "Check the recipient twice." }]);
    expect(await hook(ups, undefined, sig)).toEqual({ continue: true });
    // And the tool trigger of the same guardrail does not deliver it a second time.
    const again = await runPre(lastOptions, pre("mcp__mail__send_email"));
    expect(again.every((o) => !o?.hookSpecificOutput)).toBe(true);
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
  });

  it("a guardrail change reloads warm sessions booted on another version, after their turn", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(resolver);
    const row = await mgr.ensureSession(thread());
    reply = true;
    await mgr.sendMessage(row.id, "hello");
    await until(() => lastOptions !== undefined && !mgr.turnInFlight(row.id), 3000, "boot and turn");
    expect(mgr.reloadForGuardrails(3)).toBe(0);
    expect(mgr.isLive(row.id)).toBe(true);
    expect(mgr.reloadForGuardrails(4)).toBe(1);
    await until(() => !mgr.isLive(row.id), 3000, "reload");
  });

  it("a wake's turn cap grows by what Guidance refusals can cost", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(resolver);
    const row = await mgr.ensureSession(thread());
    reply = true;
    const finishes: string[] = [];
    const run: BackgroundTurnRun = { runId: "run-w", finish: async (_u, outcome) => void finishes.push(outcome) };
    await mgr.sendMessage(row.id, '<runtime-check kind="wake">look</runtime-check>', { backgroundRun: run, wake: { maxTurns: 10 } });
    await until(() => finishes.length === 1, 3000, "wake finish");
    expect(lastOptions.maxTurns).toBe(11);
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
  });

  it("a set that cannot be read or verified fails the boot with GUARDRAILS_UNAVAILABLE; nothing runs", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(async () => { throw new Error("manifest signature does not verify"); });
    const errors: any[] = [];
    mgr.on("event", (e: any) => { if (e.type === "error") errors.push(e); });
    const row = await mgr.ensureSession(thread());
    await mgr.sendMessage(row.id, "hello").catch((e) => errors.push({ thrown: e }));
    await until(() => errors.length > 0, 3000, "boot failure");
    const code = errors[0].code ?? errors[0].thrown?.code;
    expect(code).toBe("GUARDRAILS_UNAVAILABLE");
    expect(lastOptions).toBeUndefined();
    expect(mgr.isLive(row.id)).toBe(false);
  });
});

describe("tool approve in a booted session", () => {
  const APPROVE_SET = resolveDocs([doc("deploys", "", "```rules\n- id: ask\n  on: tool\n  match: { tool: Deploy }\n  action: approve\n  message: Deploys need an approver.\n```")]);
  const approveResolver = async (_s: string, persona: string | undefined, channel: string | null) =>
    sessionGuardrails(APPROVE_SET, persona ?? "default", channel, { version: 5, proseMax: 4000 });

  it("asks the permission resolver for a forced card and allows on its allow; the matcher timeout sits above the cap", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(approveResolver);
    const { sink, firings } = recordingSink();
    mgr.setGuardrailSink(sink);
    const asked: any[] = [];
    mgr.setPermissionResolver(async (_sid, tool, input, ctx) => {
      asked.push({ tool, input, ctx });
      return { behavior: "allow", updatedInput: input };
    });
    const row = await mgr.ensureSession(thread());
    await mgr.setPermissionMode(row.id, "bypassPermissions");
    await mgr.sendMessage(row.id, "hello");
    await until(() => lastOptions !== undefined, 3000, "boot");
    expect(lastOptions.hooks.PreToolUse[0].timeout).toBe(660);
    const out = await runPre(lastOptions, pre("Deploy", { env: "prod" }));
    expect(out.some((o) => o?.hookSpecificOutput?.permissionDecision === "allow")).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].ctx.ownerApproval).toMatchObject({ ruleId: "deploys#ask", message: "Deploys need an approver." });
    expect(asked[0].ctx.decisionReason).toBe("Deploys need an approver.");
    expect(firings).toEqual(["deploys#ask:approved:interactive"]);
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
  });

  it("a deny from the card refuses with its message; no resolver refuses at once", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(approveResolver);
    mgr.setPermissionResolver(async () => ({ behavior: "deny", message: "Denied by <@U9>" }));
    const row = await mgr.ensureSession(thread());
    await mgr.sendMessage(row.id, "hello");
    await until(() => lastOptions !== undefined, 3000, "boot");
    const out = await runPre(lastOptions, pre("Deploy"));
    expect(out.find((o) => o?.hookSpecificOutput)?.hookSpecificOutput.permissionDecisionReason).toBe("Deploys need an approver. Not approved: Denied by <@U9>.");
    mgr.setPermissionResolver(undefined);
    const none = await runPre(lastOptions, pre("Deploy"));
    expect(none.find((o) => o?.hookSpecificOutput)?.hookSpecificOutput.permissionDecisionReason).toBe("Deploys need an approver. Not approved: no approval card can be shown in this session.");
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
  });

  it("in a wake nobody is asked: refused before the resolver; a node's turn deadline bounds the card", async () => {
    const mgr = new AgentManager();
    mgr.setGuardrailResolver(approveResolver);
    let called = 0;
    mgr.setPermissionResolver(async (_s, _t, input, ctx: any) => {
      called++;
      return ctx.ownerApproval.deadline <= Date.now() + 60_000 ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "too long" };
    });
    const row = await mgr.ensureSession(thread());
    const run: BackgroundTurnRun = { runId: "run-a", finish: async () => {} };
    await mgr.sendMessage(row.id, '<runtime-check kind="wake">look</runtime-check>', { backgroundRun: run, wake: { maxTurns: 10 } });
    await until(() => lastOptions !== undefined, 3000, "boot");
    const out = await runPre(lastOptions, pre("Deploy"));
    expect(out.find((o) => o?.hookSpecificOutput)?.hookSpecificOutput.permissionDecisionReason).toBe("Deploys need an approver. Not approved: nobody is in this turn to approve it (you woke on your own).");
    expect(called).toBe(0);
    mgr.reload(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "shutdown");
    // Not a wake, with a turn deadline 90 s away: the card gets 60 s.
    lastOptions = undefined;
    mgr.setTurnDeadline(() => Date.now() + 90_000);
    const row2 = await mgr.ensureSession(thread());
    await mgr.sendMessage(row2.id, "hello");
    await until(() => lastOptions !== undefined, 3000, "boot 2");
    const out2 = await runPre(lastOptions, pre("Deploy"));
    expect(out2.some((o) => o?.hookSpecificOutput?.permissionDecision === "allow")).toBe(true);
    expect(called).toBe(1);
    mgr.reload(row2.id);
    await until(() => !mgr.isLive(row2.id), 3000, "shutdown 2");
  });
});
