/**
 * Read model behind the Guardrails page's collapsed "Soul and access settings"
 * section: what the soul and access settings constrain for one agent, each
 * value with where it comes from (they move to the agent's own tabs later). Every value is read
 * from the code path that enforces it (or the data it reads); nothing here
 * decides or writes.
 *
 *   tool permissions   permission-gate.ts permissionPolicy, autoAllowFromEnv;
 *                      sessions.permission_mode; access/permission-auth.ts
 *   approvals          approval-gate.ts #resolveApprovers (approversFor for a
 *                      named agent, the soul chain for the default one)
 *   admission          access/admission.ts admit over access/role.ts loadGrants
 *   memory gating      knowledge/gated-dispatch.ts classifyBrainOp
 *   profile guard      agent/profile-write-guard.ts
 *   policy guardrails  designed (2026-05-21 field note), not implemented
 *   redaction          gateway/slack/redact.ts (soul patterns), redact/index.ts
 *   proactive          soul/proactive.ts parseProactive, proactive/restraint.ts,
 *                      heartbeat.ts and wake-tools.ts caps
 *   learned rules      proactive/rules.ts loadRules (brain pages)
 *   wake tools         proactive/wake-guard.ts
 *   budgets            background/config.ts budgetConfigFor; env wake caps
 */
import { env } from "../../config/env";
import { db } from "../../db/schema";
import { autoAllowFromEnv, PERM_GATE_TTL_MS } from "../slack/permission-gate";
import { loadGrants, usersWithRole } from "../../access/role";
import { approvalTimeoutFor, channelApproversOf, redactPatternsFor, soulDataFor } from "../../soul/per-persona";
import { soulData } from "../../soul/extract";
import { loadApprovers } from "../../soul/loader";
import { personaSoulText } from "../../persona/soul-source";
import { parseProactive } from "../../soul/proactive";
import { BRAIN_OP_CLASSES, grantTtlMs } from "../../knowledge/gated-dispatch";
import { agentSourceId } from "../../knowledge/scope";
import { KB_MEMOIZE_MAX_PAGES } from "../../tools/contracts/kb";
import { MEMORY_WRITE_TOOLS, PROACTIVE_RULE_TOOL } from "../../agent/profile-write-guard";
import { SECRET_PATTERN_COUNT } from "../../redact";
import { HEARTBEAT_MAX_POSTS } from "../../proactive/heartbeat";
import { MAX_UNANSWERED } from "../../proactive/wake-tools";
import { UNCHANGED_WINDOW_MS } from "../../proactive/restraint";
import { WAKE_TOOL_ALLOWLIST } from "../../proactive/wake-guard";
import { loadRules, type ProactiveRule } from "../../proactive/rules";
import { brainCallIfOpen } from "../../knowledge/brain";
import { memoryUnavailableReason } from "../../knowledge/memory-browse";
import { budgetConfigFor } from "../../background/config";
import { getPersonaRegistry } from "../../persona/registry";
import { agentIdsByName } from "./skills-view";
import type { GuardrailFamily, GuardrailSetting, GuardrailSettingsResponse, GuardrailSource } from "./api-types";

export interface GuardrailDeps {
  /** The agent's learned proactive rules (default: its brain pages). */
  rules?: (agentId: string) => Promise<ProactiveRule[]>;
}

export interface GuardrailViewer {
  /** Superadmins see redaction pattern values; operators see counts. */
  role: "superadmin" | "operator";
}

const RULES_TIMEOUT_MS = 3000;

/** Set and not blank: the value came from the environment. */
const fromEnv = (name: string): GuardrailSource => ((process.env[name] ?? "").trim() ? "env" : "default");

const setting = (key: string, label: string, value: GuardrailSetting["value"], source: GuardrailSource, origin?: string, note?: string): GuardrailSetting => ({
  key,
  label,
  value,
  source,
  ...(origin ? { origin } : {}),
  ...(note ? { note } : {}),
});

