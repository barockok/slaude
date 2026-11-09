/**
 * Resources fixtures (skills and guardrails) for the dev stub and the
 * Playwright smoke tests. Generic placeholder names only.
 */
import type {
  AgentGuardrailsResponse,
  AgentSettingsGroup,
  AgentSettingsResponse,
  GuardrailTestRequest,
  GuardrailTestResponse,
  GuardrailValidation,
  GuardrailWriteError,
  GuardrailWriteResponse,
  OwnerGuardrailDetail,
  OwnerGuardrailRule,
  OwnerGuardrailsResponse,
  OwnerGuardrailSummary,
  OwnerRuleAction,
  SettingsFamily,
  SkillDetailResponse,
  SkillVersionDetailResponse,
} from "../../../gateway/panel/api-types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const AGENTS = ["default", "scout", "triage"];

const skill = (s: Omit<SkillDetailResponse, "frontmatter" | "body" | "rawTruncated" | "currentVersion"> & { frontmatter?: Record<string, unknown>; currentVersion?: number | null }): SkillDetailResponse => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(s.raw);
  return { frontmatter: s.frontmatter ?? { name: s.name, description: s.description }, body: m ? m[2]! : s.raw, rawTruncated: false, currentVersion: null, ...s };
};

/** Recorded versions by skill id, newest first. */
export function skillVersionFixtures(now: number): Record<string, SkillVersionDetailResponse[]> {
  return {
    "base:release-notes": [
      {
        version: 2,
        hash: "9f2c6a1d4e8b73056a1f2d3c4b5a69788796a5b4c3d2e1f00112233445566778",
        capturedAt: now - 3 * DAY,
        origin: "installed",
        fileCount: 3,
        totalBytes: 1862,
        skillMdTruncated: false,
        skillMd: "---\nname: release-notes\ndescription: Draft release notes from merged pull requests.\n---\n# Release notes\n\nGroup changes by **category**.\n",
      },
      {
        version: 1,
        hash: "1b7e4c2f90a3d856c7e1f4a2b3d5c6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a4b",
        capturedAt: now - 40 * DAY,
        origin: "installed",
        fileCount: 2,
        totalBytes: 1204,
        skillMdTruncated: false,
        skillMd: "---\nname: release-notes\ndescription: Draft release notes.\n---\n# Release notes\n\nList the merged pull requests.\n",
      },
    ],
  };
}

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
      currentVersion: 2,
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

const s = (key: string, label: string, value: SettingsFamily["settings"][number]["value"], source: SettingsFamily["settings"][number]["source"], origin?: string, note?: string) => ({
  key, label, value, source, ...(origin ? { origin } : {}), ...(note ? { note } : {}),
});

