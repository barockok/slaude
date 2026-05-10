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

## Values
- <one or two lines of operating principles unique to this persona>

## Mandate
- <what this agent is meant to accomplish in this workspace>

## Approvers (per-area)

Who may click Approve / Deny on \`mcp__slaude_slack__request_approval\`.
The runtime parses the JSON below and looks up \`category\` (case-
insensitive). Falls back to \`default\` when no category matches. When
this block is absent, the env \`SLAUDE_APPROVERS\` (or
\`SLACK_ALLOWED_USERS\`) is used.

\`\`\`approvers
{
  "default":  ["<manager Slack user id>"],
  "code":     ["<reviewer ids>"],
  "database": ["<dba ids>"],
  "deploy":   ["<sre ids>"],
  "secrets":  ["<security ids>"],
  "comms":    ["<comms-lead ids>"]
}
\`\`\`
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
 * Parse the persona's approver allowlists. Looks for a fenced JSON block
 * tagged \`approvers\` in SOUL.md, e.g.:
 *
 *     \`\`\`approvers
 *     {
 *       "default":  ["U06ENBS6PV0"],
 *       "database": ["U999"],
 *       "deploy":   ["U06ENBS6PV0", "U777"]
 *     }
 *     \`\`\`
 *
 * Re-read on every call so edits to SOUL.md take effect without a restart.
 * Returns null when no block is present (fallback to env allowlist).
 */
export function loadApprovers(): Record<string, string[]> | null {
  const soul = loadSoul();
  const m = soul.match(/```\s*approvers\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]!.trim());
    if (typeof parsed !== "object" || parsed === null) return null;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) {
        out[k.toLowerCase()] = v.filter((x) => typeof x === "string");
      }
    }
    return out;
  } catch (e) {
    console.error("[soul] approvers JSON parse failed:", e);
    return null;
  }
}