/**
 * The `##` sections of a soul whose heading matches `re`, with their `###`
 * subsections, as written (code fences skipped when looking for headings).
 */
export function soulSections(text: string, re: RegExp): string {
  const out: string[] = [];
  let on = false;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,2}\s/.test(line)) on = /^##\s/.test(line) && re.test(line.replace(/^##\s+/, "").trim());
    if (on) out.push(line);
  }
  return out.join("\n").trim();
}

/** Each `## Channel ...` block's `### Proactive` subsection, under its channel heading. */
function channelProactiveSections(text: string): string {
  const out: string[] = [];
  let channel: string | null = null;
  let on = false;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,2}\s/.test(line)) {
      channel = /^##\s+channel\b/i.test(line) ? line.trim() : null;
      on = false;
      continue;
    }
    if (!fenced && /^###\s/.test(line)) {
      on = channel !== null && /^###\s+proactive\s*$/i.test(line.trim());
      if (on) out.push(channel!, line);
      continue;
    }
    if (on) out.push(line);
  }
  return out.join("\n").trim();
}

const hasKey = (section: string, ...keys: string[]) =>
  keys.some((k) => new RegExp(`^\\s*[-*]\\s*${k.replace(/\s+/g, "\\s+")}\\s*:`, "im").test(section));

const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const list = (xs: readonly string[]) => (xs.length ? [...xs] : []);

function soulText(name: string): string {
  try {
    return personaSoulText(name === "default" ? undefined : name);
  } catch {
    return "";
  }
}

async function modeCounts(name: string): Promise<string[][]> {
  try {
    const rows = await db.query<{ mode: string; n: number | string }>(
      "SELECT permission_mode AS mode, COUNT(*) AS n FROM sessions WHERE persona_id = ? GROUP BY permission_mode ORDER BY permission_mode",
      [name],
    );
    return rows.map((r) => [r.mode, String(Number(r.n))]);
  } catch {
    return [];
  }
}

async function toolPermissions(name: string): Promise<GuardrailFamily> {
  const auto = [...autoAllowFromEnv()].sort();
  const modes = await modeCounts(name);
  return {
    id: "tool-permissions",
    title: "Tool permissions",
    summary: "Which tool calls run without asking, and who may decide a permission card.",
    scope: "deployment",
    status: "active",
    settings: [
      setting("auto-allow", "Always allowed tools", auto, fromEnv("SLAUDE_AUTO_ALLOW_TOOLS"), "SLAUDE_AUTO_ALLOW_TOOLS",
        "A memory tool listed under either name (memory_save or kb_memoize) allows both."),
      setting("default-mode", "Permission mode of a new thread", env.defaultPermissionMode(), fromEnv("SLAUDE_DEFAULT_MODE"), "SLAUDE_DEFAULT_MODE",
        "A thread's own mode is changed with /mode in the thread or from the console (superadmin)."),
      setting("card-ttl", "A permission card waits for", `${PERM_GATE_TTL_MS / 60_000} minutes`, "code", "PERM_GATE_TTL_MS"),
      setting("deciders", "Who may decide a card", "The person who asked, the /1on1 lock owner, or an approver or manager of this agent", "code",
        "access/permission-auth.ts canDecidePermission",
        "A turn nobody asked for (console chat, cron, heartbeat, background) needs an approver or manager. A refused click is audited."),
    ],
    ...(modes.length ? { table: { columns: ["Permission mode", "Threads of this agent"], rows: modes } } : {}),
    text: [
      "Calls that never post a card:",
      "",
      "- tools listed in `SLAUDE_AUTO_ALLOW_TOOLS`;",
      "- slaude's own connect, surface, runtime, Slack, session and memory tools (memory writes are gated by **Memory write gating** instead);",
      "- `list_skills` and `read_skill`, and the mid-call voice controls.",
      "",
      "The synthesized MCP `authenticate` tools are always **denied**: connecting goes through `/mcp connect`.",
      "",
      "Everything else posts a permission card: *Allow once*, *Always allow* (for the rest of the session) or *Deny*.",
    ].join("\n"),
    textSource: "gateway/slack/permission-gate.ts permissionPolicy",
  };
}