/** The agent settings groups (the old Guardrails section, now on Access, Memory and Mandates). */
export function agentSettingsFixtures(agent: string, group: AgentSettingsGroup, isSuper = true): AgentSettingsResponse {
  const named = agent !== "default";
  const all: Record<AgentSettingsGroup, SettingsFamily[]> = {
    access: [
      {
        id: "approvals",
        title: "Approvals",
        summary: "Who must say yes before the agent does something it asks about (request_approval, shared memory writes).",
        scope: "agent",
        status: "active",
        settings: named
          ? [
              s("approvers", "Approvers", ["UALICE", "UBOB"], "soul", "approvers and managers of this agent (grants)", "Every approver may approve any request; scope keywords are not matched for a named agent."),
              s("timeout", "An approval waits for", "300 seconds", "default"),
            ]
          : [
              s("approvers", "Approvers", ["UALICE"], "soul", "SOUL.md approvers", "Matched per request: catch-all approvers always, others when their scope words appear in the request."),
              s("timeout", "An approval waits for", "600 seconds", "soul", "this agent's soul (approval timeout)"),
            ],
        ...(named ? {} : { table: { columns: ["Approver", "Scope"], rows: [["UALICE", "deploys"]] } }),
        text: "## Approvers\n\n- <@UALICE> for **deploys** and anything that touches production",
        textSource: "SOUL.md",
      },
      {
        id: "tool-permissions",
        title: "Permission cards",
        summary: "Which tool calls run without asking, and who may decide a permission card.",
        scope: "deployment",
        status: "active",
        settings: [
          s("auto-allow", "Always allowed tools", ["Read", "kb_memoize", "memory_save"], "env", "SLAUDE_AUTO_ALLOW_TOOLS", "A memory tool listed under either name (memory_save or kb_memoize) allows both."),
          s("default-mode", "Permission mode of a new thread", "default", "default", "SLAUDE_DEFAULT_MODE"),
          s("card-ttl", "A permission card waits for", "60 minutes", "code", "PERM_GATE_TTL_MS"),
          s("deciders", "Who may decide a card", "The person who asked, the /1on1 lock owner, or an approver or manager of this agent", "code", "access/permission-auth.ts canDecidePermission"),
        ],
        table: { columns: ["Permission mode", "Threads of this agent"], rows: [["acceptEdits", "2"], ["default", "41"]] },
        text: "Calls that never post a card:\n\n- tools listed in `SLAUDE_AUTO_ALLOW_TOOLS`;\n- `list_skills` and `read_skill`.\n\nEverything else posts a permission card: *Allow once*, *Always allow* or *Deny*.",
        textSource: "gateway/slack/permission-gate.ts permissionPolicy",
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
        text: "For a message from a person in a channel, in this order:\n\n1. a **deny** for the person drops it;\n2. a **manager** is always admitted;\n3. anything else needs a grant.",
        textSource: "access/admission.ts admit",
      },
      {
        id: "redaction",
        title: "Redaction",
        summary: "Text that never leaves in a reply or a console view.",
        scope: "agent",
        status: "active",
        settings: [
          s("patterns", "Redacted from replies (default + own)", isSuper ? ["internal-\\d+"] : "1 pattern", "soul", "the default agent's soul plus this agent's own"),
          s("secrets", "Secret shapes masked", "9 kinds (keys, tokens, bearer headers, JWTs)", "code", "redact/index.ts"),
        ],
      },
    ],
    memory: [
      {
        id: "memory-gating",
        title: "Memory write gating",
        summary: "What the agent may read and write in memory without asking.",
        scope: "agent",
        status: "active",
        settings: [
          s("own-slice", "Its own memory", named ? `agent-u${agent}` : "agent-udefault", "code"),
          s("standing-grant", "One approval covers later writes in the thread for", "30 minutes", "default", "SLAUDE_KB_GRANT_TTL_MS"),
        ],
        table: {
          columns: ["Tier", "Operations", "Rule"],
          rows: [
            ["Reads", "memory_search, memory_think", "Always allowed"],
            ["Own writes", "memory_save", "Allowed without asking in the agent's own memory, and on background turns"],
            ["Shared writes", "memory_save", "Need approval in a trusted channel or from a manager; refused elsewhere"],
            ["Destructive", "memory_delete", "Need approval; refused in a public channel for anyone but a manager"],
          ],
        },
        textSource: "knowledge/gated-dispatch.ts classifyBrainOp",
      },
      {
        id: "profile-guard",
        title: "Profile write guard",
        summary: "A person's profile and learned rules are written only on that person's own turn.",
        scope: "deployment",
        status: "active",
        settings: [s("tools", "Refused on turns nobody asked for", ['memory_save (target "profile")', "proactive_rule"], "code", "agent/profile-write-guard.ts")],
      },
    ],
    mandates: [
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
        id: "wake-tools",
        title: "Wake tool allow-list",
        summary: "What the agent may call when it wakes on its own, with nobody in the turn.",
        scope: "deployment",
        status: "active",
        settings: [],
        table: { columns: ["Tool server", "Allowed tools"], rows: [["surface", "pass, proactive_post"], ["slaude_kb", "memory_search, memory_think"]] },
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
    ],
    "learned-rules": [
      {
        id: "learned-rules",
        title: "Learned proactive rules",
        summary: "How people told the agent to react to things; a rule can only lower how far it goes.",
        scope: "agent",
        status: "active",
        settings: [s("count", "Rules", 1, "learned", `memory: agent-u${agent}, rules/proactive/`)],
        table: { columns: ["What", "Where", "Level", "How", "Taught by", "When"], rows: [["ci red", "COPS", "inform", "one line", "UALICE", "2026-11-01T09:00:00Z"]] },
      },
    ],
  };
  return { agent, group, families: all[group] };
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

const TRIAGE_SOURCE_MD = TRIAGE_MD.replace("Keep triage notes short.", "Keep triage notes short and kind.");

const guardrailEnabled = new Map<string, boolean>();
/** Console writes in this tab: the text a guardrail has now, its revision, and its override. */
const edits = new Map<string, { md: string; revision: number; override?: { sourceMd: string; author: string; at: number } | null }>();
const created = new Map<string, { md: string; revision: number; at: number }>();
const deleted = new Set<string>();
/** Guardrails stored before their name was reserved (the stub's ?stubReservedGuardrail=1). */
const legacy = new Map<string, { md: string; source: "file" | "git" }>();
let setVersion = 7;

/** Store a guardrail named like a console page ("test"), as an upgraded deployment may have. */
export function addLegacyGuardrail(slug: string, md: string, source: "file" | "git" = "file"): void {
  legacy.set(slug, { md, source });
}

const ALLOWED: Record<OwnerGuardrailRule["on"], OwnerRuleAction[]> = { tool: ["deny", "approve", "audit"], reply: ["deny", "approve", "redact", "audit"], inbound: ["deny", "audit"] };

/** A rough stand-in for the server's parser (the stub runs in the browser): frontmatter fields, rules, the problems that refuse a save. */
export function stubParse(slug: string, md: string) {
  const errors: string[] = [];
  const blocking: string[] = [];
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  const field = (k: string) => (fm ? new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm[1]!)?.[1]?.trim() ?? null : null);
  if (!fm) errors.push("no frontmatter (a --- block with name and description) at the top");
  const name = field("name");
  if (fm && name !== slug) errors.push(`frontmatter: name '${name ?? ""}' differs from the guardrail's folder '${slug}'`);
  const body = fm ? fm[2]! : md;
  const block = /```rules\n([\s\S]*?)```/.exec(body);
  const prose = body.replace(/```rules\n[\s\S]*?```/, "").trim();
  const rules: OwnerGuardrailRule[] = [];
  if (block) {
    for (const chunk of block[1]!.split(/^- /m).slice(1)) {
      const get = (k: string) => new RegExp(`^\\s*${k}:\\s*["']?(.*?)["']?\\s*$`, "m").exec(chunk)?.[1] ?? "";
      const id = get("id");
      const on = get("on") as OwnerGuardrailRule["on"];
      const action = get("action") as OwnerRuleAction;
      const label = `rule ${id || rules.length + 1}`;
      if (!ALLOWED[on]) { blocking.push(`${label}: on: Invalid enum value`); continue; }
      if (!ALLOWED[on].includes(action)) { blocking.push(`${label}: action ${action} is not available for on: ${on} (${ALLOWED[on].join(", ")})`); continue; }
      const text = /text:\s*["']?(.*?)["']?\s*\}?\s*$/m.exec(chunk)?.[1];
      if (text !== undefined && on !== "tool") {
        try { new RegExp(text.replace(/^\(\?i\)/, "")); } catch { blocking.push(`${label} match.text is not a valid pattern`); continue; }
      }
      const tool = /tool:\s*["']?([^"'\n}]+)["']?/.exec(chunk)?.[1]?.trim();
      rules.push({ id, on, action, message: get("message"), status: "enforced", ...(on === "tool" && tool ? { tool: [tool] } : {}), ...(on !== "tool" && text ? { text } : {}) });
    }
  }
  for (const b of blocking) errors.push(b);
  const scope = (field("scope") === "agents" ? "agents" : "shared") as "shared" | "agents";
  const agents = scope === "agents" ? (field("agents") ?? "").replace(/[[\]]/g, "").split(",").map((x) => x.trim()).filter(Boolean) : [];
  const load = (field("load") === "on-match" ? "on-match" : "always") as "always" | "on-match";
  return { name: name ?? slug, description: field("description") ?? "", scope, agents, load, prose, rules, errors, blocking };
}

function fromText(slug: string, md: string, base: Partial<OwnerGuardrailDetail>, tm: OwnerGuardrailDetail["threatModel"]): OwnerGuardrailDetail {
  const p = stubParse(slug, md);
  const count = (on: string) => p.rules.filter((r) => r.on === on).length;
  return {
    authorEnabled: true, unknownAgents: p.agents.filter((a) => !AGENTS.includes(a)), appliesToNoAgent: false, skippedFor: [], override: false, behindSource: false,
    canToggle: true, canEdit: true, enabled: true, active: true, source: "console", lastFiredAt: null, firings: [], channels: [], triggers: null, deletable: true, overrideOf: null, revision: setVersion,
    ...base,
    slug, md, name: p.name, description: p.description, scope: p.scope, agents: p.agents, load: p.load, prose: p.prose, rules: p.rules,
    ruleCounts: { tool: count("tool"), reply: count("reply"), inbound: count("inbound") }, guidance: p.prose.length > 0, errors: p.errors, errorCount: p.errors.length,
    appliesTo: { agents: p.scope === "shared" ? [...AGENTS] : p.agents.filter((a) => AGENTS.includes(a)), channels: base.channels ?? [], everyChannel: !(base.channels ?? []).length },
    threatModel: tm,
  };
}


function ownerGuardrails(now: number): OwnerGuardrailDetail[] {
  const base = { authorEnabled: true, unknownAgents: [] as string[], appliesToNoAgent: false, skippedFor: [] as string[], override: false, behindSource: false, canToggle: true, canEdit: true, revision: 5, deletable: false, overrideOf: null };
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
      overrideOf: { sourceMd: TRIAGE_SOURCE_MD, author: "lead@example.com", updatedAt: now - 3 * DAY },
    },
  ];
  for (const [slug, l] of legacy) list.push(fromText(slug, l.md, { source: l.source, deletable: false, revision: 5 }, tm));
  const out: OwnerGuardrailDetail[] = list.map((g) => {
    const e = edits.get(g.slug);
    if (!e) return g;
    const override = e.override === undefined ? g.overrideOf : e.override ? { sourceMd: e.override.sourceMd, author: e.override.author, updatedAt: e.override.at } : null;
    const md = e.override === null ? (g.overrideOf?.sourceMd ?? g.md) : e.md;
    return fromText(g.slug, md, { ...g, revision: e.revision, override: !!override, behindSource: !!override && g.behindSource && e.override === undefined, overrideOf: override }, tm);
  });
  for (const [slug, c] of created) {
    const e = edits.get(slug);
    out.push(fromText(slug, e?.md ?? c.md, { revision: e?.revision ?? c.revision }, tm));
  }
  return out
    .filter((g) => !deleted.has(g.slug))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((g) => {
      const enabled = guardrailEnabled.get(g.slug) ?? g.enabled;
      return { ...g, enabled, active: enabled };
    });
}

