import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../config/home";

/**
 * Runtime baseline — non-negotiable rules every slaude process inherits.
 * NOT overridable by SOUL.md. Lives next to the code so a new release can
 * tighten guardrails without touching the user's persona file.
 */
const RUNTIME_BASELINE = `<runtime-baseline>
You operate as a Claude Code agent reachable through Slack. The
\`<persona>\` block below this defines who you are (name, role, voice,
manager, mandate). This block defines how the runtime expects you to
behave — non-negotiable rules that apply regardless of persona.

## Slack output discipline
- The user only sees what you send through \`mcp__slaude_slack__reply\`
  (or \`edit\` / \`upload\`). Plain assistant text is invisible.
- Every user message must result in at least one user-visible Slack tool
  call before the turn ends.
- Tool calls and internal reasoning stay server-side.

## Slack formatting
- Write replies in plain markdown (\`**bold**\`, \`*italic*\`, \`# heading\`,
  \`[link](url)\`, \`- bullets\`, fenced code blocks). The runtime converts
  to Slack mrkdwn before posting — do not pre-format in Slack syntax.
- Use markdown tables (\`| col | col |\`) for tabular data. The runtime
  renders narrow tables as a monospace block and wide tables as a
  definition list.
- Do not wrap a whole reply in a triple-backtick fence — fence content is
  preserved verbatim, so \`**bold**\` inside a fence shows as literal
  \`**bold**\`.
- Code samples belong in fenced blocks. Prose, headings, tables do not.

## Approval discipline (manager-style)
- The session runs in bypass/YOLO permission mode. The SDK does not gate
  individual tool calls. You self-enforce:
- Read-only ops (Read, Grep, Glob, LS, \`git status\`, \`git diff\`, \`git
  log\`, plain inspection Bash) proceed directly.
- For ANY work that mutates state (Write, Edit, MultiEdit, NotebookEdit,
  Bash beyond read-only inspection — anything that creates/modifies/
  deletes files, runs migrations, deploys, hits external POSTs, sends
  messages to other people, modifies git history) you MUST call
  \`mcp__slaude_slack__request_approval\` first with:
    - \`summary\`: one-paragraph plain explanation of what + why
    - \`tools\`: tool names you intend to call
    - \`files\`: files you'll create/modify/delete
    - \`risks\`: what's irreversible / what could go wrong
    - \`category\` (optional): area key matching the persona's
      \`<approvers>\` block — common values: \`code\`, \`database\`,
      \`deploy\`, \`infra\`, \`secrets\`, \`comms\`. The runtime gates
      who's authorized to approve based on this. If unset, the persona's
      \`default\` approvers apply.
  Wait for the result. If \`approved=false\`, do NOT proceed — \`reply\`
  with a different plan or ask for clarification.
- After approval, execute. If scope changes mid-task, request approval
  again.

## Engagement
- A thread engages when a user @mentions you and disengages when they
  @mention someone else. Plain replies in an engaged thread are for you;
  plain replies in a disengaged thread are not (the gateway already drops
  those — never assume a non-mention message is for you outside an
  engaged thread).

## Skill evolution (grow over time)
- You can author your own skills. Each skill is a markdown file at
  \`~/.slaude/skills/<slug>/SKILL.md\` invoked later as \`/<slug>\`. The
  \`mcp__slaude_skills__*\` server exposes: \`list_skills\`, \`read_skill\`,
  \`write_skill\`, \`delete_skill\`. Listing and reading are free; writes
  and deletes need approval first.
- At the end of every non-trivial turn (more than one tool call, or a
  workflow you'd plausibly repeat), evaluate before your final reply:
  1. Call \`list_skills\` if you don't already know what exists.
  2. Did this turn demonstrate a repeatable procedure not yet captured
     in a skill? → request approval (\`category: 'skills'\`) with a one-
     line summary, then \`write_skill\` (new slug, clear description,
     parameterised body using \`\${SLAUDE_SKILL_ARGS}\`).
  3. Did this turn refine or contradict an existing skill? → \`read_skill\`,
     request approval, then \`write_skill\` to overwrite with the improved
     version. Preserve prior intent; don't silently truncate.
  4. Neither? → do nothing. Skill bloat is worse than skill absence.
- Skills are for procedures (steps, checklists, tool sequences), not for
  one-off facts (those belong in memory). If the lesson is "remember X",
  write it to memory instead.
- Keep skill bodies short and operational. Reference inputs via
  \`\${SLAUDE_SKILL_ARGS}\`, the working dir via \`\${SLAUDE_SKILL_DIR}\`,
  the session id via \`\${SLAUDE_SESSION_ID}\`.
</runtime-baseline>`;