async function approvals(name: string, text: string): Promise<GuardrailFamily> {
  const settings: GuardrailSetting[] = [];
  let table: GuardrailFamily["table"];
  const def = soulData();
  if (name !== "default") {
    const grants = await loadGrants(name);
    const own = usersWithRole(grants, ["approver", "manager"]);
    const fromConsole = grants.some((g) => g.source === "console" && !g.deny && (g.role === "approver" || g.role === "manager"));
    if (own.length) {
      settings.push(setting("approvers", "Approvers", own, fromConsole ? "console" : "soul", "approvers and managers of this agent (grants)",
        "Every approver may approve any request; scope keywords are not matched for a named agent."));
    } else {
      const fallback = usersWithRole(await loadGrants("default"), ["manager"]);
      settings.push(fallback.length
        ? setting("approvers", "Approvers", fallback, "default", "the default agent's managers", "This agent names no approver or manager.")
        : setting("approvers", "Approvers", "Nobody (requests time out denied)", "default", undefined, "Neither this agent nor the default agent has an approver or manager."));
    }
    const perChannel = channelApproversOf(soulDataFor(name));
    if (perChannel.size) table = { columns: ["Channel", "Approvers there"], rows: [...perChannel].map(([c, ids]) => [c, ids.join(", ")]) };
  } else {
    const structured = def.approvers;
    const legacy = loadApprovers();
    const envList = env.slack.approvers();
    if (structured.length) {
      settings.push(setting("approvers", "Approvers", structured.map((a) => a.userId), "soul", "SOUL.md approvers",
        "Matched per request: catch-all approvers always, others when their scope words appear in the request."));
      table = { columns: ["Approver", "Scope"], rows: structured.map((a) => [a.userId, a.catchall ? "anything" : a.scope]) };
    } else if (legacy && Object.keys(legacy).length) {
      settings.push(setting("approvers", "Approvers", Object.entries(legacy).map(([k, v]) => `${k}: ${v.join(", ")}`), "soul", "SOUL.md approvers block (by category)"));
    } else if (envList.length) {
      settings.push(setting("approvers", "Approvers", envList, "env", "SLAUDE_APPROVERS"));
    } else {
      settings.push(setting("approvers", "Approvers", "Anyone who sees the card", "default", undefined, "No approver is named in the soul or SLAUDE_APPROVERS."));
    }
    settings.push(setting("deny", "Denied users", "Users with a deny grant on this agent are removed from the list", "code"));
  }
  const ownTimeout = name === "default" ? def.approvalTimeoutSeconds : soulDataFor(name).approvalTimeoutSeconds;
  const timeout = approvalTimeoutFor(name);
  settings.push(setting("timeout", "An approval waits for", `${timeout || 300} seconds`, timeout ? "soul" : "default",
    ownTimeout > 0 ? "this agent's soul (approval timeout)" : timeout ? "the default agent's soul (approval timeout)" : undefined,
    name !== "default" && !(ownTimeout > 0) && timeout ? "This agent sets none, so the default agent's applies." : undefined));
  const prose = soulSections(text, /approv/i);
  return {
    id: "approvals",
    title: "Approvals",
    summary: "Who must say yes before the agent does something it asks about (request_approval, shared memory writes).",
    scope: "agent",
    status: "active",
    settings,
    ...(table ? { table } : {}),
    ...(prose ? { text: prose, textSource: "SOUL.md" } : {}),
  };
}

