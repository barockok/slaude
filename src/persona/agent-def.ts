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
import { GUARDRAIL_SLUG_RE } from "../guardrails/format";
import { MANDATE_LINE_MAX, subMandatesOf, type SubMandate } from "../soul/mandate-scope";
import { SoulDataSchema, type ApproverEntry, type ChannelOverride, type ScopeMandate, type SoulData } from "../soul/data";
import { SKILL_SLUG_RE } from "../skills/loader";
import { PayloadError, safeKey } from "./sync/payload";

export const AGENT_YAML = "agent.yaml";
/** The older layout's files, which cannot sit beside an agent.yaml. */
export const LEGACY_FILES = ["persona.yaml", "SOUL.md", "mcp.json"] as const;

const USER_ID_RE = /^[UW][A-Z0-9]+$/;
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]+$/;
const BOUNDARY_RE = /^(?:channel:[CGD][A-Z0-9]+|trust:(?:public|trusted)|dm)$/;
const MODES = new Set(["override", "extend", "reduce"]);
export const DESCRIPTION_MAX = 2000;

const TOP_KEYS = new Set([
  "name", "description", "model", "slackUserId", "userToken", "provider", "runsOn",
  "soul", "mandate", "access", "mcp", "skills", "guardrails", "memory",
]);
const MANDATE_KEYS = new Set(["global", "scoped"]);
const SCOPED_KEYS = new Set(["boundary", "mode", "text"]);
const ACCESS_KEYS = new Set(["manager", "backupManager", "approvers", "channels", "dm", "blocked", "redact", "approvalTimeoutSeconds"]);
const APPROVER_KEYS = new Set(["user", "scope", "catchall", "channel"]);
const CHANNELS_KEYS = new Set(["public", "trusted"]);
const MEMORY_KEYS = new Set(["kbSources", "background"]);

/** A soul section that agent.yaml keeps in its own keys (headings a SOUL.md may carry). */
const STRUCTURED_HEADING_RE =
  /^##\s+(?:mandate|reporting|manager|backup manager|secondary manager|deputy|approvers?|allowed channels|public channels|trusted channels|team channel|home channel|bu channel|blocked|blacklist|banned|ignore|dm allowlist|allowed dms|direct message allowlist|who can dm|redaction|redact|pii patterns|approval timeout|auto-deny|channel\b.*|scope\s+(?:dm|public|trusted))\s*$/i;

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
  /** `persona.<name>.<key>` paths the format has no field for (names only). */
  unknown: string[];
  warnings: string[];
}

