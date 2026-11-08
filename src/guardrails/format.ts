/**
 * GUARDRAIL.md, the authoring format of an owner guardrail (design:
 * docs/superpowers/specs/2026-11-08-owner-guardrails.md, sections 1 and 1b).
 *
 *   ---
 *   name: no-outbound-email
 *   description: The agent drafts email but never sends it.
 *   scope: shared            # shared | agents
 *   agents: []               # persona names when scope: agents
 *   channels: []             # limit to these channel ids (empty = everywhere)
 *   enabled: true
 *   load: always             # always | on-match
 *   triggers: {}             # with load: on-match: { tool: [globs], inbound: pattern, channels: [ids] }
 *   ---
 *   Guidance prose (read by the model, advisory).
 *
 *   ```rules
 *   - id: no-send
 *     on: tool               # tool | reply | inbound
 *     match: { tool: "mcp__*__*send*", input: { to: "(?i)@external\\.example$" } }
 *     action: deny           # deny | approve | redact | audit
 *     message: "Sending email is not allowed; save a draft instead."
 *   ```
 *
 * Parsed deterministically (YAML and zod, no model). A rule that fails
 * validation is dropped with an error and the guardrail is marked invalid; its
 * other rules still load and its prose still applies. Frontmatter that cannot
 * be read leaves nothing to apply (no scope is known), and says so.
 */
import { z } from "zod";
import { compileGlob, compilePattern, PatternError, type Pattern } from "./pattern";

export const GUARDRAIL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Slugs the console API routes use for themselves. */
export const RESERVED_SLUGS = new Set(["settings"]);
/** Largest GUARDRAIL.md accepted (bytes). */
export const MAX_GUARDRAIL_BYTES = 64 * 1024;
/** Most rules one guardrail may carry; the rest are rejected. */
export const MAX_RULES = 50;
/** Most input fields one tool rule may name. */
export const MAX_INPUT_FIELDS = 20;
/** Most tool globs one rule or trigger may list. */
export const MAX_GLOBS = 20;
export const MAX_MESSAGE_CHARS = 500;
export const MAX_DESCRIPTION_CHARS = 300;

export type RuleOn = "tool" | "reply" | "inbound";
export type RuleAction = "deny" | "approve" | "redact" | "audit";

/** The on/action pairs of v1 (design section 1). */
export const ALLOWED_ACTIONS: Record<RuleOn, readonly RuleAction[]> = {
  tool: ["deny", "approve", "audit"],
  reply: ["deny", "approve", "redact", "audit"],
  inbound: ["deny", "audit"],
};

/**
 * Whether code enforces a rule in this release. Since rc.10 every kind is:
 * reply rules run at the outbound choke point (src/gateway/slack/outbound.ts)
 * and a tool `approve` holds the call on a card. "pending" stays in the type
 * for documents and API clients from rc.9.
 */
export type RuleStatus = "enforced" | "pending";
export function ruleStatus(_on: RuleOn): RuleStatus {
  return "enforced";
}

export interface ToolMatch {
  tool: Pattern[];
  /** Dot path to pattern; every listed field must match. */
  fields?: Array<{ path: string; pattern: Pattern }>;
  /** One pattern tried against every string value of the input. */
  anyValue?: Pattern;
}

export interface GuardrailRule {
  id: string;
  on: RuleOn;
  action: RuleAction;
  message: string;
  status: RuleStatus;
  tool?: ToolMatch;
  text?: Pattern;
}

export interface GuardrailMeta {
  name: string;
  description: string;
  scope: "shared" | "agents";
  agents: string[];
  channels: string[];
  enabled: boolean;
  load: "always" | "on-match";
  triggers: { tool: Pattern[]; inbound?: Pattern; channels: string[] };
}