async function admission(name: string): Promise<GuardrailFamily> {
  const grants = await loadGrants(name);
  const users = (pred: (g: (typeof grants)[number]) => boolean) => [...new Set(grants.filter(pred).map((g) => g.subjectId))].sort();
  const consoleCount = grants.filter((g) => g.source === "console").length;
  return {
    id: "admission",
    title: "Admission and grants",
    summary: "Who the agent answers: managers, channels, DM allowlist, and blocked people.",
    scope: "agent",
    status: "active",
    settings: [
      setting("managers", "Managers", users((g) => g.role === "manager" && !g.deny), "soul", "SOUL.md manager and backup manager, plus console grants"),
      setting("channels", "Channels it answers in", users((g) => g.subjectKind === "channel" && !g.deny), "soul", "trusted and allowed channels, plus console grants"),
      setting("dm", "Who may DM it", users((g) => g.subjectKind === "user" && g.role === "member" && g.dmOnly && !g.deny), "soul", "DM allowlist"),
      setting("blocked", "Blocked", users((g) => g.deny), "soul", "blocked users, plus console deny grants"),
      setting("workspace", "Everyone in the workspace", grants.some((g) => g.subjectKind === "workspace" && !g.deny), consoleCount ? "console" : "default"),
      setting("console-grants", "Console grants", consoleCount, "console", "agent_grants"),
    ],
    text: [
      "For a message from a person in a channel, in this order:",
      "",
      "1. a **deny** for the person drops it;",
      "2. a **manager** is always admitted;",
      "3. in a DM, the person needs a member grant (the DM allowlist or a console grant); being an approver is not enough;",
      "4. in a channel, the channel needs a grant, or the person a console member grant, or the workspace a grant;",
      "5. anything else is dropped without a reply.",
    ].join("\n"),
    textSource: "access/admission.ts admit",
    link: { label: "Grants on the Access tab", to: `/agents/${encodeURIComponent(name)}/access` },
  };
}

function memoryGating(name: string): GuardrailFamily {
  const agentId = agentIdsByName([name]).get(name);
  const ops = BRAIN_OP_CLASSES;
  const ttl = grantTtlMs();
  return {
    id: "memory-gating",
    title: "Memory write gating",
    summary: "What the agent may read and write in memory without asking.",
    scope: "agent",
    status: "active",
    settings: [
      setting("own-slice", "Its own memory", agentId ? agentSourceId(agentId) : "unknown", "code"),
      setting("standing-grant", "One approval covers later writes in the thread for", ttl ? `${Math.round(ttl / 60_000)} minutes` : "off (every write asks)",
        fromEnv("SLAUDE_KB_GRANT_TTL_MS"), "SLAUDE_KB_GRANT_TTL_MS", "Only ordinary writes; deletes and admin never ride on it."),
      setting("max-pages", "Pages per memory_save call", KB_MEMOIZE_MAX_PAGES, "code", "KB_MEMOIZE_MAX_PAGES"),
    ],
    table: {
      columns: ["Tier", "Operations", "Rule"],
      rows: [
        ["Reads", ops.read.join(", "), "Always allowed"],
        ["Own writes", ops.write.join(", "), "Allowed without asking in the agent's own memory, and on background turns"],
        ["Shared writes", ops.write.join(", "), "Need approval in a trusted channel or from a manager; refused elsewhere"],
        ["Profile", ops.write.join(", "), "Only the person themselves, on their own turn"],
        ["/1on1", ops.write.join(", "), "Only the lock owner, into their own memory"],
        ["Destructive", ops.destructive.join(", "), "Need approval; refused in a public channel for anyone but a manager"],
        ["Admin", ops.manager.join(", "), "Need a manager's approval, always"],
      ],
    },
    textSource: "knowledge/gated-dispatch.ts classifyBrainOp",
  };
}

