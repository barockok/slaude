import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../config/home";
import { brainEnabled } from "../knowledge/brain";
import { renderRuntimeFile } from "./runtime/render";
import { renderSkillIndex } from "./builtin";

/**
 * Runtime baseline — non-negotiable rules every slaude process inherits.
 * NOT overridable by SOUL.md. Lives next to the code so a new release can
 * tighten guardrails without touching the user's persona file.
 */
// The text lives in runtime/core.md; runtimeBaseline() renders it.


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
- Manager: <Slack user id of the person you report to, e.g. U0XXXXXXXXX>
- Manager handle: <e.g. @barock>
- Backup manager: <optional fallback user id, e.g. U0DEPUTY123 — leave blank for none>
- Backup manager handle: <e.g. @deputy>

## DM allowlist

Users allowed to DM slaude directly (1:1), in addition to the manager and
backup. Without this, a DM from anyone but manager/backup is dropped at the
engagement gate. Grants DM chat only — admin commands (cron / ignore /
ingest) still require manager/backup or an approver. One id per line,
\`<@Uxxx>\` or raw \`Uxxx\`. Omit the section for manager-only DMs.

- <@U0TEAMMATE1>
- <@U0TEAMMATE2>

## Redaction

Outbound replies are scrubbed for substrings matching the regex patterns
listed here before posting to Slack. Each line is a regex source (no
\`/.../\` wrappers, no flags — patterns run global + case-insensitive).
Use for credential / PII shapes you never want leaked. Omit the section
to disable redaction.

- AKIA[0-9A-Z]{16}                  ; AWS access keys
- ghp_[0-9A-Za-z]{36}               ; GitHub personal tokens
- xox[baprs]-[0-9A-Za-z-]{10,}      ; Slack tokens

## Approval timeout

Auto-deny \`request_approval\` blocks after this many seconds with no
human click. 0 (or omit the section) = wait forever.

- 600

## Allowed channels

Channels listed here are *public-interaction zones*: anyone in the
channel can address slaude. In any channel NOT on this list (and in DMs)
only the manager may engage; approvers can still click Approve / Deny on
\`request_approval\` blocks but cannot chat. One id per line — either
\`<#Cxxx|name>\` or raw \`Cxxx\`. Omit the section to disable public
channels entirely (manager-only everywhere).

- <#C0123456789|engineering>
- <#G0123456789|private-ops>

## Trusted channels

Internal team channels where slaude operates as a member of the team, not
a guest. Engagement is identical to *Allowed channels* (anyone in the
channel can chat), but the agent receives a \`trust="trusted"\` hint per
turn signaling it can be more open: show MCP server lists, skill names,
internal config, in-progress thinking. Use for the BU / squad / team
channel where slaude is one of the team, mostly meeting peers and the
manager. One id per line — either \`<#Cxxx|name>\` or raw \`Cxxx\`. Omit
the section if slaude has no team channel.

- <#C0123456789|squadron-team>

## Values
- <one or two lines of operating principles unique to this persona>

## Mandate
- <what this agent is meant to accomplish in this workspace>

## Approvers

Who may click Approve / Deny on \`mcp__slaude_surface__request_approval\`.
One \`<id-or-mention>: <scope description>\` line per person. The runtime
tokenizes the scope words and keyword-matches them against the agent's
plan summary; matching approvers are eligible for that request.

- "anything" / "any" / "all" / "default" / "*" / "catchall" / "everything"
  marks a catchall — always eligible regardless of summary content.
- Use plain English. Comma, dash, "and" all work as separators in scope.
- Trailing \`;\` starts an inline comment.

When this section is absent, env \`SLAUDE_APPROVERS\` is used.

- <@manager-id>:    anything                ; catchall, always eligible
- <@reviewer-id>:   code changes, repo writes, refactors, dependency bumps
- <@dba-id>:        database migrations, schema changes, prod data, SQL
- <@sre-id>:        deploys, infra, kubernetes, rollbacks, ingress, CI/CD
- <@security-id>:   secrets, credentials, IAM, env vars, OAuth scopes
- <@comms-id>:      external comms, customer messages, emails, social

## Channel <#C0123456789|example-channel>

Optional, repeatable. Per-channel override of *Mandate* and *Approvers*. When
slaude operates in this channel, the subsections below replace the global ones
(absent subsection → global value). One \`## Channel <id>\` block per channel;
\`<#Cxxx|name>\` or raw \`Cxxx\`/\`Gxxx\`/\`Dxxx\`. Delete this stub block (its id
is a placeholder, ignored by the parser) or fill it with a real channel id.

The manager (and backup) stay eligible approvers here automatically — a
channel block can only *add* approvers, never lock the operator out.

### Mandate
- <what slaude is meant to accomplish specifically in this channel>

### Approvers
- <@channel-lead-id>: anything            ; catchall for this channel
- <@channel-dba-id>:  migrations, SQL, schema changes
`;