const summaryOf = (d: OwnerGuardrailDetail): OwnerGuardrailSummary => {
  const { md: _md, prose: _p, rules: _r, errors: _e, triggers: _t, appliesTo: _a, firings: _f, threatModel: _tm, canToggle: _c, canEdit: _ce, revision: _rv, deletable: _d, overrideOf: _o, ...s } = d;
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
    canEdit: isSuper,
  };
}

export function ownerGuardrailDetail(slug: string, now: number, isSuper: boolean): OwnerGuardrailDetail | null {
  const d = ownerGuardrails(now).find((g) => g.slug === slug);
  return d ? { ...d, canToggle: isSuper, canEdit: isSuper } : null;
}

export function setOwnerGuardrailEnabled(slug: string, enabled: boolean): boolean {
  const g = ownerGuardrails(0).find((x) => x.slug === slug);
  if (!g) return false;
  if (g.enabled !== enabled) {
    guardrailEnabled.set(slug, enabled);
    bump(slug, g.md, undefined);
  }
  return true;
}

function bump(slug: string, md: string, override: { sourceMd: string; author: string; at: number } | null | undefined): number {
  setVersion += 1;
  const prev = edits.get(slug);
  edits.set(slug, { md, revision: setVersion, override: override === undefined ? prev?.override : override });
  return setVersion;
}

