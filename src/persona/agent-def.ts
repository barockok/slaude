/**
 * `personas/<name>/agent.yaml`: one file that defines an agent. It compiles to
 * the same sync payload the older three-file layout renders to; the structured
 * parts (mandates, access) build `SoulData` here, deterministically, so a
 * persona defined this way never goes through soul extraction.
 *
 * Plugins are deliberately not a field: every agent on a machine gets every
 * plugin installed there, and `runsOn` picks the machines.
 *
 * Errors name the persona and the key, never the value.
 */
import { parse as parseYaml, YAMLParseError } from "yaml";
import { MANDATE_LINE_MAX, subMandatesOf, type SubMandate } from "../soul/mandate-scope";
import { SoulDataSchema, type ApproverEntry, type ChannelOverride, type ScopeMandate, type SoulData } from "../soul/data";
import { channelOf, endsInOpenFence, isCodeFence, parseProactive } from "../soul/proactive";
import { AgentSchema, CHANNEL_ID_RE, DESCRIPTION_MAX, type AgentFile } from "./agent-schema";
import type { ZodIssue } from "zod";
import { PayloadError, safeKey } from "./sync/payload";

export const AGENT_YAML = "agent.yaml";
/** The older layout's files, which cannot sit beside an agent.yaml. */
export const LEGACY_FILES = ["persona.yaml", "SOUL.md", "mcp.json"] as const;

const MODES = new Set(["override", "extend", "reduce"]);
export { DESCRIPTION_MAX };

/** Exactly what `channels` compiles to; anything else under a `## Channel` heading was authored. */
const GENERATED_CHANNEL_SECTION_RE = /^## Channel <#[CGD][A-Z0-9]+>(?=\n###)(?:\n### Session\n- Mode: channel)?(?:\n### Proactive\n- Enabled: (?:yes|no))?$/;

/** A soul section that agent.yaml keeps in its own keys (headings a SOUL.md may carry). */
const STRUCTURED_HEADING_RE =
  /^##\s+(?:mandate|reporting|manager|backup manager|secondary manager|deputy|approvers?|allowed channels|public channels|trusted channels|team channel|home channel|bu channel|blocked|blacklist|banned|ignore|dm allowlist|allowed dms|direct message allowlist|who can dm|redaction|redact|pii patterns|approval timeout|auto-deny|channel\b.*|scope\s+(?:dm|public|trusted))\s*$/i;

/**
 * The issue to report: an unknown key first (the nearest to the top), then the
 * first in the schema's own order. Its text comes from the schema's messages,
 * which never carry a value; a key is echoed only through safeKey.
 */
function firstIssue(issues: ZodIssue[]): { path: string; message: string } {
  const unknown = issues
    .filter((i) => i.code === "unrecognized_keys")
    .sort((a, b) => a.path.length - b.path.length)[0];
  const issue = unknown ?? issues[0]!;
  const base = issue.path.map((seg, i) => pathSegment(seg, i, issue.path)).reduce((acc, s) => (s.startsWith("[") || !acc ? acc + s : `${acc}.${s}`), "");
  if (issue.code === "unrecognized_keys") {
    const k = String(issue.keys[0] ?? "");
    return { path: `${base ? `${base}.` : ""}${safeKey(k)}`, message: "is not a known key" };
  }
  return { path: base, message: issue.message };
}

/** One path segment: a schema key as is, an index in brackets, a `channels` key only when it is a channel id. */
function pathSegment(seg: string | number, i: number, path: (string | number)[]): string {
  if (typeof seg === "number") return `[${seg}]`;
  if (i === 1 && path[0] === "channels") return CHANNEL_ID_RE.test(seg) ? seg : safeKey(seg);
  return seg;
}

function isMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export interface CompiledAgent {
  /** The payload persona, before the gateway's own field validation. */
  spec: {
    name: string;
    soul: string;
    slackUserId?: string;
    userToken?: string;
    model?: string;
    runsOn?: string;
    provider?: unknown;
    mcp?: unknown;
    kbSources?: unknown;
    background?: unknown;
    definition: { description?: string; skills?: string[]; guardrails?: string[]; soulData: SoulData };
  };
  warnings: string[];
}

