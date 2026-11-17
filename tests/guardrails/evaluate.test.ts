/**
 * The Test box (phase B): evaluateGuardrails against the runtime itself. The
 * same stored set and the same inputs go through the PreToolUse hook, the
 * outbound choke point and the inbound check; the Test box must report the
 * decision each of them takes. Drafts and "too large to check" are covered
 * too, and nothing is recorded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, currentGuardrails } from "../../src/guardrails/snapshot";
import { evaluateGuardrails, type TestEvent } from "../../src/guardrails/evaluate";
import { sessionGuardrails } from "../../src/guardrails/resolve";
import { aliasNames, ownerGuardrailsHook } from "../../src/guardrails/hooks";
import { REMOTE_TOOL_ALIASES } from "../../src/remote/mcp";
import type { FiringEvent } from "../../src/guardrails/audit";
import { formatOutbound, outbound } from "../../src/gateway/slack/outbound";
import { inboundVerdict } from "../../src/gateway/core/owner-guardrails";
import { MAX_MATCH_CHARS } from "../../src/guardrails/pattern";
import { db } from "../../src/db/schema";
import { flushAudits } from "../../src/audit/emit";
import { ensureGuardrailKeyForPg } from "./helpers";

ensureGuardrailKeyForPg();

const TOOLS = [
  "---\nname: tools\ndescription: Tool rules\n---\nNever send mail.\n\n```rules",
  "- id: no-send\n  on: tool\n  match: { tool: 'mcp__*__*send*', input: { to: '(?i)@external\\.example$' } }\n  action: deny\n  message: Sending outside is not allowed.",
  "- id: ask-send\n  on: tool\n  match: { tool: 'mcp__*__*send*' }\n  action: approve\n  message: Sending needs an approver.",
  "- id: watch-bash\n  on: tool\n  match: { tool: Bash, input: '(?i)curl' }\n  action: audit",
  "- id: no-rm\n  on: tool\n  match: { tool: Bash, input: { command: 'rm -rf' } }\n  action: deny",
  "```",
].join("\n");
const REPLIES = [
  "---\nname: replies\n---\n```rules",
  "- id: no-codes\n  on: reply\n  match: { text: 'launch code \\d+' }\n  action: deny\n  message: Launch codes are never posted.",
  "- id: hide-cards\n  on: reply\n  match: { text: '\\b\\d{4}-\\d{4}-\\d{4}-\\d{4}\\b' }\n  action: redact",
  "- id: prices\n  on: reply\n  match: { text: '(?i)price is \\$\\d+' }\n  action: approve",
  "- id: watch\n  on: reply\n  match: { text: '(?i)roadmap' }\n  action: audit",
  "```",
].join("\n");
const INBOUND = [
  "---\nname: inbound\nchannels: [COPS]\n---\n```rules",
  "- id: no-passwords\n  on: inbound\n  match: { text: '(?i)password\\s*[:=]' }\n  action: deny\n  message: Please do not paste passwords here.",
  "- id: quiet\n  on: inbound\n  match: { text: '(?i)salary' }\n  action: deny",
  "- id: watch-in\n  on: inbound\n  match: { text: '(?i)invoice' }\n  action: audit",
  "```",
].join("\n");
const CARE = "---\nname: mail-care\ndescription: How to send\nload: on-match\ntriggers: { tool: ['mcp__*__send*'], inbound: '(?i)invoice' }\n---\nCheck the address twice.";
const SCOUT = "---\nname: scout-only\nscope: agents\nagents: [scout]\n---\n```rules\n- id: no-web\n  on: tool\n  match: { tool: WebFetch }\n  action: deny\n```";

let version = 0;
beforeAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  const r = await applyGuardrailChange("default", {
    upsert: [
      { slug: "tools", md: TOOLS, source: "git" },
      { slug: "replies", md: REPLIES, source: "git" },
      { slug: "inbound", md: INBOUND, source: "git" },
      { slug: "mail-care", md: CARE, source: "git" },
      { slug: "scout-only", md: SCOUT, source: "file" },
    ],
    by: "test",
  });
  version = r.version;
});
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});

const opts = (agent: string, channel: string | null) => ({ agent, channel, version, proseMax: 4000 });
const resolved = async () => (await currentGuardrails("default")).resolved;
const test_ = async (e: TestEvent, agent = "default", channel: string | null = "CDEV", draft?: { slug: string; md: string }) =>
  evaluateGuardrails(await resolved(), e, { ...opts(agent, channel), draft: draft ?? null });

/** The PreToolUse hook's verdict for one call: denied or allowed, and which rule decided (the card's rule when approve). */
async function hookVerdict(agent: string, channel: string | null, tool: string, input: unknown, toolNames?: (n: string) => string[]) {
  const g = sessionGuardrails(await resolved(), agent, channel, { version, proseMax: 4000 });
  let fired: FiringEvent[] = [];
  let card = null as string | null;
  const hook = ownerGuardrailsHook({
    guardrails: () => g,
    channel: () => channel,
    delivered: () => new Set(g.onMatch.map((o) => o.slug)),
    onFiring: (ev) => (fired = ev),
    onDelivered: () => {},
    ...(toolNames ? { toolNames } : {}),
    approve: async (req) => {
      card = req.approval.ruleId;
      return { allow: true, reason: "approved by UAPP" };
    },
  });
  const out = (await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input } as never, "tu1", { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  const deciding = fired.find((f) => f.deciding);
  return { decision: out.hookSpecificOutput?.permissionDecision ?? "none", reason: out.hookSpecificOutput?.permissionDecisionReason ?? "", deciding: deciding ? `${deciding.slug}#${deciding.ruleId}` : null, action: deciding?.action ?? null, card, hits: fired.map((f) => `${f.slug}#${f.ruleId}`) };
}

describe("parity with the PreToolUse hook", () => {
  const CASES: Array<{ name: string; agent: string; tool: string; input: unknown }> = [
    { name: "a deny on one input field", agent: "default", tool: "mcp__mail__send_message", input: { to: "jane@external.example", body: "hi" } },
    { name: "an approve when the field does not match", agent: "default", tool: "mcp__mail__send_message", input: { to: "jane@team.example" } },
    { name: "an audit on any input value", agent: "default", tool: "Bash", input: { command: "curl https://example.com" } },
    { name: "deny beats audit on the same call", agent: "default", tool: "Bash", input: { command: "curl x && rm -rf /" } },
    { name: "nothing matches", agent: "default", tool: "Read", input: { file_path: "/tmp/x" } },
    { name: "an agent-scoped rule applies to its agent only", agent: "scout", tool: "WebFetch", input: { url: "https://example.com" } },
    { name: "and not to another agent", agent: "default", tool: "WebFetch", input: { url: "https://example.com" } },
    { name: "a value too large to check fails closed for a deny", agent: "default", tool: "Bash", input: { command: "x".repeat(MAX_MATCH_CHARS + 1) } },
  ];
  for (const c of CASES) {
    test(c.name, async () => {
      const hook = await hookVerdict(c.agent, "CDEV", c.tool, c.input);
      const t = await test_({ kind: "tool", tool: c.tool, input: c.input }, c.agent);
      const deciding = t.decision ? `${t.decision.slug}#${t.decision.ruleId}` : null;
      if (t.decision?.action === "approve") {
        expect(hook.card).toBe(`${t.decision.slug}#${t.decision.ruleId}`);
        expect(hook.decision).toBe("allow");
      } else if (t.decision?.action === "deny") {
        expect(hook.decision).toBe("deny");
        expect(hook.reason).toBe(t.decision.message);
      } else {
        expect(hook.decision).toBe("none");
      }
      expect(hook.deciding).toBe(deciding);
      expect(hook.action).toBe(t.decision?.action ?? null);
      expect(hook.hits).toEqual(t.hits.map((h) => `${h.slug}#${h.ruleId}`));
    });
  }

  test("a /remote alias: the same names as the hook (the manager's alias function), so a Bash rule holds for mcp__remote__bash", async () => {
    const names = aliasNames(REMOTE_TOOL_ALIASES);
    for (const [tool, input] of [["mcp__remote__bash", { command: "rm -rf /" }], ["mcp__remote__bash", { command: "curl x" }], ["mcp__remote__read", { file_path: "/x" }]] as const) {
      const hook = await hookVerdict("default", "CDEV", tool, input, names);
      const t = evaluateGuardrails(await resolved(), { kind: "tool", tool, input }, { ...opts("default", "CDEV"), toolNames: names });
      expect(hook.deciding).toBe(t.decision ? `${t.decision.slug}#${t.decision.ruleId}` : null);
      expect(hook.hits).toEqual(t.hits.map((h) => `${h.slug}#${h.ruleId}`));
      expect(hook.decision).toBe(t.decision?.action === "deny" ? "deny" : "none");
    }
    const t = evaluateGuardrails(await resolved(), { kind: "tool", tool: "mcp__remote__bash", input: { command: "rm -rf /" } }, { ...opts("default", "CDEV"), toolNames: names });
    expect(t.decision).toMatchObject({ action: "deny", ruleId: "no-rm" });
    // Without the alias function (a thread not bound with /remote) the alias name alone matches nothing.
    expect((await test_({ kind: "tool", tool: "mcp__remote__bash", input: { command: "rm -rf /" } })).decision).toBeNull();
  });

  test("the deciding rules are the expected ones", async () => {
    expect((await test_({ kind: "tool", tool: "mcp__mail__send_message", input: { to: "a@external.example" } })).decision).toMatchObject({ action: "deny", ruleId: "no-send" });
    expect((await test_({ kind: "tool", tool: "mcp__mail__send_message", input: { to: "a@team.example" } })).decision).toMatchObject({ action: "approve", ruleId: "ask-send" });
    const big = await test_({ kind: "tool", tool: "Bash", input: { command: "x".repeat(MAX_MATCH_CHARS + 1) } });
    expect(big.decision).toMatchObject({ action: "deny", ruleId: "no-rm", oversize: true });
    expect(big.tooLarge).toBe(true);
    // The audit rule is best effort: too large is not a hit for it.
    expect(big.hits.map((h) => h.ruleId)).toEqual(["no-rm"]);
    expect(big.decision!.message).toContain("too large");
  });
});

describe("parity with the outbound choke point", () => {
  const TEXTS = [
    "All good.",
    "The launch code 1234 is here.",
    "Card 1234-5678-9012-3456 on file.",
    "The price is $40.",
    "Our roadmap is public.",
    "Roadmap and card 1234-5678-9012-3456 and price is $5.",
    "launch code 7 and 1234-5678-9012-3456",
    "**bold** roadmap",
  ];
  for (const text of TEXTS) {
    test(`reply: ${text}`, async () => {
      const real = await outbound(text, { kind: "reply", persona: "default", channel: "CDEV", thread: { channel: "CDEV", threadTs: "1.0" } });
      const t = await test_({ kind: "reply", text: formatOutbound(text, "reply", "default") });
      if (real.action === "deny") {
        expect(t.decision?.action).toBe("deny");
        expect(t.posted).toBeUndefined();
        expect(real.message).toBe(t.decision!.message);
      } else if (real.action === "hold") {
        expect(t.decision?.action).toBe("approve");
        expect(`${real.slug}#${real.ruleId}`).toBe(`${t.decision!.slug}#${t.decision!.ruleId}`);
      } else {
        expect(t.posted).toBe(real.text);
        expect(["redact", "audit", undefined]).toContain(t.decision?.action);
      }
    });
  }
});

describe("parity with the inbound check", () => {
  const TEXTS: Array<[string, string]> = [
    ["COPS", "my password: hunter2"],
    ["COPS", "what is my salary"],
    ["COPS", "see the invoice"],
    ["COPS", "hello"],
    ["CDEV", "my password: hunter2"],
    ["COPS", `${"y".repeat(MAX_MATCH_CHARS + 1)}`],
  ];
  for (const [channel, text] of TEXTS) {
    test(`inbound in ${channel}: ${text.slice(0, 24)}`, async () => {
      const real = await inboundVerdict("default", channel, text);
      const t = await test_({ kind: "inbound", text }, "default", channel);
      expect(real?.action ?? null).toBe(t.decision ? (t.decision.action === "deny" ? "deny" : "audit") : null);
      if (real?.action === "deny") expect(t.decision!.message).toBe(real.message);
      expect(real?.slug ?? null).toBe(t.decision?.slug ?? null);
    });
  }
});

describe("Guidance and drafts", () => {
  test("always-loaded vs on-match: what loads, what a trigger delivers", async () => {
    const t = await test_({ kind: "tool", tool: "mcp__mail__send_message", input: { to: "a@team.example" } });
    expect(t.guidance.always.map((g) => g.slug)).toEqual(["tools"]);
    expect(t.guidance.delivered).toEqual([{ slug: "mail-care", name: "mail-care", via: "tool" }]);
    expect(t.guidance.indexed).toEqual([]);
    expect(t.outcome).toMatch(/^Refused once to hand the model mail-care/);
    const quiet = await test_({ kind: "reply", text: "hello" });
    expect(quiet.guidance.indexed).toEqual([{ slug: "mail-care", name: "mail-care" }]);
    const inbound = await test_({ kind: "inbound", text: "an invoice" });
    expect(inbound.guidance.delivered).toEqual([{ slug: "mail-care", name: "mail-care", via: "inbound" }]);
  });

  test("the prose cap names what it leaves out", async () => {
    const t = evaluateGuardrails(await resolved(), { kind: "reply", text: "x" }, { ...opts("default", null), proseMax: 5 });
    expect(t.guidance.skipped.map((s) => s.slug)).toEqual(["tools"]);
    expect(t.guidance.always).toEqual([]);
  });

  test("an unsaved draft replaces its stored text, or is added; its errors are reported", async () => {
    const loose = TOOLS.replace("action: deny\n  message: Sending outside", "action: audit\n  message: Sending outside");
    const t = await test_({ kind: "tool", tool: "mcp__mail__send_message", input: { to: "a@external.example" } }, "default", "CDEV", { slug: "tools", md: loose });
    expect(t.decision).toMatchObject({ action: "approve", ruleId: "ask-send" });
    expect(t.hits.every((h) => h.draft)).toBe(true);
    expect(t.draft).toEqual({ slug: "tools", errors: [], blocking: [], replaced: true, switchedOff: false });
    const fresh = "---\nname: fresh\n---\n```rules\n- id: x\n  on: reply\n  match: { text: hello }\n  action: deny\n- id: bad\n  on: reply\n  match: { text: '(' }\n  action: deny\n```";
    const n = await test_({ kind: "reply", text: "hello there" }, "default", "CDEV", { slug: "fresh", md: fresh });
    expect(n.decision).toMatchObject({ slug: "fresh", ruleId: "x", action: "deny" });
    expect(n.draft!.replaced).toBe(false);
    expect(n.draft!.blocking[0]).toMatch(/rule bad/);
    // The stored set is untouched.
    expect((await test_({ kind: "reply", text: "hello there" })).decision).toBeNull();
  });

  test("a draft of a switched-off guardrail is evaluated as on, and the result says so", async () => {
    await applyGuardrailChange("default", { setEnabled: [{ slug: "replies", enabled: false }], by: "test" });
    try {
      expect((await test_({ kind: "reply", text: "launch code 1" })).decision).toBeNull();
      const t = await test_({ kind: "reply", text: "launch code 1" }, "default", "CDEV", { slug: "replies", md: REPLIES });
      expect(t.decision).toMatchObject({ action: "deny", slug: "replies", ruleId: "no-codes" });
      expect(t.draft).toMatchObject({ replaced: true, switchedOff: true });
    } finally {
      await applyGuardrailChange("default", { setEnabled: [{ slug: "replies", enabled: true }], by: "test" });
    }
  });

  test("evaluation records nothing", async () => {
    await flushAudits();
    const before = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'guardrail.%'");
    for (let i = 0; i < 3; i++) {
      await test_({ kind: "tool", tool: "Bash", input: { command: "curl x && rm -rf /" } });
      await test_({ kind: "inbound", text: "password: x" }, "default", "COPS");
      await test_({ kind: "reply", text: "launch code 1" });
    }
    await flushAudits();
    const after = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'guardrail.%'");
    expect(Number(after!.n)).toBe(Number(before!.n));
  });
});