type Refused = { status: number; body: GuardrailWriteError };
const refuse = (status: number, body: GuardrailWriteError): Refused => ({ status, body });
const RESERVED = ["new", "test"];

/** The dev stub's create, edit, clear and delete: the server's rules and answers, on the fixtures. */
export function writeOwnerGuardrail(
  op: "create" | "edit" | "clear" | "delete",
  slug: string,
  body: { md?: string; revision?: number },
  operator: string,
): { status: number; body: GuardrailWriteResponse | GuardrailWriteError } {
  const all = ownerGuardrails(0);
  const g = all.find((x) => x.slug === slug);
  const check = (md: string): Refused | null => {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return refuse(422, { error: `invalid guardrail name '${slug}'`, code: "invalid" });
    if (op === "create" && !g && RESERVED.includes(slug)) return refuse(422, { error: `'${slug}' is reserved for a new guardrail; choose another name`, code: "invalid" });
    const p = stubParse(slug, md);
    return p.blocking.length ? refuse(422, { error: `guardrail '${slug}' refused: ${p.blocking.join("; ")}`, code: "invalid", blocking: p.blocking, errors: p.errors }) : null;
  };
  const stale = (): Refused | null =>
    g && body.revision !== g.revision ? refuse(409, { error: `guardrail '${slug}' changed since it was loaded (revision ${body.revision}, now ${g.revision}). Reload it and apply your change again.`, code: "stale", revision: g.revision }) : null;
  if (op === "create") {
    const bad = check(body.md ?? "");
    if (bad) return bad;
    if (g) return refuse(409, { error: `a guardrail named '${slug}' already exists`, code: "exists", revision: g.revision });
    setVersion += 1;
    created.set(slug, { md: body.md!, revision: setVersion, at: Date.now() });
    deleted.delete(slug);
    return { status: 201, body: { ok: true, slug, change: "created", revision: setVersion, version: setVersion } };
  }
  if (!g) return refuse(404, { error: `no guardrail named '${slug}'` });
  const conflict = stale();
  if (conflict) return conflict;
  if (op === "edit") {
    const bad = check(body.md ?? "");
    if (bad) return bad;
    if (body.md === g.md) return { status: 200, body: { ok: true, slug, change: "unchanged", revision: g.revision, version: setVersion } };
    const isConsole = g.source === "console";
    const v = bump(slug, body.md!, isConsole ? undefined : { sourceMd: g.overrideOf?.sourceMd ?? g.md, author: operator, at: Date.now() });
    return { status: 200, body: { ok: true, slug, change: isConsole ? "updated" : "override.set", revision: v, version: v } };
  }
  if (op === "clear") {
    if (!g.override) return refuse(404, { error: `guardrail '${slug}' has no console override`, code: "no-override" });
    const v = bump(slug, g.overrideOf?.sourceMd ?? g.md, null);
    return { status: 200, body: { ok: true, slug, change: "override.cleared", revision: v, version: v } };
  }
  if (g.source !== "console") {
    return refuse(422, { error: `guardrail '${slug}' comes from ${g.source === "git" ? "the deploy repo" : "host files"} and cannot be deleted from the console; switch it off here, or remove it at its source`, code: "not-deletable" });
  }
  setVersion += 1;
  deleted.add(slug);
  created.delete(slug);
  edits.delete(slug);
  return { status: 200, body: { ok: true, slug, change: "deleted", revision: null, version: setVersion } };
}

