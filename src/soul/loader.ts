import { existsSync, readFileSync } from "node:fs";
import { paths } from "../config/home";
import { brainEnabled } from "../knowledge/brain";
import { renderRuntimeFile } from "./runtime/render";
import { renderSkillIndex } from "./builtin";
import { stripScopeBlocks } from "./mandate-scope";

/**
 * Runtime baseline — non-negotiable rules every slaude process inherits.
 * NOT overridable by SOUL.md. Lives next to the code so a new release can
 * tighten guardrails without touching the user's persona file.
 */
// The text lives in runtime/core.md; runtimeBaseline() renders it.



/**
 * The default persona's SOUL.md text, or "" when there is none. Nothing seeds
 * one: a new home gets a starter agent.yaml (see persona/disk-check.ts), and the
 * default persona's text comes from there.
 */
export function loadSoul(soulPath?: string): string {
  const target = soulPath ?? paths.soul;
  if (target === paths.soul && !existsSync(target)) return "";
  return readFileSync(target, "utf8");
}

/**
 * Final system-prompt slot. Composes the immutable runtime baseline (which
 * defines how slaude interacts with Slack) with the operator's persona file
 * (which defines who slaude is in this deploy).
 */
export function soulSystemBlock(overlay?: string, opts: { keepScopes?: boolean } = {}): string {
  const text = overlay ?? loadSoul();
  // `## Scope` blocks reach a turn only through the resolved mandate. Extraction alone reads them.
  const persona = (opts.keepScopes ? text : stripScopeBlocks(text)).trim();
  return `${runtimeBaseline(brainEnabled())}\n\n<persona>\n${persona}\n</persona>`;
}

/**
 * The memory passages that differ by brain mode. \`memory_stores\` and
 * \`memory_search_stores\` return no disk path (WS-C §4.1.4), so with the brain
 * disabled the prompt itself names where a knowledge base's files are; with it
 * enabled the memory tools read them and no path is given. Only the memory_*
 * names appear here; the deprecated kb_* aliases are never offered in text.
 */
function knowledgeText(brain: boolean): Record<"KB_FALLBACK" | "KB_READ" | "KB_TOOLS", string> {
  if (brain) {
    return {
      KB_FALLBACK:
        "\`memory_stores\` / \`memory_search_stores\` only name the knowledge bases you may read; the memory tools read them.",
      KB_READ:
        "If tags match, read the relevant pages BEFORE calling external tools. Example: user asks\n" +
        "  \"what do you know about service-a?\" → \`memory_think({question: \"...\"})\` or\n" +
        "  \`memory_search({query: \"service-a\"})\` → read matching pages via\n" +
        "  \`memory_get\` → only then decide whether Grafana or other tools are needed.",
      KB_TOOLS:
        "- Query your memory anytime via \`mcp__slaude_kb__{memory_think, memory_search,\n" +
        "  memory_get, memory_list, memory_graph, memory_about, memory_thread_history,\n" +
        "  memory_stores, memory_search_stores}\`, all served\n" +
        "  live from the memory database. Reach for them whenever the answer plausibly\n" +
        "  lives in operator-curated reference material or your own memory.",
    };
  }
  const dir = `${paths.knowledge}/<label>/`;
  return {
    KB_FALLBACK:
      "Memory stores are disabled in this deployment, so the memory page tools are absent: find the knowledge base with " +
      `\`memory_search_stores\` (keyword/tag match) or \`memory_stores\`, then read its files with \`Grep\`/\`Read\` under \`${dir}\`, ` +
      "where <label> is the \`label\` those tools return.",
    KB_READ:
      `If tags match, read its relevant files under \`${dir}\` with \`Grep\`/\`Read\` BEFORE calling external tools.`,
    KB_TOOLS:
      "- The knowledge tools in this deployment are \`mcp__slaude_kb__{memory_stores, memory_search_stores}\`; they list only the\n" +
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
