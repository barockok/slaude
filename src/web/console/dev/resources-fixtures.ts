/**
 * Resources fixtures (skills and guardrails) for the dev stub and the
 * Playwright smoke tests. Generic placeholder names only.
 */
import type { GuardrailEntry, GuardrailFamily, GuardrailsResponse, SkillDetailResponse } from "../../../gateway/panel/api-types";

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

export function guardrailFixtures(agent: string, isSuper = true): GuardrailsResponse {
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
  return { agent, ...runtimeLayerFixtures(agent, isSuper), families };
}

const MGR: GuardrailEntry["appliesTo"] = ["interactive", "wake", "remote", "voice"];
const ALWAYS = { source: "none" as const };
const g = (e: Partial<GuardrailEntry> & Pick<GuardrailEntry, "id" | "kind" | "title" | "summary" | "effect" | "state" | "source">): GuardrailEntry => ({
  appliesTo: MGR,
  toggle: ALWAYS,
  details: [],
  ...e,
});

const BASELINE = [
  { id: "preamble", title: "Preamble", markdown: "<runtime-baseline>\nYou operate as a Claude Code agent reachable through Slack. This block defines how the runtime expects you to\nbehave: non-negotiable rules that apply regardless of persona.\n\n" },
  { id: "slack-output-discipline", title: "Slack output discipline", markdown: "## Slack output discipline\n- The user only sees what you send through `mcp__slaude_surface__reply`.\n- Never narrate tool calls.\n\n" },
  { id: "channel-trust", title: "Channel trust", markdown: "## Channel trust\n- Every inbound `<channel>` envelope carries a `trust` attribute:\n  - `trusted`: internal team channel.\n  - `allowed`: public channel; avoid internal dumps.\n\n" },
  { id: "memory-gbrain-one-write-path-memory-save", title: "Memory (gbrain, one write path: `memory_save`)", markdown: "## Memory (gbrain, one write path: `memory_save`)\n- Knowledge bases live under `$SLAUDE_HOME/knowledge/<label>/`.\n\n" },
  { id: "built-in-skills-read-only-shipped-with-slaude", title: "Built-in skills (read-only, shipped with slaude)", markdown: "## Built-in skills (read-only, shipped with slaude)\nLoad the named skill with the Skill tool before the matching action; the runtime blocks the action until you do.\n- Writing or changing a skill → load `slaude:skill-authoring`\n\n" },
  { id: "harness-overrides-slaude-supersedes-sdk-defaults", title: "Harness overrides (slaude supersedes SDK defaults)", markdown: "## Harness overrides (slaude supersedes SDK defaults)\n- **Cron, slaude runtime only.** The SDK tools `CronCreate` and `CronDelete` are blocked.\n</runtime-baseline>" },
];

