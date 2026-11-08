/**
 * Resources fixtures (skills and guardrails) for the dev stub and the
 * Playwright smoke tests. Generic placeholder names only.
 */
import type {
  AgentGuardrailsResponse,
  GuardrailFamily,
  GuardrailSettingsResponse,
  OwnerGuardrailDetail,
  OwnerGuardrailsResponse,
  OwnerGuardrailSummary,
  SkillDetailResponse,
} from "../../../gateway/panel/api-types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const AGENTS = ["default", "scout", "triage"];

const skill = (s: Omit<SkillDetailResponse, "frontmatter" | "body" | "rawTruncated"> & { frontmatter?: Record<string, unknown> }): SkillDetailResponse => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(s.raw);
  return { frontmatter: s.frontmatter ?? { name: s.name, description: s.description }, body: m ? m[2]! : s.raw, rawTruncated: false, ...s };
};

export function skillFixtures(now: number): SkillDetailResponse[] {
  const none = { files: [], filesTruncated: false, usageHistory: [], proposals: [], actions: { retire: false, restore: false } };
  return [
    skill({
      id: "builtin:memory",
      slug: "memory",
      name: "memory",
      description: "How and when to save what the agent learns.",
      invocation: "slaude:memory",
      source: "built-in",
      status: "active",
      origin: { root: "built-in", version: "0.46.0-rc.4" },
      agents: AGENTS,
      usage: { uses: 214, lastUsedAt: now - 9 * MIN, trackedSince: now - 30 * DAY },
      raw: "---\nname: memory\ndescription: How and when to save what the agent learns.\ntrigger: before memory_save\ngoverns:\n  - mcp__slaude_kb__memory_save\n---\n# Memory\n\nSave a page when you learn something **durable**. Keep it short.\n",
      ...none,
      files: [{ path: "SKILL.md", size: 1840 }],
      usageHistory: [
        { agent: "default", key: "slaude:memory", uses: 160, lastUsedAt: now - 9 * MIN, firstSeenAt: now - 30 * DAY },
        { agent: "scout", key: "slaude:memory", uses: 54, lastUsedAt: now - 2 * HOUR, firstSeenAt: now - 21 * DAY },
      ],
    }),
    skill({
      id: "base:release-notes",
      slug: "release-notes",
      name: "release-notes",
      description: "Draft release notes from merged pull requests.",
      invocation: "/release-notes",
      source: "installed",
      status: "active",
      origin: { root: "base", repo: "https://example.com/org/team-skills.git", ref: "main", commit: "3f9c2a1b7d4e5f60718293a4b5c6d7e8f9a0b1c2", path: "release-notes" },
      agents: ["default", "triage"],
      shadowedFor: ["scout"],
      usage: { uses: 37, lastUsedAt: now - 3 * DAY, trackedSince: now - 40 * DAY },
      raw: [
        "---",
        "name: release-notes",
        "description: Draft release notes from merged pull requests.",
        "---",
        "# Release notes",
        "",
        "Group changes by **category**:",
        "",
        "1. Features",
        "2. Fixes",
        "   - user-facing first",
        "3. Internal",
        "",
        "- [x] Link each pull request once",
        "- [ ] Thank outside contributors",
        "",
        "| Section | Required |",
        "|:--|:-:|",
        "| Features | yes |",
        "| Fixes | yes |",
        "",
        "```sh",
        "git log --oneline v1.0.0..HEAD",
        "```",
        "",
        "> Keep it short. See [the style guide](https://example.com/style).",
        "",
      ].join("\n"),
      ...none,
      files: [
        { path: "SKILL.md", size: 912 },
        { path: "scripts/collect.sh", size: 640 },
        { path: "templates/notes.md", size: 310 },
      ],
      usageHistory: [{ agent: "default", key: "release-notes", uses: 37, lastUsedAt: now - 3 * DAY, firstSeenAt: now - 40 * DAY }],
    }),
    skill({
      id: "base:how-slaude-works",
      slug: "how-slaude-works",
      name: "how-slaude-works",
      description: "Explain how this agent works when someone asks.",
      invocation: "/how-slaude-works",
      source: "installed",
      status: "active",
      origin: { root: "base", bundled: true },
      agents: AGENTS,
      usage: { uses: 3, lastUsedAt: now - 6 * DAY, trackedSince: now - 30 * DAY },
      raw: "---\nname: how-slaude-works\ndescription: Explain how this agent works when someone asks.\n---\nAnswer from what you can see; never guess.\n",
      ...none,
      files: [{ path: "SKILL.md", size: 2210 }],
    }),
    skill({
      id: "plugin:docs-kit:search-docs",
      slug: "search-docs",
      name: "search-docs",
      description: "Search the product documentation.",
      invocation: "docs-kit:search-docs",
      source: "plugin",
      status: "active",
      origin: { root: "plugin", plugin: "docs-kit", marketplace: "team-market", version: "1.4.0", commit: "9a8b7c6d5e4f30211234567890abcdef12345678" },
      agents: AGENTS,
      usage: { uses: 0, lastUsedAt: null, trackedSince: null },
      raw: "---\nname: search-docs\ndescription: Search the product documentation.\n---\nUse the docs search tool first.\n",
      ...none,
      files: [{ path: "SKILL.md", size: 420 }],
    }),
    skill({
      id: "agent:scout:weekly-digest",
      slug: "weekly-digest",
      name: "weekly-digest",
      description: "Summarise the week's research threads for the team.",
      invocation: "/weekly-digest",
      source: "agent-authored",
      status: "active",
      origin: { root: "agent", authoredBy: "scout", authoredAt: new Date(now - 5 * DAY).toISOString() },
      agents: ["scout"],
      usage: { uses: 4, lastUsedAt: now - 2 * DAY, trackedSince: now - 5 * DAY },
      raw: "---\nname: weekly-digest\ndescription: Summarise the week's research threads for the team.\nauthored_by: agent\n---\n## Steps\n\n- Read the week's threads\n- Write *one* line each\n",
      frontmatter: { name: "weekly-digest", description: "Summarise the week's research threads for the team.", authored_by: "agent" },
      ...none,
      files: [{ path: "SKILL.md", size: 380 }],
      usageHistory: [{ agent: "scout", key: "weekly-digest", uses: 4, lastUsedAt: now - 2 * DAY, firstSeenAt: now - 5 * DAY }],
      actions: { retire: true, restore: false },
    }),
    skill({
      id: "retired:default:standup-notes-20261020T090000Z",
      slug: "standup-notes",
      name: "standup-notes",
      description: "Take standup notes.",
      invocation: "/standup-notes",
      source: "agent-authored",
      status: "retired",
      origin: { root: "base", authoredBy: "default", authoredAt: null, retiredAt: now - 18 * DAY, retiredId: "standup-notes-20261020T090000Z" },
      agents: [],
      usage: { uses: 0, lastUsedAt: null, trackedSince: now - 60 * DAY },
      raw: "---\nname: standup-notes\ndescription: Take standup notes.\nauthored_by: agent\n---\nWrite down who said what.\n",
      ...none,
      files: [{ path: "SKILL.md", size: 140 }],
      proposals: [
        { id: "p_ret1", kind: "skill-retired", status: "approved", agent: "default", createdAt: now - 18 * DAY, decidedBy: "skill-review", decidedAt: now - 18 * DAY, reason: "Unused for 60 days." },
      ],
      actions: { retire: false, restore: true },
    }),
  ];
}