export function loadSoul(soulPath?: string): string {
  const target = soulPath ?? paths.soul;
  if (target === paths.soul && !existsSync(target)) {
    writeFileSync(target, STARTER_PERSONA, "utf8");
    console.warn(
      `[soul] seeded starter persona at ${target} — fill it in before going live`,
    );
    return STARTER_PERSONA;
  }
  return readFileSync(target, "utf8");
}

/**
 * Final system-prompt slot. Composes the immutable runtime baseline (which
 * defines how slaude interacts with Slack) with the operator's persona file
 * (which defines who slaude is in this deploy).
 */
export function soulSystemBlock(overlay?: string): string {
  const persona = (overlay ?? loadSoul()).trim();
  return `${runtimeBaseline(brainEnabled())}\n\n<persona>\n${persona}\n</persona>`;
}

/**
 * The knowledge-base passages that differ by brain mode. \`list_kbs\` and
 * \`search_kbs\` return no disk path (WS-C §4.1.4), so with the brain disabled
 * the prompt itself names where a knowledge base's files are; with it enabled
 * the brain tools read them and no path is given.
 */
function knowledgeText(brain: boolean): Record<"KB_FALLBACK" | "KB_READ" | "KB_TOOLS", string> {
  if (brain) {
    return {
      KB_FALLBACK:
        "\`list_kbs\` / \`search_kbs\` only name the knowledge bases you may read; the brain tools read them.",
      KB_READ:
        "If tags match, read the relevant pages BEFORE calling external tools. Example: user asks\n" +
        "  \"what do you know about service-a?\" → \`kb_think({question: \"...\"})\` or\n" +
        "  \`kb_search({query: \"service-a\"})\` → read matching pages via\n" +
        "  \`kb_get_page\` → only then decide whether Grafana or other tools are needed.",
      KB_TOOLS:
        "- Query the brain anytime via \`mcp__slaude_kb__{kb_think, kb_search,\n" +
        "  kb_get_page, kb_list_pages, kb_graph, memory_about, kb_thread_history, list_kbs, search_kbs}\` — all served\n" +
        "  live from the brain DB. Reach for them whenever the answer plausibly\n" +
        "  lives in operator-curated reference material or your own memory.",
    };
  }
  const dir = `${paths.knowledge}/<label>/`;
  return {
    KB_FALLBACK:
      "The brain is disabled in this deployment, so the \`kb_*\` brain tools are absent: find the knowledge base with " +
      `\`search_kbs\` (keyword/tag match) or \`list_kbs\`, then read its files with \`Grep\`/\`Read\` under \`${dir}\`, ` +
      "where <label> is the \`label\` those tools return.",
    KB_READ:
      `If tags match, read its relevant files under \`${dir}\` with \`Grep\`/\`Read\` BEFORE calling external tools.`,
    KB_TOOLS:
      "- The knowledge tools in this deployment are \`mcp__slaude_kb__{list_kbs, search_kbs}\`; they list only the\n" +
      `  knowledge bases you may read, and their files are under \`${dir}\`.`,
  };
}

export function runtimeBaseline(brain: boolean): string {
  return renderRuntimeFile("core.md", { ...knowledgeText(brain), SKILL_INDEX: renderSkillIndex() });
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
 *        - <@U0XXXXXXXXX>: anything                  ; catchall
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
 *    - raw IDs: U0XXXXXXXXX
 *    - mention syntax: <@U0XXXXXXXXX>
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