function runtimeLayerFixtures(agent: string, isSuper: boolean): Omit<GuardrailsResponse, "agent" | "families"> {
  const tab = { label: "Mandates tab", to: `/agents/${agent}/mandates` };
  return {
    promptStack: {
      layers: [
        { id: "preset", title: "Claude Code preset", overridable: false, source: "SDK systemPrompt preset claude_code (slaude only appends)", present: true },
        { id: "runtime-baseline", title: "Runtime baseline", overridable: false, source: "soul/runtime/core.md via runtimeBaseline()", present: true, note: "The same for every agent of this deployment; blocks below." },
        { id: "persona", title: "Persona (the soul)", overridable: true, source: agent === "default" ? "the default agent's soul" : `${agent}'s soul`, present: true, link: tab },
        { id: "channel-mandate", title: "Channel mandate", overridable: true, source: "the soul's ## Channel blocks", present: agent === "default", count: agent === "default" ? 2 : 0, note: "Replaces the soul's Mandate for that channel only.", link: tab },
        { id: "session-mode", title: "Session mode", overridable: false, source: "agent/session-mode.ts sessionModeBlock", present: true, note: "Only in a /1on1 or remote thread." },
        { id: "mcp-servers", title: "MCP servers", overridable: false, source: "agent/manager.ts #buildSystemAppend", present: true, note: "The namespaces mounted for the session." },
        { id: "memory-context", title: "Memory context", overridable: false, source: "memory provider prefetch", present: true, note: "When memory has something for the thread." },
      ],
      perTurn: [
        { id: "channel-envelope", title: "Channel envelope", summary: "Each inbound message is wrapped with the channel's trust.", source: "gateway/core/gateway.ts" },
        { id: "session-notes", title: "Session notes", summary: "Out-of-band changes added to the next turn once.", source: "agent/session-notes.ts" },
      ],
    },
    baseline: { deploymentWide: true, brain: true, blocks: BASELINE },
    builtinSkills: [{ name: "skill-authoring", qualified: "slaude:skill-authoring", trigger: "Writing or changing a skill", governs: ["mcp__slaude_skills__write_skill", "mcp__slaude_skills__delete_skill"] }],
    guardrails: [
      {
        kind: "hook",
        entries: [
          g({ id: "hook.stop.must-reply", kind: "hook", event: "Stop", title: "Must reply or pass", summary: "A turn that ends with nothing user-visible is sent back once.", effect: "Blocks the first stop of a turn without a reply or a pass.", state: "enforcing", source: "agent/manager.ts #bootSession (stopHook)" }),
          g({ id: "hook.user-prompt.suppress", kind: "hook", event: "UserPromptSubmit", title: "Disengaged and mention-only suppression", summary: "Recorded but not answered.", effect: "Returns continue: false.", state: "enforcing", toggle: { source: "thread", key: "disengage, or set_mention_only", default: "engaged" }, source: "agent/manager.ts makeUserPromptHook" }),
          g({ id: "hook.pre-tool.remote-deny-local", kind: "hook", event: "PreToolUse", title: "Remote mode local-tool deny", summary: "Local tools refused in a remote thread.", effect: "Denies local-only built-ins.", appliesTo: ["remote"], state: "off", toggle: { source: "env", key: "SLAUDE_REMOTE", default: "off" }, source: "remote/mcp.ts denyLocalBuiltins" }),
          g({ id: "hook.pre-tool.skill-gate", kind: "hook", event: "PreToolUse", title: "Built-in skill gate", summary: "A governed tool waits for its skill.", effect: "Denies until the skill is loaded.", state: "enforcing", details: [{ label: "Governed tools", value: ["mcp__slaude_skills__write_skill"] }], source: "agent/skill-gate.ts SkillGate.pre" }),
          g({ id: "hook.stop.kb-first", kind: "hook", event: "Stop", title: "KB-first Stop guard", summary: "Would block a stop that skipped memory.", effect: "Designed shadow-first; prose only today.", state: "not-built", source: "soul/runtime/core.md (prose only)", fieldNote: { title: "KB-first enforcement: from prose to teeth", href: "https://barockok.github.io/slaude/field-notes/2026-06-13-kb-first-enforcement.html" } }),
        ],
      },
      {
        kind: "gate",
        entries: [
          g({ id: "gate.can-use-tool.permission", kind: "gate", event: "canUseTool", title: "Permission gate", summary: "Allowed, denied, or a card.", effect: "Auto-allows slaude's own tools; denies MCP authenticate; cards the rest.", appliesTo: ["interactive", "remote", "voice"], state: "enforcing", toggle: { source: "thread", key: "/mode", default: "default" }, source: "gateway/slack/permission-gate.ts permissionPolicy" }),
          g({ id: "gate.dispatch.decision", kind: "gate", event: "dispatch", title: "Decision gate", summary: "Whether a message deserves a turn.", effect: "Shadow: scored and logged only.", appliesTo: ["interactive"], state: "shadow", toggle: { source: "env", key: "SLAUDE_DECISION_CONFIG", default: "off" }, details: [{ label: "Mode", value: "shadow" }], source: "decision/config.ts parseDecisionConfig" }),
          g({ id: "gate.policy.tier-2-3", kind: "gate", event: "PreToolUse", title: "Policy guardrails (Tier 2 and 3)", summary: "A written policy on every call.", effect: "Designed; no code.", appliesTo: ["deployment"], state: "not-built", source: "none yet", fieldNote: { title: "Policy guardrails (Tier 2 / Tier 3 design)", href: "https://barockok.github.io/slaude/field-notes/2026-05-21-policy-guardrails.html" } }),
        ],
      },
      {
        kind: "deny-list",
        entries: [
          g({ id: "deny.scheduler-tools", kind: "deny-list", title: "CLI scheduler tools", summary: "slaude's cron tools replace them.", effect: "In every session's disallowedTools.", state: "enforcing", details: [{ label: "Removed", value: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger"] }], source: "agent/manager.ts SCHEDULER_TOOLS" }),
          g({ id: "deny.wake-allow-list", kind: "deny-list", title: "Wake tool allow-list", summary: "What a wake may call.", effect: "Everything else hidden and refused.", appliesTo: ["wake"], state: "enforcing", details: [{ label: "surface", value: ["pass"] }, { label: "kb", value: "every tool" }], source: "proactive/wake-guard.ts" }),
        ],
      },
      {
        kind: "limit",
        entries: [
          g({ id: "limit.wake-caps", kind: "limit", title: "Wake caps", summary: "How far one wake may go.", effect: "maxBudgetUsd and maxTurns on the wake's query.", appliesTo: ["wake"], state: "enforcing", toggle: { source: "env", key: "SLAUDE_WAKE_MAX_USD, SLAUDE_WAKE_MAX_TURNS, SLAUDE_WAKE_MAX_MINUTES" }, details: [{ label: "Spend", value: "2 USD" }, { label: "Turns", value: "40 turns" }], source: "agent/manager.ts #bootSession (wake options)" }),
        ],
      },
      {
        kind: "redaction",
        entries: [
          g({ id: "redact.secrets", kind: "redaction", title: "Secret masking", summary: "Keys and tokens masked wherever text is shown.", effect: "Status line, approval cards, audit, console.", appliesTo: ["deployment"], state: "enforcing", details: [{ label: "Secret shapes", value: 9 }], source: "redact/index.ts redactSecrets" }),
          g({ id: "redact.soul-patterns", kind: "redaction", title: "Soul redaction patterns", summary: "Text that never leaves in a reply.", effect: "Replaced with [REDACTED].", state: "enforcing", toggle: { source: "config", key: "SOUL.md redact patterns" }, details: [{ label: "Patterns", value: isSuper ? ["project-[a-z]+"] : "1 pattern" }], source: "gateway/slack/redact.ts" }),
        ],
      },
      {
        kind: "observability",
        entries: [
          g({ id: "obs.post-tool.skill-usage", kind: "observability", event: "PostToolUse", title: "Skill usage counter", summary: "Counts each successful Skill call.", effect: "Never blocks.", state: "enforcing", source: "agent/skill-usage-hook.ts skillUsageHook" }),
        ],
      },
    ],
  };
}