const s = (key: string, label: string, value: GuardrailFamily["settings"][number]["value"], source: GuardrailFamily["settings"][number]["source"], origin?: string, note?: string) => ({
  key, label, value, source, ...(origin ? { origin } : {}), ...(note ? { note } : {}),
});

export function guardrailSettingsFixtures(agent: string, isSuper = true): GuardrailSettingsResponse {
  const named = agent !== "default";
  const families: GuardrailFamily[] = [
    {
      id: "tool-permissions",
      title: "Tool permissions",
      summary: "Which tool calls run without asking, and who may decide a permission card.",
      scope: "deployment",
      status: "active",
      settings: [
        s("auto-allow", "Always allowed tools", ["Read", "kb_memoize", "memory_save"], "env", "SLAUDE_AUTO_ALLOW_TOOLS", "A memory tool listed under either name (memory_save or kb_memoize) allows both."),
        s("default-mode", "Permission mode of a new thread", "default", "default", "SLAUDE_DEFAULT_MODE"),
        s("card-ttl", "A permission card waits for", "60 minutes", "code", "PERM_GATE_TTL_MS"),
      ],
      table: { columns: ["Permission mode", "Threads of this agent"], rows: [["default", "41"], ["acceptEdits", "2"]] },
      text: "Calls that never post a card:\n\n- tools listed in `SLAUDE_AUTO_ALLOW_TOOLS`;\n- `list_skills` and `read_skill`.\n\nEverything else posts a permission card: *Allow once*, *Always allow* or *Deny*.",
      textSource: "gateway/slack/permission-gate.ts permissionPolicy",
    },
    {
      id: "approvals",
      title: "Approvals",
      summary: "Who must say yes before the agent does something it asks about.",
      scope: "agent",
      status: "active",
      settings: named
        ? [s("approvers", "Approvers", ["UALICE", "UBOB"], "soul", "approvers and managers of this agent (grants)")]
        : [s("approvers", "Approvers", ["UALICE"], "soul", "SOUL.md approvers", "Matched per request.")],
      text: "## Approvers\n\n- <@UALICE> for **deploys** and anything that touches production",
      textSource: "SOUL.md",
    },
    {
      id: "admission",
      title: "Admission and grants",
      summary: "Who the agent answers: managers, channels, DM allowlist, and blocked people.",
      scope: "agent",
      status: "active",
      settings: [
        s("managers", "Managers", ["UALICE"], "soul", "SOUL.md manager and backup manager, plus console grants"),
        s("channels", "Channels it answers in", ["CTEAM"], "soul"),
        s("blocked", "Blocked", [], "soul"),
      ],
      link: { label: "Grants on the Access tab", to: `/agents/${agent}/access` },
    },
    {
      id: "proactive",
      title: "Proactive restraint",
      summary: "When the agent may speak first, how often, and how far it may go on its own.",
      scope: "agent",
      status: "active",
      settings: [
        s("enabled", "Works on its own", !named, named ? "default" : "soul", "SOUL.md ## Proactive"),
        s("highest", "Highest action", "ask", named ? "default" : "soul", "SOUL.md ## Proactive", "Learned rules can only lower it."),
        s("quiet", "Quiet hours", named ? null : "22:00 to 07:00", named ? "default" : "soul", "SOUL.md ## Proactive"),
        s("cap", "Posts per person per day", 6, "default", "SOUL.md ## Proactive"),
        s("follow-up", "Messages in a thread nobody answered", 2, "code", "MAX_UNANSWERED"),
      ],
      ...(named ? {} : { text: "## Proactive\n- Enabled: yes\n- Highest: ask\n- Quiet hours: 22:00-07:00", textSource: "SOUL.md ## Proactive" }),
    },
    {
      id: "learned-rules",
      title: "Learned proactive rules",
      summary: "How people told the agent to react to things; a rule can only lower how far it goes.",
      scope: "agent",
      status: "active",
      settings: [s("count", "Rules", 1, "learned", "memory: agent-uscout, rules/proactive/")],
      table: { columns: ["What", "Where", "Level", "How", "Taught by", "When"], rows: [["ci red", "COPS", "inform", "one line", "UALICE", "2026-11-01T09:00:00Z"]] },
    },
    {
      id: "policy",
      title: "Policy guardrails",
      summary: "A written policy checked on every tool call and reply.",
      scope: "deployment",
      status: "not-implemented",
      settings: [],
      text: "Designed in the 2026-05-21 policy guardrails field note. No code implements it in this release.",
    },
    {
      id: "budgets",
      title: "Budgets",
      summary: "How much the agent may spend on work nobody asked for.",
      scope: "agent",
      status: "active",
      settings: [
        s("background", "Background spend per day", "1 USD", "default", "SLAUDE_BACKGROUND_BUDGET_USD"),
        s("wake-usd", "One wake may spend", "2 USD", "env", "SLAUDE_WAKE_MAX_USD"),
      ],
    },
  ];
  // Operators see redaction counts, never patterns (kept for parity with the API).
  void isSuper;
  return { agent, families };
}