function profileGuard(): GuardrailFamily {
  return {
    id: "profile-guard",
    title: "Profile write guard",
    summary: "A person's profile and learned rules are written only on that person's own turn.",
    scope: "deployment",
    status: "active",
    settings: [
      setting("tools", "Refused on turns nobody asked for", [...MEMORY_WRITE_TOOLS].map((t) => `${t} (target "profile")`).concat(PROACTIVE_RULE_TOOL), "code",
        "agent/profile-write-guard.ts"),
    ],
    text: "On a turn no person started (cron, heartbeat, wake, background), a profile write and `proactive_rule` are refused before they run.",
    textSource: "agent/profile-write-guard.ts denySyntheticProfileWrite",
  };
}

function policy(): GuardrailFamily {
  return {
    id: "policy",
    title: "Policy guardrails",
    summary: "A written policy checked on every tool call and reply.",
    scope: "deployment",
    status: "not-implemented",
    settings: [],
    text: "Designed in the 2026-05-21 policy guardrails field note (a policy service, a `POLICY.md`, and a check on SDK hooks). No code implements it in this release, so nothing here constrains the agent yet.",
    textSource: "docs: field notes, 2026-05-21",
  };
}

function redaction(name: string, text: string, canSeeValues: boolean): GuardrailFamily {
  const def = soulData().redactPatterns;
  const own = name === "default" ? [] : soulDataFor(name).redactPatterns;
  const effective = redactPatternsFor(name);
  // A pattern can name what it hides (a project, a customer): values for
  // superadmins, a count for everyone else.
  const shown = (xs: string[]): GuardrailSetting["value"] => (canSeeValues ? list(xs) : `${xs.length} ${xs.length === 1 ? "pattern" : "patterns"}`);
  const hidden = canSeeValues ? undefined : "Only superadmins see the patterns themselves.";
  const settings = [
    setting("patterns", "Redacted from replies (default + own)", shown(effective), effective.length ? "soul" : "default", "the default agent's soul plus this agent's own",
      `Matches are replaced with [REDACTED] in what the agent posts. An agent's own patterns add to the default's, never replace them.${hidden ? ` ${hidden}` : ""}`),
  ];
  if (name !== "default") {
    settings.push(
      setting("default-patterns", "From the default agent", shown(def), def.length ? "soul" : "default", "the default agent's soul (redact patterns)"),
      setting("own-patterns", "This agent's own", shown(own), own.length ? "soul" : "default", "this agent's soul (redact patterns)"),
    );
  }
  settings.push(setting("secrets", "Secret shapes masked", `${SECRET_PATTERN_COUNT} kinds (keys, tokens, bearer headers, JWTs)`, "code", "redact/index.ts",
    "Masked in the status line, approval cards, the audit trail and console views."));
  const prose = canSeeValues ? soulSections(text, /redact/i) : "";
  return {
    id: "redaction",
    title: "Redaction",
    summary: "Text that never leaves in a reply or a console view.",
    scope: "agent",
    status: "active",
    settings,
    ...(prose ? { text: prose, textSource: "SOUL.md" } : {}),
  };
}