/** Parse one agent.yaml. Throws PayloadError naming the persona and key for anything malformed. */
export function parseAgentYaml(name: string, text: string): CompiledAgent {
  const fail = (key: string, why: string): never => {
    throw new PayloadError(`persona '${name}': agent.yaml ${key} ${why}`);
  };
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (e) {
    throw new PayloadError(`persona '${name}': agent.yaml is not valid YAML (${(e as Error).message})`);
  }
  if (!isMap(raw)) fail("", "must be a mapping of the agent's fields");
  const doc = raw as Record<string, unknown>;

  const unknown: string[] = [];
  const warnings: string[] = [];
  const reportUnknown = (where: string, m: Record<string, unknown>, known: Set<string>) => {
    for (const k of Object.keys(m)) if (!known.has(k)) unknown.push(`persona.${name}.${where}${safeKey(k)}`);
  };
  reportUnknown("", doc, TOP_KEYS);

  const str = (key: string, v: unknown): string | undefined => {
    if (v == null) return undefined;
    if (typeof v !== "string") return fail(key, "must be a string");
    return v;
  };
  const id = (key: string, v: unknown, re: RegExp, what: string): string | undefined => {
    if (v == null) return undefined;
    if (typeof v !== "string" || !re.test(v)) return fail(key, `must be a ${what} (${re.source})`);
    return v;
  };
  const ids = (key: string, v: unknown, re: RegExp, what: string): string[] => {
    if (v == null) return [];
    if (!Array.isArray(v)) return fail(key, `must be a list of ${what} ids`);
    return v.map((x, i) => id(`${key}[${i}]`, x, re, `${what} id`) as string);
  };
  const slugs = (key: string, v: unknown, re: RegExp): string[] | undefined => {
    if (v == null) return undefined;
    if (!Array.isArray(v)) return fail(key, "must be a list of slugs");
    const seen = new Set<string>();
    v.forEach((x, i) => {
      if (typeof x !== "string" || !re.test(x)) fail(`${key}[${i}]`, `must be a slug (${re.source})`);
      if (seen.has(x as string)) fail(`${key}[${i}]`, "repeats an earlier entry");
      seen.add(x as string);
    });
    return v as string[];
  };
  const asMap = (key: string, v: unknown): Record<string, unknown> => {
    if (v == null) return {};
    if (!isMap(v)) return fail(key, "must be a mapping");
    return v;
  };

  if (doc.name !== name) fail("name", `must equal the directory name '${name}'`);
  const soul = doc.soul;
  if (typeof soul !== "string" || !soul.trim()) fail("soul", "must be a non-empty text block (identity and voice)");
  const soulText = soul as string;
  const description = str("description", doc.description);
  if (description !== undefined && description.length > DESCRIPTION_MAX) fail("description", `is longer than ${DESCRIPTION_MAX} characters`);
  const model = str("model", doc.model);
  const userToken = str("userToken", doc.userToken);
  const runsOn = str("runsOn", doc.runsOn);
  const slackUserId = doc.slackUserId == null ? undefined : String(doc.slackUserId);
  const provider = doc.provider == null ? undefined : (asMap("provider", doc.provider) as unknown);
  const mcp = doc.mcp == null ? undefined : (asMap("mcp", doc.mcp) as unknown);
  const skills = slugs("skills", doc.skills, SKILL_SLUG_RE);
  const guardrails = slugs("guardrails", doc.guardrails, GUARDRAIL_SLUG_RE);

  const memory = asMap("memory", doc.memory);
  reportUnknown("memory.", memory, MEMORY_KEYS);
  if (memory.kbSources != null && !Array.isArray(memory.kbSources)) fail("memory.kbSources", "must be a list of knowledge-base ids");
  if (memory.background != null && !isMap(memory.background)) fail("memory.background", "must be a mapping");

  const mandate = asMap("mandate", doc.mandate);
  reportUnknown("mandate.", mandate, MANDATE_KEYS);
  const global = str("mandate.global", mandate.global);
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
  if (mandate.scoped != null && !Array.isArray(mandate.scoped)) fail("mandate.scoped", "must be a list of sub-mandates");
  const seenBoundary = new Set<string>();
  ((mandate.scoped ?? []) as unknown[]).forEach((entry, i) => {
    const key = `mandate.scoped[${i}]`;
    if (!isMap(entry)) fail(key, "must be a mapping with boundary, mode and text");
    const e = entry as Record<string, unknown>;
    reportUnknown(`mandate.scoped.${i}.`, e, SCOPED_KEYS);
    const boundary = e.boundary;
    if (typeof boundary !== "string" || !BOUNDARY_RE.test(boundary)) fail(`${key}.boundary`, "must be channel:<id>, trust:public, trust:trusted or dm");
    if (seenBoundary.has(boundary as string)) fail(`${key}.boundary`, "repeats an earlier boundary");
    seenBoundary.add(boundary as string);
    // As a soul's `Mode:` line: absent is override, and an unknown value reads
    // as extend, so a typo keeps the global mandate instead of replacing it.
    const written = typeof e.mode === "string" ? e.mode.trim().toLowerCase() : "";
    let mode = "override";
    if (e.mode != null) {
      mode = MODES.has(written) ? written : "extend";
      if (!MODES.has(written)) warnings.push(`persona '${name}': agent.yaml ${key}.mode is not override, extend or reduce; it reads as extend`);
    }
    const text = e.text;
    if (typeof text !== "string" || !text.trim()) fail(`${key}.text`, "must be non-empty text");
    const m = mode as "override" | "extend" | "reduce";
    if (m !== "override" && (text as string).trim().length > MANDATE_LINE_MAX) {
      warnings.push(`persona '${name}': agent.yaml ${key}.text is longer than ${MANDATE_LINE_MAX} characters; a ${m} is carried whole, so keep it short`);
    }
    if ((boundary as string).startsWith("channel:")) {
      const b = channelBlock((boundary as string).slice("channel:".length));
      b.mandate = (text as string).trim();
      b.mandateMode = m;
    } else {
      const scope = boundary === "dm" ? "dm" : ((boundary as string).slice("trust:".length) as "public" | "trusted");
      scopes.push({ scope, mandate: (text as string).trim(), mode: m });
    }
  });

  const access = asMap("access", doc.access);
  reportUnknown("access.", access, ACCESS_KEYS);
  const channelLists = asMap("access.channels", access.channels);
  reportUnknown("access.channels.", channelLists, CHANNELS_KEYS);
  if (access.approvers != null && !Array.isArray(access.approvers)) fail("access.approvers", "must be a list of { user, scope, catchall }");
  const approvers: ApproverEntry[] = [];
  ((access.approvers ?? []) as unknown[]).forEach((entry, i) => {
    const key = `access.approvers[${i}]`;
    if (!isMap(entry)) fail(key, "must be a mapping with user, scope and catchall");
    const e = entry as Record<string, unknown>;
    reportUnknown(`access.approvers.${i}.`, e, APPROVER_KEYS);
    const user = id(`${key}.user`, e.user, USER_ID_RE, "Slack user id");
    if (user === undefined) fail(`${key}.user`, "is required");
    const scope = str(`${key}.scope`, e.scope);
    if (scope !== undefined && !scope.trim()) fail(`${key}.scope`, "must be non-empty text");
    if (e.catchall != null && typeof e.catchall !== "boolean") fail(`${key}.catchall`, "must be true or false");
    const entryOut: ApproverEntry = {
      userId: user as string,
      scope: scope ?? "anything",
      catchall: typeof e.catchall === "boolean" ? e.catchall : scope === undefined,
    };
    const channel = id(`${key}.channel`, e.channel, CHANNEL_ID_RE, "Slack channel id");
    if (channel) channelBlock(channel).approvers.push(entryOut);
    else approvers.push(entryOut);
  });
  if (access.approvalTimeoutSeconds != null) {
    const n = access.approvalTimeoutSeconds;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) fail("access.approvalTimeoutSeconds", "must be a non-negative whole number");
  }
  const redact = access.redact == null ? [] : access.redact;
  if (!Array.isArray(redact)) fail("access.redact", "must be a list of regular expressions");
  (redact as unknown[]).forEach((p, i) => {
    if (typeof p !== "string" || !p) fail(`access.redact[${i}]`, "must be a non-empty regular expression");
    try {
      new RegExp(p as string, "gi");
    } catch {
      fail(`access.redact[${i}]`, "is not a valid regular expression");
    }
  });
  const manager = id("access.manager", access.manager, USER_ID_RE, "Slack user id");
  const backupManager = id("access.backupManager", access.backupManager, USER_ID_RE, "Slack user id");

  const soulData = SoulDataSchema.parse({
    identity: { name, ...(description ? { role: description } : {}) },
    manager: manager ? { userId: manager } : {},
    backupManager: backupManager ? { userId: backupManager } : {},
    allowedChannels: ids("access.channels.public", channelLists.public, CHANNEL_ID_RE, "Slack channel"),
    trustedChannels: ids("access.channels.trusted", channelLists.trusted, CHANNEL_ID_RE, "Slack channel"),
    blockedUsers: ids("access.blocked", access.blocked, USER_ID_RE, "Slack user"),
    dmAllowedUsers: ids("access.dm", access.dm, USER_ID_RE, "Slack user"),
    approvers,
    redactPatterns: redact,
    approvalTimeoutSeconds: access.approvalTimeoutSeconds ?? 0,
    ...(global?.trim() ? { mandate: global.trim() } : {}),
    channelOverrides: [...channels.values()],
    scopeMandates: scopes,
  });

  for (const h of structuredHeadings(soulText)) {
    warnings.push(`persona '${name}': agent.yaml soul has a '${h}' section; mandates and access are read from their own keys, so that section is only prose`);
  }

  return {
    spec: {
      name,
      soul: soulText,
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
    unknown,
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
  };
}