// --- Owner guardrails ---------------------------------------------------------

const MAIL_MD = [
  "---",
  "name: no-outbound-email",
  "description: The agent drafts email but never sends it.",
  "scope: shared",
  "---",
  "",
  "Draft email for people to send. Never send it yourself.",
  "",
  "```rules",
  "- id: no-send",
  "  on: tool",
  "  match:",
  '    tool: "mcp__*__*send*"',
  "  action: deny",
  '  message: "Sending email is not allowed; save a draft instead."',
  "- id: no-prices",
  "  on: reply",
  "  match:",
  '    text: "(?i)\\b(price|quote)\\b"',
  "  action: approve",
  "```",
].join("\n");
const CARE_MD = "---\nname: invoice-care\ndescription: How invoices are handled\nload: on-match\ntriggers: { inbound: '(?i)invoice' }\n---\n\nInvoices go to the finance team. Never promise a payment date.";
const TRIAGE_MD = [
  "---",
  "name: triage-channels",
  "description: Triage stays in the team channel.",
  "scope: agents",
  "agents: [triage, ghost]",
  "channels: [CTEAM]",
  "---",
  "",
  "Keep triage notes short.",
  "",
  "```rules",
  "- id: no-secrets-in",
  "  on: inbound",
  "  match:",
  '    text: "(?i)password\\s*[:=]"',
  "  action: deny",
  '  message: "Please do not paste passwords here."',
  "- id: broken",
  "  on: inbound",
  "  match: { text: '(' }",
  "  action: deny",
  "```",
].join("\n");