export function validateOwnerGuardrail(slug: string, md: string): GuardrailValidation {
  const p = stubParse(slug, md);
  const blocking = [...p.blocking];
  if (RESERVED.includes(slug) && !ownerGuardrails(0).some((g) => g.slug === slug)) blocking.unshift(`'${slug}' is reserved for a new guardrail; choose another name`);
  const unknownAgents = p.agents.filter((a) => !AGENTS.includes(a));
  const appliesTo = p.scope === "shared" ? [...AGENTS] : p.agents.filter((a) => AGENTS.includes(a));
  const chars = p.load === "always" ? p.prose.length : 0;
  return {
    slug, ok: blocking.length === 0, errors: [...blocking.filter((b) => !p.errors.includes(b)), ...p.errors], blocking,
    name: p.name, description: p.description, scope: p.scope, load: p.load, rules: p.rules, unknownAgents, appliesTo,
    prose: { chars, max: 4000, overCap: chars > 4000 ? appliesTo.map((agent) => ({ agent, chars, skipped: [{ slug, name: p.name, chars }] })) : [] },
  };
}

const RANK: Record<OwnerRuleAction, number> = { deny: 4, approve: 3, redact: 2, audit: 1 };
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
const textRe = (t: string) => new RegExp(t.replace(/^\(\?i\)/, ""), t.startsWith("(?i)") ? "is" : "s");