function proactive(text: string): GuardrailFamily {
  const cfg = parseProactive(text);
  const section = soulSections(text, /^proactive$/i);
  const src = (...keys: string[]): GuardrailSource => (section && hasKey(section, ...keys) ? "soul" : "default");
  const channels = [...new Set([...Object.keys(cfg.channels), ...Object.keys(cfg.channelHighest), ...Object.keys(cfg.channelCooldownHours), ...Object.keys(cfg.channelMaxPerDay)])].sort();
  const channelText = channelProactiveSections(text);
  const prose = [section, channelText].filter(Boolean).join("\n\n");
  return {
    id: "proactive",
    title: "Proactive restraint",
    summary: "When the agent may speak first, how often, and how far it may go on its own.",
    scope: "agent",
    status: "active",
    settings: [
      setting("enabled", "Works on its own", cfg.enabled, src("enabled"), "SOUL.md ## Proactive"),
      setting("highest", "Highest action", cfg.highest, src("highest"), "SOUL.md ## Proactive", "ignore < inform < ask < act. Learned rules can only lower it."),
      setting("quiet", "Quiet hours", cfg.quietHours ? `${clock(cfg.quietHours.start)} to ${clock(cfg.quietHours.end)}` : null, src("quiet hours"), "SOUL.md ## Proactive",
        "A person's own quiet hours (from their profile) apply too."),
      setting("cap", "Posts per person per day", cfg.maxPerPersonPerDay, src("max per person per day", "max per day"), "SOUL.md ## Proactive"),
      setting("cooldown", "Cooldown between posts to a person", `${cfg.cooldownHours} hours`, src("cooldown"), "SOUL.md ## Proactive"),
      setting("wake", "Wakes up for its checklist", cfg.wake, src("wake"), "SOUL.md ## Proactive"),
      setting("watch", "Watches", list(cfg.watch), src("watch"), "SOUL.md ## Proactive"),
      setting("read", "Channels it may read", list(cfg.read), src("read"), "SOUL.md ## Proactive"),
      setting("round-posts", "Posts per heartbeat round", HEARTBEAT_MAX_POSTS, "code", "HEARTBEAT_MAX_POSTS"),
      setting("follow-up", "Messages in a thread nobody answered", MAX_UNANSWERED, "code", "MAX_UNANSWERED", "Its post and one follow-up."),
      setting("unchanged", "The same news is not posted again for", `${UNCHANGED_WINDOW_MS / 86_400_000} days`, "code", "UNCHANGED_WINDOW_MS"),
      setting("slot", "Heartbeat slot", `${env.heartbeatMinutes()} minutes`, fromEnv("SLAUDE_HEARTBEAT_MINUTES"), "SLAUDE_HEARTBEAT_MINUTES"),
    ],
    ...(channels.length
      ? {
          table: {
            columns: ["Channel", "Works on its own", "Highest", "Cooldown", "Max per day"],
            rows: channels.map((c) => [
              c,
              c in cfg.channels ? (cfg.channels[c] ? "yes" : "no") : "as global",
              cfg.channelHighest[c] ?? "as global",
              c in cfg.channelCooldownHours ? `${cfg.channelCooldownHours[c]} hours` : "as global",
              c in cfg.channelMaxPerDay ? String(cfg.channelMaxPerDay[c]) : "as global",
            ]),
          },
        }
      : {}),
    ...(prose ? { text: prose, textSource: "SOUL.md ## Proactive" } : {}),
  };
}