const guardrailEnabled = new Map<string, boolean>();

function ownerGuardrails(now: number): OwnerGuardrailDetail[] {
  const base = { authorEnabled: true, unknownAgents: [] as string[], appliesToNoAgent: false, skippedFor: [] as string[], override: false, behindSource: false, canToggle: true };
  const tm = { db: "pg" as const, turnsRunOn: "nodes" as const, strong: true, keySource: "master-key" as const };
  const list: OwnerGuardrailDetail[] = [
    {
      ...base,
      slug: "no-outbound-email", name: "no-outbound-email", description: "The agent drafts email but never sends it.", scope: "shared", agents: [], channels: [],
      enabled: true, active: true, load: "always", ruleCounts: { tool: 1, reply: 1, inbound: 0 }, guidance: true, errorCount: 0, source: "git", lastFiredAt: now - 2 * HOUR,
      md: MAIL_MD, prose: "Draft email for people to send. Never send it yourself.",
      rules: [
        { id: "no-send", on: "tool", action: "deny", message: "Sending email is not allowed; save a draft instead.", status: "enforced", tool: ["mcp__*__*send*"] },
        { id: "no-prices", on: "reply", action: "approve", message: "", status: "enforced", text: "(?i)\\b(price|quote)\\b" },
      ],
      errors: [], triggers: null,
      appliesTo: { agents: [...AGENTS], channels: [], everyChannel: true },
      firings: [{ id: "f1", at: now - 2 * HOUR, action: "guardrail.tool.denied", ruleId: "no-send", agent: "scout", channel: { id: "CTEAM", label: "#team-channel" }, decision: "deny" }],
      threatModel: tm,
    },
    {
      ...base,
      slug: "invoice-care", name: "invoice-care", description: "How invoices are handled", scope: "shared", agents: [], channels: [],
      enabled: true, active: true, load: "on-match", ruleCounts: { tool: 0, reply: 0, inbound: 0 }, guidance: true, errorCount: 0, source: "file", lastFiredAt: null,
      md: CARE_MD, prose: "Invoices go to the finance team. Never promise a payment date.", rules: [], errors: [],
      triggers: { tool: [], inbound: "(?i)invoice", channels: [] },
      appliesTo: { agents: [...AGENTS], channels: [], everyChannel: true }, firings: [], threatModel: tm,
    },
    {
      ...base,
      slug: "triage-channels", name: "triage-channels", description: "Triage stays in the team channel.", scope: "agents", agents: ["triage", "ghost"],
      channels: [{ id: "CTEAM", label: "#team-channel" }], unknownAgents: ["ghost"], override: true, behindSource: true,
      enabled: true, active: true, load: "always", ruleCounts: { tool: 0, reply: 0, inbound: 1 }, guidance: true, errorCount: 1, source: "git", lastFiredAt: null,
      md: TRIAGE_MD, prose: "Keep triage notes short.",
      rules: [{ id: "no-secrets-in", on: "inbound", action: "deny", message: "Please do not paste passwords here.", status: "enforced", text: "(?i)password\\s*[:=]" }],
      errors: ["rule broken match.text is not a valid pattern (error parsing regexp: missing closing ): `(?s)(`)"], triggers: null,
      appliesTo: { agents: ["triage"], channels: [{ id: "CTEAM", label: "#team-channel" }], everyChannel: false }, firings: [], threatModel: tm,
    },
  ];
  return list.map((g) => {
    const enabled = guardrailEnabled.get(g.slug) ?? g.enabled;
    return { ...g, enabled, active: enabled };
  });
}