/** The dev stub's Test box: a rough evaluation over the fixtures (the server runs the runtime's own matcher). */
export function testOwnerGuardrails(req: GuardrailTestRequest): GuardrailTestResponse {
  let set = ownerGuardrails(0).filter((g) => g.active && g.appliesTo.agents.includes(req.agent));
  let draft: GuardrailTestResponse["draft"] = null;
  if (req.draft) {
    const stored = ownerGuardrails(0).find((g) => g.slug === req.draft!.slug);
    const replaced = !!stored;
    const d = fromText(req.draft.slug, req.draft.md, {}, set[0]?.threatModel ?? { db: "pg", turnsRunOn: "nodes", strong: true, keySource: "master-key" });
    set = [...set.filter((g) => g.slug !== req.draft!.slug), d];
    draft = { slug: req.draft.slug, errors: d.errors, blocking: stubParse(req.draft.slug, req.draft.md).blocking, replaced, switchedOff: !!stored && !stored.enabled };
  }
  const subject = req.kind === "tool" ? (req.tool ?? "") : (req.text ?? "");
  const rules = set.flatMap((g) => g.rules.filter((r) => r.on === req.kind).map((r) => ({ g, r })));
  const tooLarge = subject.length + (req.input?.length ?? 0) > 1024 * 1024;
  const hitsRaw = rules.filter(({ r }) => {
    try {
      if (req.kind === "tool") return (r.tool ?? []).some((t) => globRe(t).test(subject));
      return !!r.text && (textRe(r.text).test(subject) || (tooLarge && r.action !== "audit"));
    } catch {
      return false;
    }
  });
  let deciding = hitsRaw[0];
  for (const h of hitsRaw) if (deciding && RANK[h.r.action] > RANK[deciding.r.action]) deciding = h;
  const msg = (slug: string, m: string) => m || `Blocked by the owner's guardrail ${slug}.`;
  const hits = hitsRaw.map((h) => ({ slug: h.g.slug, ruleId: h.r.id, action: h.r.action, message: msg(h.g.slug, h.r.message), oversize: tooLarge && req.kind !== "tool", deciding: h === deciding, draft: !!draft && h.g.slug === draft.slug }));
  const d = hits.find((h) => h.deciding) ?? null;
  const outcome = !d
    ? req.kind === "tool" ? "Allowed (no enforced rule matched)." : req.kind === "reply" ? "Posted as is (no enforced rule matched)." : "Passed on to the agent (no enforced rule matched)."
    : d.action === "deny" ? `${req.kind === "inbound" ? "Not passed on. The person is told:" : req.kind === "reply" ? "Not posted:" : "Refused:"} ${d.message}`
    : d.action === "approve" ? "Held on an approval card for the requester or an approver."
    : d.action === "redact" ? "Posted with every match replaced by [REDACTED]." : "Allowed and recorded in the audit trail.";
  const always = set.filter((g) => g.load === "always" && g.prose).map((g) => ({ slug: g.slug, name: g.name, chars: g.prose.length }));
  const onMatch = set.filter((g) => g.load === "on-match" && g.prose);
  const delivered = req.kind === "inbound" ? onMatch.filter((g) => g.triggers?.inbound && textRe(g.triggers.inbound).test(subject)) : [];
  let posted: string | undefined;
  if (req.kind === "reply" && (!d || d.action === "redact" || d.action === "audit")) {
    posted = hitsRaw.filter((h) => h.r.action === "redact" && h.r.text).reduce((t, h) => t.replace(new RegExp(textRe(h.r.text!).source, `${textRe(h.r.text!).flags}g`), "[REDACTED]"), subject);
  }
  return {
    agent: req.agent, channel: req.channel ?? null, kind: req.kind, rulesChecked: rules.length, hits,
    decision: d ? { action: d.action, slug: d.slug, ruleId: d.ruleId, message: d.message, oversize: d.oversize } : null,
    outcome, ...(posted !== undefined ? { posted } : {}), tooLarge: hits.some((h) => h.oversize),
    guidance: {
      always, skipped: [], delivered: delivered.map((g) => ({ slug: g.slug, name: g.name, via: "inbound" as const })),
      indexed: onMatch.filter((g) => !delivered.includes(g)).map((g) => ({ slug: g.slug, name: g.name })),
      proseChars: always.reduce((n, g) => n + g.chars, 0), proseMax: 4000,
    },
    draft,
  };
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