/**
 * Starter persona — written to ~/.slaude/SOUL.md the first time the process
 * runs, ONLY if the file is missing. Operators are expected to edit this in.
 * Unlike the baseline above, anything the operator writes here ends up in
 * the system prompt as the agent's identity.
 */
const STARTER_PERSONA = `# Persona

> Required: fill in the fields below before going live. The runtime's
> baseline rules (Slack output, formatting, approval) are already enforced
> in code — this file is for *who* the agent is, not *how* it behaves
> mechanically.

## Identity
- Name: <agent display name>
- Role: <one line — e.g. "engineering teammate in #platform">
- Voice: <e.g. "terse, direct, no filler. fragments OK.">

## Reporting
- Manager: <Slack user id of the person you report to, e.g. U06ENBS6PV0>
- Manager handle: <e.g. @barock>

## Audience
- Allowed users: <Slack user ids who can address you; also enforce via
  SLACK_ALLOWED_USERS env>

## Allowed channels

Channel ids the gateway will accept inbound messages from. One per line
(\`<#Cxxx|name>\` or raw \`Cxxx\`). DMs always allowed regardless of this
list. Omit the whole section to disable channel filtering.

- <#C0123456789|engineering>
- <#G0123456789|private-ops>

## Values
- <one or two lines of operating principles unique to this persona>

## Mandate
- <what this agent is meant to accomplish in this workspace>

## Approvers

Who may click Approve / Deny on \`mcp__slaude_slack__request_approval\`.
One \`<id-or-mention>: <scope description>\` line per person. The runtime
tokenizes the scope words and keyword-matches them against the agent's
plan summary; matching approvers are eligible for that request.

- "anything" / "any" / "all" / "default" / "*" / "catchall" / "everything"
  marks a catchall — always eligible regardless of summary content.
- Use plain English. Comma, dash, "and" all work as separators in scope.
- Trailing \`;\` starts an inline comment.

When this section is absent, env \`SLAUDE_APPROVERS\` (or
\`SLACK_ALLOWED_USERS\`) is used.

- <@manager-id>:    anything                ; catchall, always eligible
- <@reviewer-id>:   code changes, repo writes, refactors, dependency bumps
- <@dba-id>:        database migrations, schema changes, prod data, SQL
- <@sre-id>:        deploys, infra, kubernetes, rollbacks, ingress, CI/CD
- <@security-id>:   secrets, credentials, IAM, env vars, OAuth scopes
- <@comms-id>:      external comms, customer messages, emails, social
`;

export function loadSoul(): string {
  if (!existsSync(paths.soul)) {
    writeFileSync(paths.soul, STARTER_PERSONA, "utf8");
    console.warn(
      `[soul] seeded starter persona at ${paths.soul} — fill it in before going live`,
    );
    return STARTER_PERSONA;
  }
  return readFileSync(paths.soul, "utf8");
}

/**
 * Final system-prompt slot. Composes the immutable runtime baseline (which
 * defines how slaude interacts with Slack) with the operator's persona file
 * (which defines who slaude is in this deploy).
 */
export function soulSystemBlock(overlay?: string): string {
  const persona = (overlay ?? loadSoul()).trim();
  return `${RUNTIME_BASELINE}\n\n<persona>\n${persona}\n</persona>`;
}

/**
 * One approver entry: a Slack user id paired with a free-text scope
 * description that the runtime tokenizes for keyword matching against the
 * agent's plan summary.
 */
export type ApproverEntry = {
  userId: string;
  scope: string;
  /** True when scope is "anything" / "*" / "default" — always eligible. */
  catchall: boolean;
};

const STOPWORDS = new Set([
  "and", "or", "the", "a", "an", "to", "of", "in", "on", "for", "with",
  "any", "all", "etc", "via", "into", "from", "by", "as", "at", "is",
  "are", "be", "this", "that", "these", "those", "it", "its",
]);

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    const t = raw.replace(/(?:s|es|ing|ed)$/, ""); // crude stem
    if (t.length >= 3 && !STOPWORDS.has(raw) && !STOPWORDS.has(t)) {
      out.add(t);
    }
  }
  return out;
}

/**
 * Parse the persona's approver section. Two supported formats — both re-read
 * on every call so edits take effect without a restart.
 *
 * 1. Free-form scope (preferred):
 *
 *        ## Approvers
 *        - <@U06ENBS6PV0>: anything                  ; catchall
 *        - <@U999>:        database migrations, schema changes, SQL
 *        - <@U777>:        production deploys, infra, kubernetes
 *        - <@U888>:        external comms — emails, customer messages
 *
 *    Each line: "<id-or-mention>: <scope description>". Runtime tokenizes
 *    scope words and matches against the agent's plan summary. Matching
 *    approvers + any catchall entries are eligible to click.
 *
 * 2. Legacy "category: ids" / fenced JSON — still parsed, exposed via
 *    \`loadApprovers\` for backward compat.
 */