const summaryOf = (d: OwnerGuardrailDetail): OwnerGuardrailSummary => {
  const { md: _md, prose: _p, rules: _r, errors: _e, triggers: _t, appliesTo: _a, firings: _f, threatModel: _tm, canToggle: _c, ...s } = d;
  return s;
};

export function ownerGuardrailList(now: number, isSuper: boolean): OwnerGuardrailsResponse {
  return {
    guardrails: ownerGuardrails(now).map(summaryOf),
    version: 7,
    failure: null,
    threatModel: { db: "pg", turnsRunOn: "nodes", strong: true, keySource: "master-key" },
    proseMax: 4000,
    canToggle: isSuper,
  };
}

export function ownerGuardrailDetail(slug: string, now: number, isSuper: boolean): OwnerGuardrailDetail | null {
  const d = ownerGuardrails(now).find((g) => g.slug === slug);
  return d ? { ...d, canToggle: isSuper } : null;
}

export function setOwnerGuardrailEnabled(slug: string, enabled: boolean): boolean {
  if (!ownerGuardrails(0).some((g) => g.slug === slug)) return false;
  guardrailEnabled.set(slug, enabled);
  return true;
}

export function agentGuardrailFixtures(agent: string, now: number): AgentGuardrailsResponse {
  const mine = ownerGuardrails(now).filter((g) => g.active && g.appliesTo.agents.includes(agent));
  return {
    agent,
    guardrails: mine.map((g) => ({ ...summaryOf(g), via: g.scope === "shared" ? "shared" : "agent", channelLimited: g.channels.length > 0, skipped: false })),
    prose: { chars: mine.filter((g) => g.load === "always").reduce((n, g) => n + g.prose.length, 0), max: 4000, skipped: [] },
    failure: null,
  };
}