/** Parse one agent.yaml. Throws PayloadError naming the persona and key for anything malformed. */
export function parseAgentYaml(name: string, text: string): CompiledAgent {
  const fail = (key: string, why: string): never => {
    throw new PayloadError(`persona '${name}': agent.yaml ${key} ${why}`);
  };
  const noRepeats = (key: string, list: string[] | undefined): string[] | undefined => {
    const seen = new Set<string>();
    list?.forEach((x, i) => {
      if (seen.has(x)) fail(`${key}[${i}]`, "repeats an earlier entry");
      seen.add(x);
    });
    return list;
  };
  let raw: unknown;
  try {
    // The `yaml` package refuses a duplicate key. Its message quotes the source
    // line, so only its code and position are reported.
    raw = parseYaml(text);
  } catch (e) {
    const where = e instanceof YAMLParseError ? `${e.code}${e.linePos ? ` at line ${e.linePos[0].line}` : ""}` : "unreadable";
    throw new PayloadError(`persona '${name}': agent.yaml is not valid YAML (${where})`);
  }
  if (!isMap(raw)) fail("", "must be a mapping of the agent's fields");
  const doc = raw as Record<string, unknown>;

  const warnings: string[] = [];
  // Shape (keys, types, patterns, lengths, nulls) is the schema's; see agent-schema.ts.
  const checked = AgentSchema.safeParse(doc);
  if (!checked.success) {
    const issue = firstIssue(checked.error.issues);
    fail(issue.path, issue.message);
  }
  const file = checked.data as AgentFile;

  if (file.name !== name) fail("name", `must equal the directory name '${name}'`);
  const soulText = file.soul;
  const description = file.description ?? undefined;
  const model = file.model ?? undefined;
  const userToken = file.userToken ?? undefined;
  const runsOn = file.runsOn ?? undefined;
  const slackUserId = file.slackUserId == null ? undefined : String(file.slackUserId);
  const provider = file.provider ?? undefined;
  const mcp = file.mcp ?? undefined;
  const skills = noRepeats("skills", file.skills ?? undefined);
  const guardrails = noRepeats("guardrails", file.guardrails ?? undefined);

  const memory = file.memory ?? {};

  const mandate = file.mandate ?? {};
  const global = mandate.global ?? undefined;
  const channels = new Map<string, ChannelOverride>();
  const channelBlock = (channel: string): ChannelOverride => {
    let block = channels.get(channel);
    if (!block) {
      block = { channel, approvers: [] };
      channels.set(channel, block);
    }
    return block;
  };
  const scopes: ScopeMandate[] = [];
  const seenBoundary = new Set<string>();
  (mandate.scoped ?? []).forEach((e, i) => {
    const key = `mandate.scoped[${i}]`;
    const boundary = e.boundary;
    if (seenBoundary.has(boundary)) fail(`${key}.boundary`, "repeats an earlier boundary");
    seenBoundary.add(boundary);
    // As a soul's `Mode:` line: absent is override, and an unknown value reads
    // as extend, so a typo keeps the global mandate instead of replacing it.
    const written = typeof e.mode === "string" ? e.mode.trim().toLowerCase() : "";
    let mode = "override";
    if (e.mode != null) {
      mode = MODES.has(written) ? written : "extend";
      if (!MODES.has(written)) warnings.push(`persona '${name}': agent.yaml ${key}.mode is not override, extend or reduce; it reads as extend`);
    }
    const text = e.text;
    const m = mode as "override" | "extend" | "reduce";
    if (m !== "override" && text.trim().length > MANDATE_LINE_MAX) {
      warnings.push(`persona '${name}': agent.yaml ${key}.text is longer than ${MANDATE_LINE_MAX} characters; a ${m} is carried whole, so keep it short`);
    }
    if (boundary.startsWith("channel:")) {
      const b = channelBlock(boundary.slice("channel:".length));
      b.mandate = text.trim();
      b.mandateMode = m;
    } else {
      const scope = boundary === "dm" ? "dm" : (boundary.slice("trust:".length) as "public" | "trusted");
      scopes.push({ scope, mandate: text.trim(), mode: m });
    }
  });

  const access = file.access ?? {};
  const channelLists = access.channels ?? {};
  const approvers: ApproverEntry[] = [];
  (access.approvers ?? []).forEach((e) => {
    const entryOut: ApproverEntry = {
      userId: e.user,
      scope: e.scope ?? "anything",
      catchall: typeof e.catchall === "boolean" ? e.catchall : e.scope == null,
    };
    if (e.channel) channelBlock(e.channel).approvers.push(entryOut);
    else approvers.push(entryOut);
  });
  const redact = access.redact ?? [];
  redact.forEach((p, i) => {
    try {
      new RegExp(p, "gi");
    } catch {
      fail(`access.redact[${i}]`, "is not a valid regular expression");
    }
  });
  const manager = access.manager ?? undefined;
  const backupManager = access.backupManager ?? undefined;

  const soulData = SoulDataSchema.parse({
    identity: { name, ...(description ? { role: description } : {}) },
    manager: manager ? { userId: manager } : {},
    backupManager: backupManager ? { userId: backupManager } : {},
    allowedChannels: channelLists.public ?? [],
    trustedChannels: channelLists.trusted ?? [],
    blockedUsers: access.blocked ?? [],
    dmAllowedUsers: access.dm ?? [],
    approvers,
    redactPatterns: redact,
    approvalTimeoutSeconds: access.approvalTimeoutSeconds ?? 0,
    ...(global?.trim() ? { mandate: global.trim() } : {}),
    channelOverrides: [...channels.values()],
    scopeMandates: scopes,
  });

  // Per-channel session and proactive settings compile to the `## Channel` block
  // the soul parser reads. The warnings below run on the authored soul alone:
  // this block is generated, not a section left in the prose by mistake.
  const authoredChannels = new Set(channelSections(soulText).map((s) => s.channel));
  let channelBlocks = "";
  for (const [channel, entry] of Object.entries(file.channels ?? {})) {
    if (authoredChannels.has(channel)) fail(`channels.${channel}`, "also has a ## Channel section in soul: keep it in one place");
    let settings = "";
    if (entry?.session === "channel") settings += "\n### Session\n- Mode: channel";
    if (entry?.proactive != null) settings += `\n### Proactive\n- Enabled: ${entry.proactive ? "yes" : "no"}`;
    if (settings) channelBlocks += `\n\n## Channel <#${channel}>${settings}`;
  }
  if (channelBlocks && endsInOpenFence(soulText)) fail("soul", "ends inside an open code fence, so the channels settings would not be read");

  for (const h of structuredHeadings(soulText)) {
    warnings.push(`persona '${name}': agent.yaml soul has a '${h}' section; mandates and access are read from their own keys, so that section is only prose`);
  }

  return {
    spec: {
      name,
      soul: soulText + channelBlocks,
      ...(slackUserId ? { slackUserId } : {}),
      ...(userToken ? { userToken } : {}),
      ...(model ? { model } : {}),
      ...(runsOn ? { runsOn } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
      ...(memory.kbSources != null ? { kbSources: memory.kbSources } : {}),
      ...(memory.background != null ? { background: memory.background } : {}),
      definition: {
        ...(description !== undefined ? { description } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(guardrails !== undefined ? { guardrails } : {}),
        soulData,
      },
    },
    warnings,
  };
}

function structuredHeadings(soul: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of soul.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    else if (!fenced && STRUCTURED_HEADING_RE.test(line)) out.push(line.trim());
  }
  return out;
}

/**
 * A SOUL.md with the sections agent.yaml holds in its own keys removed: what is
 * left is identity, voice and other prose. A section it does not recognise
 * stays, so migrating never drops prose.
 */
export function proseOnlySoul(soulMd: string): string {
  const kept: string[] = [];
  let skipping = false;
  let fenced = false;
  for (const line of soulMd.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (!fenced && /^##\s/.test(line)) skipping = STRUCTURED_HEADING_RE.test(line);
    else if (!fenced && /^#\s/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** One entry of agent.yaml's `channels` key: only the keys that are set. */
export interface ChannelSetting {
  session?: "channel";
  proactive?: boolean;
}

/**
 * A soul's per-channel settings, as agent.yaml's `channels` key holds them: what
 * the soul writes, so a `proactive: true` channel round-trips as `proactive: true`
 * and `session:` appears only where a `Mode` was written (proactive alone already
 * means a channel session). A channel with an invalid `Mode` reads as off, so it
 * exports as `proactive: false`: exported as written, importing it would turn on
 * a session and wakes the soul never had.
 */
export function channelSettings(soulMd: string): Record<string, ChannelSetting> {
  const { sessions, channels, invalidSessions } = parseProactive(soulMd);
  const out: Record<string, ChannelSetting> = {};
  for (const id of new Set([...Object.keys(sessions), ...Object.keys(channels)])) {
    out[id] = {
      ...(sessions[id] ? { session: "channel" as const } : {}),
      ...(channels[id] !== undefined ? { proactive: invalidSessions.includes(id) ? false : channels[id] } : {}),
    };
  }
  return out;
}

/**
 * What `personas export` can carry. A channel's limits have no key in agent.yaml.
 * They mean nothing in a channel session (`Mode: channel` or `Enabled: yes`), and
 * nothing where the channel is off, so nothing changes by losing them; the off
 * cases are reported so an author does not think they still apply.
 */
export function exportedChannelSettings(soulMd: string): { channels: Record<string, ChannelSetting>; dropped: { channel: string; keys: string[] }[] } {
  const c = parseProactive(soulMd);
  const channels = channelSettings(soulMd);
  const dropped: { channel: string; keys: string[] }[] = [];
  for (const channel of new Set([...Object.keys(c.channelHighest), ...Object.keys(c.channelCooldownHours), ...Object.keys(c.channelMaxPerDay)])) {
    if (c.sessions[channel] || (c.channels[channel] === true && !c.invalidSessions.includes(channel))) continue;
    const keys = [
      ...(channel in c.channelHighest ? ["Highest"] : []),
      ...(channel in c.channelCooldownHours ? ["Cooldown"] : []),
      ...(channel in c.channelMaxPerDay ? ["Max per day"] : []),
    ];
    dropped.push({ channel, keys });
  }
  return { channels, dropped };
}

function channelSections(soulMd: string): { channel: string; lines: string[] }[] {
  const out: { channel: string; lines: string[] }[] = [];
  let open: string[] | null = null;
  let fenced = false;
  for (const line of soulMd.split(/\r?\n/)) {
    if (isCodeFence(line)) fenced = !fenced;
    else if (!fenced && /^#{1,2}\s/.test(line)) {
      const channel = channelOf(line);
      open = channel ? [] : null;
      if (channel && open) out.push({ channel, lines: open });
    }
    open?.push(line);
  }
  return out;
}

/**
 * The generated `## Channel` sections of a compiled soul, for the channels
 * `edited` has none for, ready to append to it: a console edit of an agent.yaml
 * persona's soul changes the prose and keeps the structure. A section the author
 * wrote is prose, so an edit can remove it. Empty when there are none.
 */
export function compiledChannelSections(compiled: string, edited: string): string {
  const present = new Set(channelSections(edited).map((s) => s.channel));
  return channelSections(compiled)
    .map((s) => ({ channel: s.channel, text: s.lines.join("\n").trimEnd() }))
    .filter((s) => !present.has(s.channel) && GENERATED_CHANNEL_SECTION_RE.test(s.text))
    .map((s) => `\n\n${s.text}`)
    .join("");
}

export interface AgentDocumentInput {
  name: string;
  description?: string | null;
  model?: string | null;
  slackUserId?: string | null;
  userToken?: string | null;
  provider?: unknown;
  runsOn?: string | null;
  soul: string;
  mandate: { global: string; scoped: SubMandate[] };
  access: Pick<SoulData, "manager" | "backupManager" | "approvers" | "channelOverrides" | "allowedChannels" | "trustedChannels" | "dmAllowedUsers" | "blockedUsers" | "redactPatterns" | "approvalTimeoutSeconds">;
  mcp?: unknown;
  skills?: string[] | null;
  guardrails?: string[] | null;
  kbSources?: string[] | null;
  background?: unknown;
  channels?: Record<string, ChannelSetting> | null;
}

const nonEmpty = <T extends object>(o: T): boolean => Object.keys(o).length > 0;

/** The mandate and access parts of a document for a parsed soul. */
export function documentPartsFromSoul(data: SoulData): Pick<AgentDocumentInput, "mandate" | "access"> {
  return { mandate: { global: data.mandate ?? "", scoped: subMandatesOf(data) }, access: data };
}

/** An agent as its agent.yaml document (empty parts left out), for export and the console. */
export function agentDocument(i: AgentDocumentInput): Record<string, unknown> {
  const approvers = [
    ...i.access.approvers.map((a) => ({ user: a.userId, scope: a.scope, catchall: a.catchall })),
    ...i.access.channelOverrides.flatMap((c) => c.approvers.map((a) => ({ user: a.userId, scope: a.scope, catchall: a.catchall, channel: c.channel }))),
  ];
  const access: Record<string, unknown> = {
    ...(i.access.manager.userId ? { manager: i.access.manager.userId } : {}),
    ...(i.access.backupManager.userId ? { backupManager: i.access.backupManager.userId } : {}),
    ...(approvers.length ? { approvers } : {}),
    ...(i.access.allowedChannels.length || i.access.trustedChannels.length
      ? { channels: { ...(i.access.allowedChannels.length ? { public: i.access.allowedChannels } : {}), ...(i.access.trustedChannels.length ? { trusted: i.access.trustedChannels } : {}) } }
      : {}),
    ...(i.access.dmAllowedUsers.length ? { dm: i.access.dmAllowedUsers } : {}),
    ...(i.access.blockedUsers.length ? { blocked: i.access.blockedUsers } : {}),
    ...(i.access.redactPatterns.length ? { redact: i.access.redactPatterns } : {}),
    ...(i.access.approvalTimeoutSeconds > 0 ? { approvalTimeoutSeconds: i.access.approvalTimeoutSeconds } : {}),
  };
  const scoped = i.mandate.scoped.map((s) => ({ boundary: s.boundary, mode: s.mode, text: s.text }));
  const mandate: Record<string, unknown> = {
    ...(i.mandate.global.trim() ? { global: i.mandate.global.trim() } : {}),
    ...(scoped.length ? { scoped } : {}),
  };
  const memory: Record<string, unknown> = {
    ...(i.kbSources != null ? { kbSources: i.kbSources } : {}),
    ...(i.background != null ? { background: i.background } : {}),
  };
  return {
    name: i.name,
    ...(i.description ? { description: i.description } : {}),
    ...(i.model ? { model: i.model } : {}),
    ...(i.slackUserId ? { slackUserId: i.slackUserId } : {}),
    ...(i.userToken ? { userToken: i.userToken } : {}),
    ...(i.provider != null ? { provider: i.provider } : {}),
    ...(i.runsOn ? { runsOn: i.runsOn } : {}),
    soul: i.soul,
    ...(nonEmpty(mandate) ? { mandate } : {}),
    ...(nonEmpty(access) ? { access } : {}),
    ...(i.mcp != null ? { mcp: i.mcp } : {}),
    ...(i.skills != null ? { skills: i.skills } : {}),
    ...(i.guardrails?.length ? { guardrails: i.guardrails } : {}),
    ...(nonEmpty(memory) ? { memory } : {}),
    ...(i.channels && nonEmpty(i.channels) ? { channels: i.channels } : {}),
  };
}