export interface ParsedGuardrail {
  slug: string;
  /** null when the frontmatter could not be read: nothing of it applies. */
  meta: GuardrailMeta | null;
  /** The markdown body without the rules block (Guidance). */
  prose: string;
  rules: GuardrailRule[];
  /** Every problem found, in file order. Non-empty = the guardrail is invalid. */
  errors: string[];
  /**
   * The problems that refuse a write (a /deploy is a 422, an import exits 1):
   * a rule that fails to parse, a rules block that cannot be read, a file too
   * large, or frontmatter that cannot be read in a file with rules (its rules
   * would apply to nobody). An owner who wrote a rule meant it to be enforced;
   * storing it silently dropped would be the opposite.
   */
  blocking: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CHANNEL_RE = /^[A-Z0-9][A-Z0-9_-]{1,40}$/;

const stringList = (what: string, re: RegExp) =>
  z.array(z.string().regex(re, `${what} entries must match ${re.source}`)).max(200).default([]);

const metaSchema = z
  .object({
    name: z.string().regex(NAME_RE, `name must match ${NAME_RE.source}`),
    description: z.string().max(MAX_DESCRIPTION_CHARS).default(""),
    scope: z.enum(["shared", "agents"]).default("shared"),
    agents: stringList("agents", NAME_RE),
    channels: stringList("channels", CHANNEL_RE),
    enabled: z.boolean().default(true),
    load: z.enum(["always", "on-match"]).default("always"),
    triggers: z
      .object({
        tool: z.union([z.string(), z.array(z.string()).max(MAX_GLOBS)]).optional(),
        inbound: z.string().optional(),
        channels: stringList("triggers.channels", CHANNEL_RE),
      })
      .strict()
      .default({}),
  })
  .strict();

const ruleSchema = z
  .object({
    id: z.string().regex(ID_RE, `id must match ${ID_RE.source}`),
    on: z.enum(["tool", "reply", "inbound"]),
    match: z
      .object({
        tool: z.union([z.string(), z.array(z.string()).max(MAX_GLOBS)]).optional(),
        input: z.union([z.string(), z.record(z.string())]).optional(),
        text: z.string().optional(),
      })
      .strict(),
    action: z.enum(["deny", "approve", "redact", "audit"]),
    message: z.string().max(MAX_MESSAGE_CHARS).default(""),
  })
  .strict();

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Split `---` frontmatter from the body. null frontmatter = none found. */
export function splitFrontmatter(md: string): { front: string | null; body: string } {
  const text = md.replace(/^﻿/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { front: null, body: text };
  return { front: m[1]!, body: text.slice(m[0].length) };
}

/** The one ```rules fence and the prose around it. */
function splitRules(body: string, fail: (e: string) => void): { prose: string; rulesYaml: string | null } {
  const lines = body.split(/\r?\n/);
  const prose: string[] = [];
  let rulesYaml: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = line.match(/^(\s*)(`{3,}|~{3,})\s*rules\s*$/);
    if (!open) {
      prose.push(line);
      i++;
      continue;
    }
    const fence = open[2]!;
    const inner: string[] = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      const l = lines[i]!;
      const t = l.trim();
      if (t.length >= fence.length && t === fence[0]!.repeat(t.length)) {
        closed = true;
        i++;
        break;
      }
      inner.push(l);
      i++;
    }
    if (!closed) fail("the rules block is not closed");
    if (rulesYaml !== null) fail("only one rules block is read; a second one was ignored");
    else rulesYaml = inner.join("\n");
  }
  return { prose: prose.join("\n").trim(), rulesYaml };
}

function compileGlobs(raw: string | string[] | undefined, what: string, errors: string[]): Pattern[] {
  const out: Pattern[] = [];
  asList(raw).forEach((g, i) => {
    try {
      out.push(compileGlob(g, `${what}[${i}]`));
    } catch (e) {
      errors.push((e as Error).message);
    }
  });
  return out;
}

function parseRule(raw: unknown, index: number, seen: Set<string>): { rule?: GuardrailRule; error?: string } {
  const at = `rule ${index + 1}`;
  const r = ruleSchema.safeParse(raw);
  if (!r.success) return { error: `${at}: ${issues(r.error)}` };
  const d = r.data;
  const label = `rule ${d.id}`;
  if (seen.has(d.id)) return { error: `${label}: the id repeats an earlier rule` };
  if (!ALLOWED_ACTIONS[d.on].includes(d.action)) {
    return { error: `${label}: action ${d.action} is not available for on: ${d.on} (${ALLOWED_ACTIONS[d.on].join(", ")})` };
  }
  try {
    const rule: GuardrailRule = { id: d.id, on: d.on, action: d.action, message: d.message, status: ruleStatus(d.on) };
    if (d.on === "tool") {
      if (d.match.text !== undefined) return { error: `${label}: a tool rule matches tool and input, not text` };
      const globs = asList(d.match.tool);
      if (globs.length === 0) return { error: `${label}: a tool rule needs match.tool` };
      const tool: ToolMatch = { tool: globs.map((g, i) => compileGlob(g, `${label} match.tool[${i}]`)) };
      if (typeof d.match.input === "string") {
        tool.anyValue = compilePattern(d.match.input, `${label} match.input`);
      } else if (d.match.input) {
        const entries = Object.entries(d.match.input);
        if (entries.length > MAX_INPUT_FIELDS) return { error: `${label}: match.input names ${entries.length} fields; at most ${MAX_INPUT_FIELDS}` };
        tool.fields = entries.map(([path, src]) => {
          if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(path)) throw new PatternError(`${label}: match.input field '${path.slice(0, 64)}' is not a dot path`);
          return { path, pattern: compilePattern(src, `${label} match.input.${path}`) };
        });
      }
      rule.tool = tool;
    } else {
      if (d.match.tool !== undefined || d.match.input !== undefined) return { error: `${label}: a ${d.on} rule matches text only` };
      if (d.match.text === undefined) return { error: `${label}: a ${d.on} rule needs match.text` };
      rule.text = compilePattern(d.match.text, `${label} match.text`);
    }
    seen.add(d.id);
    return { rule };
  } catch (e) {
    if (e instanceof PatternError) return { error: e.message.startsWith(label) ? e.message : `${label}: ${e.message}` };
    throw e;
  }
}

/** Parse one GUARDRAIL.md. Never throws: every problem is in `errors`. */
export function parseGuardrail(slug: string, md: string): ParsedGuardrail {
  const errors: string[] = [];
  const blocking: string[] = [];
  const fail = (e: string) => {
    errors.push(e);
    blocking.push(e);
  };
  const out: ParsedGuardrail = { slug, meta: null, prose: "", rules: [], errors, blocking };
  if (Buffer.byteLength(md) > MAX_GUARDRAIL_BYTES) {
    fail(`GUARDRAIL.md is ${Buffer.byteLength(md)} bytes; at most ${MAX_GUARDRAIL_BYTES}`);
    return out;
  }
  const { front, body } = splitFrontmatter(md);
  if (front === null) {
    errors.push("no frontmatter (a --- block with name and description) at the top");
  } else {
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(front) ?? {};
    } catch (e) {
      errors.push(`frontmatter is not valid YAML (${(e as Error).message})`);
    }
    if (raw !== undefined) {
      const m = metaSchema.safeParse(raw);
      if (!m.success) errors.push(`frontmatter: ${issues(m.error)}`);
      else {
        const d = m.data;
        if (d.name !== slug) errors.push(`frontmatter: name '${d.name}' differs from the guardrail's folder '${slug}'`);
        if (d.scope === "agents" && d.agents.length === 0) errors.push("frontmatter: scope agents needs at least one name in agents");
        if (d.scope === "shared" && d.agents.length > 0) errors.push("frontmatter: agents is read only with scope: agents");
        const tool = compileGlobs(d.triggers.tool, "triggers.tool", errors);
        let inbound: Pattern | undefined;
        if (d.triggers.inbound !== undefined) {
          try {
            inbound = compilePattern(d.triggers.inbound, "triggers.inbound");
          } catch (e) {
            errors.push((e as Error).message);
          }
        }
        if (d.load === "on-match" && tool.length === 0 && !inbound) errors.push("load: on-match needs a tool or inbound trigger");
        if (d.load === "always" && (tool.length > 0 || inbound)) errors.push("triggers are read only with load: on-match");
        out.meta = {
          name: d.name,
          description: d.description,
          scope: d.scope,
          agents: d.agents,
          channels: d.channels,
          enabled: d.enabled,
          load: d.load,
          triggers: { tool, ...(inbound ? { inbound } : {}), channels: d.triggers.channels },
        };
      }
    }
  }
  const { prose, rulesYaml } = splitRules(body, fail);
  out.prose = prose;
  if (rulesYaml !== null && rulesYaml.trim() && out.meta === null) {
    fail("the frontmatter cannot be read, so this guardrail's rules would apply to nobody");
  }
  if (rulesYaml !== null && rulesYaml.trim()) {
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(rulesYaml);
    } catch (e) {
      fail(`the rules block is not valid YAML (${(e as Error).message})`);
    }
    if (raw !== undefined && raw !== null) {
      if (!Array.isArray(raw)) fail("the rules block must be a YAML list of rules");
      else {
        if (raw.length > MAX_RULES) fail(`${raw.length} rules; at most ${MAX_RULES} are read, the rest are rejected`);
        const seen = new Set<string>();
        raw.slice(0, MAX_RULES).forEach((r, i) => {
          const p = parseRule(r, i, seen);
          if (p.rule) out.rules.push(p.rule);
          else fail(p.error!);
        });
      }
    }
  }
  return out;
}

/** The serialisable view of one rule (console, API). */
export interface RuleView {
  id: string;
  on: RuleOn;
  action: RuleAction;
  message: string;
  status: RuleStatus;
  tool?: string[];
  input?: string | Record<string, string>;
  text?: string;
}

export function ruleView(r: GuardrailRule): RuleView {
  return {
    id: r.id,
    on: r.on,
    action: r.action,
    message: r.message,
    status: r.status,
    ...(r.tool ? { tool: r.tool.tool.map((p) => p.source) } : {}),
    ...(r.tool?.anyValue ? { input: r.tool.anyValue.source } : {}),
    ...(r.tool?.fields ? { input: Object.fromEntries(r.tool.fields.map((f) => [f.path, f.pattern.source])) } : {}),
    ...(r.text ? { text: r.text.source } : {}),
  };
}
