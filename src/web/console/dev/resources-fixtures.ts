/**
 * Resources fixtures (skills and guardrails) for the dev stub and the
 * Playwright smoke tests. Generic placeholder names only.
 */
import type { GuardrailFamily, GuardrailsResponse, SkillDetailResponse } from "../../../gateway/panel/api-types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const AGENTS = ["default", "scout", "triage"];

const skill = (s: Omit<SkillDetailResponse, "frontmatter" | "body"> & { frontmatter?: Record<string, unknown> }): SkillDetailResponse => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(s.raw);
  return { frontmatter: s.frontmatter ?? { name: s.name, description: s.description }, body: m ? m[2]! : s.raw, ...s };
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

export function guardrailFixtures(agent: string): GuardrailsResponse {
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
  return { agent, families };
}