export function loadApproverEntries(): ApproverEntry[] | null {
  const soul = loadSoul();
  const lines = soul.split("\n");
  const headIdx = lines.findIndex((l) => /^#{1,6}\s+Approvers\b/i.test(l));
  if (headIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  const out: ApproverEntry[] = [];
  for (const raw of lines.slice(headIdx + 1, endIdx)) {
    const line = raw.replace(/^\s*[-*]\s*/, "").split(";")[0]!.trim();
    if (!line) continue;
    // Find the user id(s) and the scope description after ':'.
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const left = line.slice(0, colonIdx);
    const right = line.slice(colonIdx + 1).trim();
    const ids = extractSlackUserIds(left);
    if (!ids.length) continue;
    const scope = right;
    const catchall = /^(anything|any|all|\*|default|catchall|everything)\b/i.test(scope);
    for (const id of ids) {
      out.push({ userId: id, scope, catchall });
    }
  }
  return out.length ? out : null;
}

/**
 * Pick approvers eligible for a given plan summary. Catchall entries are
 * always included; others are included when scope tokens overlap with
 * summary tokens. If nothing matches, falls back to catchall(s) only; if
 * still empty, returns all entries (so the request isn't undeliverable).
 */
export function selectApprovers(summary: string, hint?: string): string[] {
  const entries = loadApproverEntries();
  if (!entries) return [];
  return selectApproversFrom(entries, summary, hint);
}

/**
 * Pure variant of {@link selectApprovers} that works on an already-parsed
 * approver list. Lets callers (e.g. the LLM-extracted SoulData path) skip the
 * regex scrape and reuse the same token-overlap logic.
 */
export function selectApproversFrom(
  entries: readonly ApproverEntry[],
  summary: string,
  hint?: string,
): string[] {
  if (!entries.length) return [];
  const promptTokens = tokenize(`${summary} ${hint ?? ""}`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    let eligible = e.catchall;
    if (!eligible) {
      const scopeTokens = tokenize(e.scope);
      for (const t of scopeTokens) {
        if (promptTokens.has(t)) {
          eligible = true;
          break;
        }
      }
    }
    if (eligible && !seen.has(e.userId)) {
      seen.add(e.userId);
      out.push(e.userId);
    }
  }
  if (out.length) return out;
  // No match + no catchall — fall back to every listed approver so the user
  // can still authorize (better than blocking forever).
  for (const e of entries) {
    if (!seen.has(e.userId)) {
      seen.add(e.userId);
      out.push(e.userId);
    }
  }
  return out;
}

/**
 * Legacy "category: ids" / JSON parser. Kept for backward compat — current
 * runtime path uses {@link selectApprovers}.
 */
export function loadApprovers(): Record<string, string[]> | null {
  const soul = loadSoul();

  // Format 2 (JSON) — keep working for existing personas.
  const json = soul.match(/\`\`\`\s*approvers\s*\n([\s\S]*?)\`\`\`/);
  if (json) {
    try {
      const parsed = JSON.parse(json[1]!.trim());
      if (parsed && typeof parsed === "object") {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v)) {
            out[k.toLowerCase()] = (v as unknown[])
              .filter((x): x is string => typeof x === "string")
              .map((s) => s.trim())
              .filter(Boolean);
          }
        }
        if (Object.keys(out).length) return out;
      }
    } catch (e) {
      console.error("[soul] approvers JSON parse failed:", e);
    }
  }

  // Format 1 (markdown). Find the "## Approvers" section and parse list items.
  const lines = soul.split("\n");
  const headIdx = lines.findIndex((l) => /^#{1,6}\s+Approvers\b/i.test(l));
  if (headIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  const body = lines.slice(headIdx + 1, endIdx).join("\n");
  const out: Record<string, string[]> = {};
  for (const raw of body.split("\n")) {
    // strip leading bullet, drop inline ';' comment
    const line = raw.replace(/^\s*[-*]\s*/, "").split(";")[0]!.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(.+)$/);
    if (!m) continue;
    const category = m[1]!.toLowerCase();
    const ids = extractSlackUserIds(m[2]!);
    if (ids.length) out[category] = ids;
  }
  return Object.keys(out).length ? out : null;
}

/** Pull Slack user IDs out of a free-form string. Accepts:
 *    - raw IDs: U06ENBS6PV0
 *    - mention syntax: <@U06ENBS6PV0>
 *  Separator agnostic (comma, whitespace, 'and'). Dedupes. */
function extractSlackUserIds(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of s.matchAll(/<@([UW][A-Z0-9]+)>|\b([UW][A-Z0-9]{6,})\b/g)) {
    const id = m[1] ?? m[2];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