async function learnedRules(name: string, deps: GuardrailDeps): Promise<GuardrailFamily> {
  const base = {
    id: "learned-rules" as const,
    title: "Learned proactive rules",
    summary: "How people told the agent to react to things; a rule can only lower how far it goes.",
    scope: "agent" as const,
    settings: [] as GuardrailSetting[],
    text: "Taught with `proactive_rule` on a person's own turn, never in a /1on1. Raising a level needs an approver (the manager for global and DM rules) and is capped by the soul's highest action; raising to *act* needs the person's words quoted.",
    textSource: "proactive/rule-tool.ts",
  };
  const agentId = agentIdsByName([name]).get(name);
  const unavailable = !deps.rules ? memoryUnavailableReason() : null;
  if (!agentId || unavailable) return { ...base, status: "unavailable", note: unavailable ?? "this agent has no agent id yet" };
  const read = deps.rules ?? ((id: string) => loadRules(id, brainCallIfOpen));
  try {
    const rules = await Promise.race([
      read(agentId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out reading the agent's memory")), RULES_TIMEOUT_MS)),
    ]);
    return {
      ...base,
      status: "active",
      settings: [setting("count", "Rules", rules.length, "learned", `memory: ${agentSourceId(agentId)}, rules/proactive/`)],
      table: {
        columns: ["What", "Where", "Level", "How", "Taught by", "When"],
        rows: rules.map((r) => [r.kind, r.scope, r.level, r.how ?? "", r.taughtBy, r.taughtAt]),
      },
    };
  } catch (e) {
    return { ...base, status: "unavailable", note: e instanceof Error ? e.message : String(e) };
  }
}

function wakeTools(): GuardrailFamily {
  return {
    id: "wake-tools",
    title: "Wake tool allow-list",
    summary: "What the agent may call when it wakes on its own, with nobody in the turn.",
    scope: "deployment",
    status: "active",
    settings: [],
    table: {
      columns: ["Tool server", "Allowed tools"],
      rows: Object.entries(WAKE_TOOL_ALLOWLIST).map(([server, tools]) => [server, tools === "all" ? "every tool" : tools.length ? tools.join(", ") : "none"]),
    },
    text: "Any tool not listed is refused, including tools added later. `post_message` only reaches threads of the agent's own posts.",
    textSource: "proactive/wake-guard.ts",
  };
}

function budgets(name: string): GuardrailFamily {
  const cfg = budgetConfigFor(name);
  let bg: { budgetUsd?: number; timezone?: string } | null | undefined;
  try {
    const reg = getPersonaRegistry();
    bg = name === "default" ? reg.defaultPersona?.()?.background : reg.lookupByName(name)?.background;
  } catch {
    bg = undefined;
  }
  const cap = (n: number, unit: string) => (n > 0 ? `${n} ${unit}` : "off");
  return {
    id: "budgets",
    title: "Budgets",
    summary: "How much the agent may spend on work nobody asked for.",
    scope: "agent",
    status: "active",
    settings: [
      setting("background", "Background spend per day", `${cfg.limitUsd} USD`, bg?.budgetUsd != null ? "persona" : fromEnv("SLAUDE_BACKGROUND_BUDGET_USD"),
        bg?.budgetUsd != null ? "persona background.budgetUsd" : "SLAUDE_BACKGROUND_BUDGET_USD"),
      setting("proactive", "Proactive spend per day", cfg.proactiveLimitUsd != null ? `${cfg.proactiveLimitUsd} USD` : "shared with background", fromEnv("SLAUDE_PROACTIVE_BUDGET_USD"),
        "SLAUDE_PROACTIVE_BUDGET_USD"),
      setting("timezone", "The day ends at midnight in", cfg.timeZone, bg?.timezone ? "persona" : fromEnv("SLAUDE_BACKGROUND_TIMEZONE"),
        bg?.timezone ? "persona background.timezone" : "SLAUDE_BACKGROUND_TIMEZONE"),
      setting("wake-usd", "One wake may spend", cap(env.wakeMaxUsd(), "USD"), fromEnv("SLAUDE_WAKE_MAX_USD"), "SLAUDE_WAKE_MAX_USD", "Never more than what is left of the day's pool."),
      setting("wake-turns", "One wake may take", cap(env.wakeMaxTurns(), "turns"), fromEnv("SLAUDE_WAKE_MAX_TURNS"), "SLAUDE_WAKE_MAX_TURNS"),
      setting("wake-minutes", "One wake may run for", cap(env.wakeMaxMinutes(), "minutes"), fromEnv("SLAUDE_WAKE_MAX_MINUTES"), "SLAUDE_WAKE_MAX_MINUTES"),
    ],
    textSource: "background/config.ts budgetConfigFor",
  };
}

/** The soul and access settings that constrain one agent. */
export async function guardrailSettingsFor(name: string, deps: GuardrailDeps = {}, viewer: GuardrailViewer = { role: "operator" }): Promise<GuardrailSettingsResponse> {
  const text = soulText(name);
  const families = await Promise.all([
    toolPermissions(name),
    approvals(name, text),
    admission(name),
    Promise.resolve(memoryGating(name)),
    Promise.resolve(profileGuard()),
    Promise.resolve(policy()),
    Promise.resolve(redaction(name, text, viewer.role === "superadmin")),
    Promise.resolve(proactive(text)),
    learnedRules(name, deps),
    Promise.resolve(wakeTools()),
    Promise.resolve(budgets(name)),
  ]);
  return { agent: name, families };
}
